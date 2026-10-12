import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { logActivity } from '../audit/service.js';
import {
  processDocumentUpload,
  createLocalDocumentStorage,
  recoverDocumentSourceRecord,
  RECOVERY_STATUS,
  DOCUMENT_ERROR_CODES as C,
} from '../modules/ingestion/documents/index.js';

/**
 * POST /api/projects/:id/documents — multipart upload of one PDF/DOCX/TXT file
 * (field "file", optional field "title") into the authorized project.
 *
 * projectId comes from attachProject() (membership-checked) and uploadedBy from
 * requireAuth; any projectId/uploadedBy sent in the body is ignored. Auth and
 * role checks run before the multipart body is parsed, so unauthorized uploads
 * are never buffered. Listing/retrieval endpoints live in routes/ingestion.js.
 *
 * POST /api/projects/:id/documents/:documentId/reindex — member-level, idempotent
 * recovery for a 'partial' upload (Document saved, SourceRecord missing). See
 * documentRecovery.js.
 */

// Validation codes from the processing service -> HTTP status.
const VALIDATION_STATUS = {
  [C.FILE_REQUIRED]: 400,
  [C.FILE_EMPTY]: 400,
  [C.INVALID_FILENAME]: 400,
  [C.FILE_TOO_LARGE]: 413,
  [C.TEXT_TOO_LARGE]: 413,
  [C.UNSUPPORTED_EXTENSION]: 415,
  [C.UNSUPPORTED_MIME_TYPE]: 415,
  [C.MIME_TYPE_MISMATCH]: 415,
  [C.SIGNATURE_MISMATCH]: 415,
  [C.MALFORMED_DOCUMENT]: 422,
  [C.UNSUPPORTED_ENCODING]: 422,
  [C.ENCRYPTED_DOCUMENT]: 422,
  [C.LIMIT_EXCEEDED]: 422,
  [C.EXTRACTION_FAILED]: 422,
};

// Multer/busboy limit errors -> HTTP status and stable error code.
const MULTER_ERRORS = {
  LIMIT_FILE_SIZE: [413, C.FILE_TOO_LARGE, 'File exceeds the upload size limit.'],
  LIMIT_FILE_COUNT: [400, 'TOO_MANY_FILES', 'Upload exactly one file in the "file" field.'],
  LIMIT_UNEXPECTED_FILE: [400, 'UNEXPECTED_FILE_FIELD', 'Upload exactly one file in the "file" field.'],
  LIMIT_PART_COUNT: [400, 'INVALID_MULTIPART', 'Too many form parts.'],
  LIMIT_FIELD_COUNT: [400, 'INVALID_MULTIPART', 'Too many form fields.'],
  LIMIT_FIELD_KEY: [400, 'INVALID_MULTIPART', 'Form field name too long.'],
  LIMIT_FIELD_VALUE: [400, 'INVALID_MULTIPART', 'Form field value too long.'],
};

/** Maps a processing result to the HTTP response body, omitting internal storage details. */
function serializeResult(result) {
  const sr = result.sourceRecord;
  return {
    status: result.status,
    stage: result.stage,
    document: result.document,
    contentHash: result.contentHash,
    extraction: result.extraction,
    duplicateOf: result.duplicateOf,
    persisted: result.persisted,
    sourceRecord: sr
      ? { status: sr.status, createdCount: sr.createdCount, updatedCount: sr.updatedCount, failedCount: sr.failedCount }
      : null,
    errors: result.errors,
    warnings: result.warnings,
    reconciliation: result.reconciliation
      ? { required: result.reconciliation.required, action: result.reconciliation.action, documentId: result.reconciliation.documentId }
      : null,
  };
}

function failureStatus(result) {
  const first = result.errors[0];
  if ((result.stage === 'validation' || result.stage === 'extraction') && first && VALIDATION_STATUS[first.code]) {
    return VALIDATION_STATUS[first.code];
  }
  return 500;
}

/**
 * @param {Object} [deps] - Injectable for tests.
 * @param {Function} [deps.processUpload=processDocumentUpload]
 * @param {Object} [deps.storage] - Storage adapter (default: local storage per config).
 * @param {number} [deps.maxBytes=config.documents.maxBytes]
 * @param {Object} [deps.documentModel] - Overrides the Document model (tests).
 * @param {Object} [deps.sourceRecordModel] - Overrides the SourceRecord model (tests).
 */
export function createDocumentsRouter(deps = {}) {
  const maxBytes = deps.maxBytes ?? config.documents.maxBytes;
  const processUpload = deps.processUpload ?? processDocumentUpload;
  const storage = deps.storage ?? createLocalDocumentStorage(config.documents.storageDir ? { rootDir: config.documents.storageDir } : {});
  const models = {
    ...(deps.documentModel ? { documentModel: deps.documentModel } : {}),
    ...(deps.sourceRecordModel ? { sourceRecordModel: deps.sourceRecordModel } : {}),
  };

  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: maxBytes, files: 1, fields: 5, parts: 6, fieldSize: 1024, fieldNameSize: 100 },
  }).single('file');

  const parseMultipart = (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      return res.status(415).json({ error: 'unsupported_media_type', code: 'MULTIPART_REQUIRED', message: 'Use multipart/form-data with a "file" field.' });
    }
    return upload(req, res, (err) => {
      if (!err) return next();
      const mapped = err instanceof multer.MulterError ? MULTER_ERRORS[err.code] : null;
      if (mapped) {
        const [status, code, message] = mapped;
        return res.status(status).json({ error: status === 413 ? 'payload_too_large' : 'validation_error', code, message });
      }
      // Malformed multipart bodies (bad boundary, truncated stream, ...).
      return res.status(400).json({ error: 'validation_error', code: 'INVALID_MULTIPART', message: 'Malformed multipart/form-data body.' });
    });
  };

  const router = Router();

  router.post('/:id/documents', requireAuth, attachProject(), requireRole('member'), parseMultipart, async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'validation_error', code: C.FILE_REQUIRED, message: 'A file is required in the "file" field.' });
      }
      const title = typeof req.body?.title === 'string' ? req.body.title : undefined;

      const result = await processUpload({
        projectId: req.project._id,
        uploadedBy: req.user._id,
        file: { buffer: req.file.buffer, filename: req.file.originalname, mimeType: req.file.mimetype },
        title,
        storage,
        limits: { maxBytes },
        ...models,
      });
      const body = serializeResult(result);

      switch (result.status) {
        case 'succeeded':
          await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'DOCUMENT_UPLOADED' });
          return res.status(201).json(body);
        case 'duplicate':
          return res.status(200).json(body);
        case 'partial':
          // Document saved but its SourceRecord was not: not a full success.
          return res.status(207).json(body);
        default: {
          const status = failureStatus(result);
          const first = result.errors[0];
          return res.status(status).json({
            error: status >= 500 ? 'document_processing_failed' : 'validation_error',
            code: first?.code ?? 'DOCUMENT_PROCESSING_FAILED',
            message: first?.message ?? 'Document processing failed.',
            ...body,
          });
        }
      }
    } catch (err) {
      next(err);
    }
  });

  const RECOVERY_HTTP = { [RECOVERY_STATUS.RECOVERED]: 200, [RECOVERY_STATUS.ALREADY_INDEXED]: 200, [RECOVERY_STATUS.NOT_FOUND]: 404 };
  const RECOVERY_FAILURE_HTTP = { [C.ORIGINAL_UNAVAILABLE]: 409, [C.EXTRACTION_FAILED]: 422, [C.MALFORMED_DOCUMENT]: 422 };

  router.post('/:id/documents/:documentId/reindex', requireAuth, attachProject(), requireRole('member'), async (req, res, next) => {
    try {
      if (!/^[a-f0-9]{24}$/i.test(req.params.documentId)) {
        return res.status(400).json({ error: 'validation_error', message: 'Invalid documentId' });
      }
      const result = await recoverDocumentSourceRecord({
        projectId: req.project._id,
        documentId: req.params.documentId,
        storage,
        ...models,
      });
      if (result.status === RECOVERY_STATUS.NOT_FOUND) {
        return res.status(404).json({ error: 'not_found', message: 'Document not found' });
      }
      if (result.status === RECOVERY_STATUS.FAILED) {
        const status = RECOVERY_FAILURE_HTTP[result.errors[0]?.code] ?? 500;
        return res.status(status).json({ error: 'document_recovery_failed', code: result.errors[0]?.code, message: result.errors[0]?.message ?? 'Document recovery failed.', ...result });
      }
      if (result.status === RECOVERY_STATUS.RECOVERED) await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'DOCUMENT_REINDEXED' });
      return res.status(RECOVERY_HTTP[result.status]).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createDocumentsRouter();
