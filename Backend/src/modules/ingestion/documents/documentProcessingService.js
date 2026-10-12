/**
 * @file documentProcessingService.js
 * @description Internal document pipeline:
 *   validate -> hash -> extract -> duplicate check -> store file -> persist Document
 *   -> normalize -> persist SourceRecord.
 *
 * AUTHORIZATION: this service does not authorize anything. `projectId` and
 * `uploadedBy` must come from an authenticated, authorized context (e.g. a route
 * using requireAuth + attachProject() + requireRole('member'), passing
 * req.project._id and req.user._id). No HTTP route is wired in Part 6.
 *
 * Failure guarantees:
 * - validation / extraction / duplicate-check failure: nothing stored, nothing persisted.
 * - storage failure: no Document, no SourceRecord; adapter removes its temp file.
 * - Document persistence failure: the newly stored file is deleted; if that deletion
 *   fails, the result reports CLEANUP_FAILED and the orphaned storage key.
 * - SourceRecord persistence failure: the Document and file are kept (status 'partial')
 *   and `reconciliation` says how to retry (persistDocumentSourceRecord).
 * Only files stored by this invocation are ever deleted.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import mongoose from 'mongoose';
import { Document } from '../../../models/Document.js';
import { SourceRecord } from '../../../models/SourceRecord.js';
import { persistSourceRecordCandidates } from '../persistence/sourceRecordStore.js';
import { SOURCE_PROVIDERS } from '../contracts/sourceRecord.js';
import { DOCUMENT_ERROR_CODES, DocumentProcessingError, toSafeDocumentError } from './documentErrors.js';
import { validateDocumentUpload, DEFAULT_MAX_FILE_BYTES } from './documentValidation.js';
import { extractDocumentText } from './documentExtraction.js';
import { normalizeDocumentCandidate } from './documentNormalizer.js';

export const MAX_TITLE_LENGTH = 300;

/** @readonly @enum {string} */
export const DUPLICATE_POLICIES = Object.freeze({
  /** Identical bytes already ingested for this project: return the existing document, store nothing. */
  REUSE: 'reuse',
  /** Always create a new Document instance, even for identical bytes. */
  ALLOW: 'allow',
});

const OBJECT_ID = /^[a-f0-9]{24}$/i;

function toObjectId(value, field) {
  const raw = value instanceof mongoose.Types.ObjectId ? value.toHexString() : value;
  if (typeof raw !== 'string' || !OBJECT_ID.test(raw)) {
    throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.INVALID_INPUT, `A valid ${field} (ObjectId) is required.`, { field });
  }
  return new mongoose.Types.ObjectId(raw);
}

/** SHA-256 hex digest of the original file bytes. */
export function computeContentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function resolveTitle(title, originalFilename) {
  const explicit = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  const fallback = path.basename(originalFilename, path.extname(originalFilename)).trim() || originalFilename;
  return (explicit || fallback).slice(0, MAX_TITLE_LENGTH);
}

/**
 * Normalizes a persisted Document and upserts its SourceRecord. Used by the
 * pipeline and for reconciliation after a 'partial' result.
 *
 * @param {Object} params
 * @param {Object} params.document - Persisted Document.
 * @param {Object} params.extraction - extractDocumentText result.
 * @param {string} params.contentHash
 * @param {{ bulkWrite: Function }} [params.sourceRecordModel=SourceRecord]
 * @param {() => Date} [params.now]
 * @returns {Promise<Object>} persistSourceRecordCandidates result.
 */
export async function persistDocumentSourceRecord({ document, extraction, contentHash, sourceRecordModel = SourceRecord, now = () => new Date() }) {
  const candidate = normalizeDocumentCandidate({ document, extraction, contentHash, fetchedAt: now() });
  return persistSourceRecordCandidates({
    projectId: candidate.projectId,
    records: [candidate],
    model: sourceRecordModel,
    now,
  });
}

/**
 * Looks for a SourceRecord of an earlier upload with identical bytes in the same project.
 */
async function findIdenticalUpload(sourceRecordModel, projectObjectId, contentHash) {
  const query = sourceRecordModel.findOne(
    { projectId: projectObjectId, provider: SOURCE_PROVIDERS.DOCUMENT, 'metadata.providerMetadata.contentHash': contentHash },
    { _id: 1, externalId: 1, title: 1 },
  );
  return typeof query?.lean === 'function' ? query.lean() : query;
}

/**
 * Processes one uploaded document for a project.
 *
 * Throws only for programmer errors (invalid projectId/uploadedBy/storage).
 * Every processing outcome is returned as a structured result.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.projectId - Authorized Relay project.
 * @param {string|mongoose.Types.ObjectId} params.uploadedBy - Authenticated user.
 * @param {{ buffer: Buffer, filename: string, mimeType: string }} params.file
 * @param {string} [params.title]
 * @param {{ put: Function, delete: Function, name?: string }} params.storage - See documentStorage.js.
 * @param {'reuse'|'allow'} [params.duplicatePolicy='reuse']
 * @param {{ maxBytes?: number, maxTextLength?: number, maxPages?: number }} [params.limits]
 * @param {Object} [params.documentModel=Document]
 * @param {Object} [params.sourceRecordModel=SourceRecord]
 * @param {() => Date} [params.now]
 */
export async function processDocumentUpload({
  projectId,
  uploadedBy,
  file,
  title,
  storage,
  duplicatePolicy = DUPLICATE_POLICIES.REUSE,
  limits = {},
  documentModel = Document,
  sourceRecordModel = SourceRecord,
  now = () => new Date(),
} = {}) {
  const projectObjectId = toObjectId(projectId, 'projectId');
  const uploaderObjectId = toObjectId(uploadedBy, 'uploadedBy');
  if (!storage || typeof storage.put !== 'function' || typeof storage.delete !== 'function') {
    throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.INVALID_INPUT, 'A storage adapter with put() and delete() is required.');
  }
  if (!Object.values(DUPLICATE_POLICIES).includes(duplicatePolicy)) {
    throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.INVALID_INPUT, 'Unknown duplicatePolicy.');
  }

  const startedAt = now();
  const result = {
    status: 'failed',
    stage: 'validation',
    projectId: projectObjectId.toHexString(),
    document: null,
    contentHash: null,
    extraction: null,
    duplicateOf: null,
    sourceRecord: null,
    persisted: { file: false, document: false, sourceRecord: false },
    errors: [],
    warnings: [],
    reconciliation: null,
    startedAt: startedAt.toISOString(),
    completedAt: null,
  };
  const finish = (status) => {
    result.status = status;
    result.completedAt = now().toISOString();
    return result;
  };
  const addError = (stage, err, fallbackCode, fallbackMessage) => {
    result.errors.push({ stage, ...toSafeDocumentError(err, fallbackCode, fallbackMessage) });
  };

  // 1. Validation (no side effects)
  const validation = validateDocumentUpload(file, { maxBytes: limits.maxBytes ?? DEFAULT_MAX_FILE_BYTES });
  if (!validation.valid) {
    for (const e of validation.errors) result.errors.push({ stage: 'validation', ...e });
    return finish('failed');
  }
  const validated = validation.document;

  // 2. Content hash of the original bytes
  result.stage = 'hash';
  result.contentHash = computeContentHash(file.buffer);

  // 3. Extraction (in memory)
  result.stage = 'extraction';
  let extraction;
  try {
    extraction = await extractDocumentText({ buffer: file.buffer, validated, limits });
  } catch (err) {
    addError('extraction', err, DOCUMENT_ERROR_CODES.EXTRACTION_FAILED, 'Text extraction failed.');
    return finish('failed');
  }
  result.extraction = { detectedFormat: extraction.detectedFormat, status: extraction.status, ...extraction.metadata };
  if (extraction.status === 'empty') {
    result.warnings.push({
      stage: 'extraction',
      code: DOCUMENT_ERROR_CODES.NO_EXTRACTABLE_TEXT,
      message: 'The document is valid but contains no extractable text (OCR is not supported).',
    });
  }

  // 4. Identical-content check (same project, same bytes)
  if (duplicatePolicy === DUPLICATE_POLICIES.REUSE) {
    result.stage = 'duplicate_check';
    let existing;
    try {
      existing = await findIdenticalUpload(sourceRecordModel, projectObjectId, result.contentHash);
    } catch (err) {
      addError('duplicate_check', err, DOCUMENT_ERROR_CODES.DUPLICATE_LOOKUP_FAILED, 'Could not check for an identical earlier upload.');
      return finish('failed');
    }
    if (existing) {
      result.duplicateOf = {
        documentId: existing.externalId,
        sourceRecordId: String(existing._id),
        title: existing.title,
      };
      return finish('duplicate');
    }
  }

  // 5. Store original bytes
  result.stage = 'storage';
  let stored;
  try {
    stored = await storage.put({ buffer: file.buffer, extension: validated.extension });
  } catch (err) {
    addError('storage', err, DOCUMENT_ERROR_CODES.STORAGE_FAILED, 'The file could not be stored.');
    return finish('failed');
  }
  result.persisted.file = true;
  for (const w of stored.warnings || []) result.warnings.push({ stage: 'storage', ...w });

  // 6. Persist Document
  result.stage = 'document';
  let document;
  try {
    document = await documentModel.create({
      projectId: projectObjectId,
      title: resolveTitle(title, validated.originalFilename),
      filename: validated.originalFilename,
      mimeType: validated.mimeType,
      size: validated.size,
      url: stored.storageRef.url || '',
      storageRef: stored.storageRef,
      extractedText: extraction.extractedText,
      uploadedBy: uploaderObjectId,
    });
  } catch {
    addError('document', null, DOCUMENT_ERROR_CODES.DOCUMENT_PERSISTENCE_FAILED, 'The document record could not be saved.');
    try {
      await storage.delete(stored.key);
      result.persisted.file = false;
    } catch (cleanupErr) {
      addError('cleanup', cleanupErr, DOCUMENT_ERROR_CODES.CLEANUP_FAILED, 'The stored file could not be removed after the failure.');
      result.reconciliation = { required: true, action: 'delete_orphaned_file', storageKey: stored.key };
    }
    return finish('failed');
  }
  result.persisted.document = true;
  result.document = {
    id: String(document._id),
    title: document.title,
    filename: document.filename,
    mimeType: document.mimeType,
    size: document.size,
    storageProvider: document.storageRef?.provider ?? stored.storageRef.provider,
    createdAt: document.createdAt instanceof Date ? document.createdAt.toISOString() : null,
  };

  // 7. Normalize and persist the SourceRecord
  result.stage = 'source_record';
  let persistence = null;
  try {
    persistence = await persistDocumentSourceRecord({
      document, extraction, contentHash: result.contentHash, sourceRecordModel, now,
    });
  } catch (err) {
    addError('source_record', err, DOCUMENT_ERROR_CODES.SOURCE_RECORD_PERSISTENCE_FAILED, 'The source record could not be saved.');
  }
  result.sourceRecord = persistence;

  const sourceSaved = Boolean(persistence) && persistence.failedCount === 0 && persistence.createdCount + persistence.updatedCount === 1;
  if (!sourceSaved) {
    if (persistence) {
      for (const e of persistence.errors) {
        result.errors.push({ stage: 'source_record', code: DOCUMENT_ERROR_CODES.SOURCE_RECORD_PERSISTENCE_FAILED, message: `${e.code}: ${e.message}` });
      }
    }
    result.reconciliation = {
      required: true,
      action: 'retry_source_record',
      documentId: result.document.id,
      contentHash: result.contentHash,
    };
    return finish('partial');
  }

  result.persisted.sourceRecord = true;
  return finish('succeeded');
}
