/**
 * @file documentNormalizer.js
 * @description Normalizes a persisted Document (src/models/Document.js) plus its
 * extraction result into a SourceRecordCandidate (contracts/sourceRecord.js).
 *
 * Identity: `externalId` is the Document's `_id`, so the SourceRecord always
 * refers to one persisted upload instance. Re-normalizing the same Document
 * upserts the same SourceRecord; a new upload (even of the same filename) gets a
 * new Document `_id` and therefore a distinct SourceRecord.
 */

import {
  SOURCE_PROVIDERS,
  SOURCE_RECORD_TYPES,
  SOURCE_CONTENT_TYPES,
  validateSourceRecordCandidate,
} from '../contracts/sourceRecord.js';
import { DOCUMENT_ERROR_CODES, DocumentProcessingError } from './documentErrors.js';

export const CONTENT_HASH_ALGORITHM = 'sha256';

const idString = (value) => (value && typeof value.toHexString === 'function' ? value.toHexString() : String(value ?? ''));

/**
 * @param {Object} params
 * @param {Object} params.document - Persisted Document (must have _id, projectId, title, createdAt).
 * @param {{ extractedText: string, detectedFormat: string, status: string, metadata: Object }} params.extraction
 * @param {string} params.contentHash - SHA-256 hex of the original file bytes.
 * @param {Date} [params.fetchedAt] - Processing time.
 * @returns {import('../contracts/sourceRecord.js').SourceRecordCandidate}
 */
export function normalizeDocumentCandidate({ document, extraction, contentHash, fetchedAt = new Date() } = {}) {
  if (!document || !document._id || !document.projectId) {
    throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.INVALID_INPUT, 'A persisted Document is required for normalization.');
  }
  if (!extraction || typeof extraction.extractedText !== 'string') {
    throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.INVALID_INPUT, 'An extraction result is required for normalization.');
  }
  if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.INVALID_INPUT, 'A SHA-256 content hash is required for normalization.');
  }

  const documentId = idString(document._id);
  const uploadedBy = document.uploadedBy ? idString(document.uploadedBy) : undefined;
  const storageRef = document.storageRef || {};

  const candidate = {
    projectId: idString(document.projectId),
    provider: SOURCE_PROVIDERS.DOCUMENT,
    recordType: SOURCE_RECORD_TYPES.DOCUMENT,
    externalId: documentId,
    title: document.title,
    content: extraction.extractedText,
    contentType: SOURCE_CONTENT_TYPES.PLAIN,
    url: typeof document.url === 'string' && /^https?:\/\//i.test(document.url) ? document.url : undefined,
    authorId: uploadedBy,
    createdAt: document.createdAt instanceof Date ? document.createdAt : undefined,
    updatedAt: document.updatedAt instanceof Date ? document.updatedAt : undefined,
    fetchedAt,
    version: 1,
    isActive: true,
    isDeleted: false,
    extractionStatus: extraction.status,
    metadata: {
      documentId,
      filename: document.filename || '',
      mimeType: document.mimeType || '',
      size: typeof document.size === 'number' ? document.size : 0,
      contentHash,
      contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
      detectedFormat: extraction.detectedFormat,
      characterCount: extraction.metadata?.characterCount ?? extraction.extractedText.length,
      pageCount: extraction.metadata?.pageCount,
      encoding: extraction.metadata?.encoding,
      storageProvider: storageRef.provider || 'none',
      uploadedBy,
    },
  };

  const validation = validateSourceRecordCandidate(candidate);
  if (!validation.valid) {
    throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.INVALID_INPUT, `Document candidate is invalid: ${validation.errors.join('; ')}`);
  }
  return candidate;
}
