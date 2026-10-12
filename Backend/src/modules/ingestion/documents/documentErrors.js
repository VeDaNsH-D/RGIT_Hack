/**
 * @file documentErrors.js
 * @description Error codes and error type for document validation, extraction,
 * storage, and processing. Messages are safe for API responses: they never
 * contain file contents, stack traces, or filesystem paths.
 */

/** @readonly @enum {string} */
export const DOCUMENT_ERROR_CODES = Object.freeze({
  // Validation
  FILE_REQUIRED: 'FILE_REQUIRED',
  FILE_EMPTY: 'FILE_EMPTY',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  INVALID_FILENAME: 'INVALID_FILENAME',
  UNSUPPORTED_EXTENSION: 'UNSUPPORTED_EXTENSION',
  UNSUPPORTED_MIME_TYPE: 'UNSUPPORTED_MIME_TYPE',
  MIME_TYPE_MISMATCH: 'MIME_TYPE_MISMATCH',
  SIGNATURE_MISMATCH: 'SIGNATURE_MISMATCH',
  MALFORMED_DOCUMENT: 'MALFORMED_DOCUMENT',
  UNSUPPORTED_ENCODING: 'UNSUPPORTED_ENCODING',
  ENCRYPTED_DOCUMENT: 'ENCRYPTED_DOCUMENT',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  // Extraction
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  TEXT_TOO_LARGE: 'TEXT_TOO_LARGE',
  NO_EXTRACTABLE_TEXT: 'NO_EXTRACTABLE_TEXT',
  // Processing
  INVALID_INPUT: 'INVALID_INPUT',
  DUPLICATE_LOOKUP_FAILED: 'DUPLICATE_LOOKUP_FAILED',
  STORAGE_FAILED: 'STORAGE_FAILED',
  DOCUMENT_PERSISTENCE_FAILED: 'DOCUMENT_PERSISTENCE_FAILED',
  SOURCE_RECORD_PERSISTENCE_FAILED: 'SOURCE_RECORD_PERSISTENCE_FAILED',
  CLEANUP_FAILED: 'CLEANUP_FAILED',
});

export class DocumentProcessingError extends Error {
  /**
   * @param {string} code - One of DOCUMENT_ERROR_CODES.
   * @param {string} message - Safe, user-facing description.
   * @param {Object} [details]
   * @param {string} [details.field] - Input field the error relates to.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DocumentProcessingError';
    this.code = code;
    this.field = details.field || null;
  }

  /** @returns {{ code: string, message: string, field?: string }} */
  toJSON() {
    return this.field ? { code: this.code, message: this.message, field: this.field } : { code: this.code, message: this.message };
  }
}

/**
 * Converts any error into a safe `{ code, message }` summary. Unknown errors get
 * a generic message so library internals and paths are never surfaced.
 *
 * @param {unknown} err
 * @param {string} fallbackCode
 * @param {string} fallbackMessage
 */
export function toSafeDocumentError(err, fallbackCode, fallbackMessage) {
  if (err instanceof DocumentProcessingError) return { code: err.code, message: err.message };
  return { code: fallbackCode, message: fallbackMessage };
}
