/**
 * @file documentValidation.js
 * @description Validation for uploaded documents (PDF, DOCX, TXT).
 *
 * A file is accepted only when all three agree: an allowlisted extension, an
 * allowlisted MIME type for that same format, and file content that matches the
 * format (signature / container structure / text encoding). Neither the filename
 * nor the client-supplied MIME type is trusted on its own.
 *
 * Validation has no side effects: nothing is written to disk or the database.
 */

import path from 'node:path';
import { DOCUMENT_ERROR_CODES, DocumentProcessingError } from './documentErrors.js';
import { hasZipSignature, inspectZip, DEFAULT_ZIP_LIMITS } from './zipInspector.js';

export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILENAME_LENGTH = 255;

/** @readonly @enum {string} */
export const DOCUMENT_FORMATS = Object.freeze({
  PDF: 'pdf',
  DOCX: 'docx',
  TXT: 'txt',
});

/**
 * Allowlist: extension -> format, canonical MIME type, accepted client MIME types.
 * @readonly
 */
export const FORMAT_RULES = Object.freeze({
  [DOCUMENT_FORMATS.PDF]: {
    extensions: ['.pdf'],
    mimeType: 'application/pdf',
    acceptedMimeTypes: ['application/pdf', 'application/x-pdf'],
  },
  [DOCUMENT_FORMATS.DOCX]: {
    extensions: ['.docx'],
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    acceptedMimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  [DOCUMENT_FORMATS.TXT]: {
    extensions: ['.txt'],
    mimeType: 'text/plain',
    acceptedMimeTypes: ['text/plain'],
  },
});

const DOCX_MAIN_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

const fail = (code, message, field) => new DocumentProcessingError(code, message, { field });

/**
 * Produces a display-safe original filename (metadata only; never used as a path).
 * Rejects names containing path separators or traversal segments rather than
 * silently stripping them.
 *
 * @param {unknown} filename
 * @returns {string}
 * @throws {DocumentProcessingError} INVALID_FILENAME
 */
export function sanitizeFilename(filename) {
  if (typeof filename !== 'string') throw fail(DOCUMENT_ERROR_CODES.INVALID_FILENAME, 'A filename is required.', 'filename');

  // eslint-disable-next-line no-control-regex
  const cleaned = filename.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) throw fail(DOCUMENT_ERROR_CODES.INVALID_FILENAME, 'A filename is required.', 'filename');
  if (/[\\/]/.test(cleaned) || cleaned === '.' || cleaned === '..' || cleaned.startsWith('..')) {
    throw fail(DOCUMENT_ERROR_CODES.INVALID_FILENAME, 'Filename must not contain path separators or traversal segments.', 'filename');
  }
  if (cleaned.length > MAX_FILENAME_LENGTH) {
    throw fail(DOCUMENT_ERROR_CODES.INVALID_FILENAME, `Filename exceeds ${MAX_FILENAME_LENGTH} characters.`, 'filename');
  }
  return cleaned;
}

/**
 * Strips MIME parameters (e.g. "; charset=utf-8") and lowercases.
 * @param {unknown} mimeType
 */
function baseMimeType(mimeType) {
  return typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
}

/** Finds `%PDF-` within the first 1024 bytes (the tolerance used by common readers). */
function hasPdfSignature(buffer) {
  return buffer.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1') !== -1;
}

/**
 * Verifies the DOCX package structure: [Content_Types].xml declares a
 * WordprocessingML main document part (not macro-enabled or template) and that
 * part exists. Arbitrary ZIP archives are rejected.
 *
 * @param {Buffer} buffer
 * @param {Object} [zipLimits]
 * @returns {{ mainPart: string, entryCount: number, totalUncompressedBytes: number }}
 */
export function verifyDocxStructure(buffer, zipLimits = DEFAULT_ZIP_LIMITS) {
  const zip = inspectZip(buffer, zipLimits);

  if (!zip.entries.has('[Content_Types].xml')) {
    throw fail(DOCUMENT_ERROR_CODES.SIGNATURE_MISMATCH, 'File is a ZIP archive but not a Word document.');
  }
  const contentTypes = zip.readEntry('[Content_Types].xml').toString('utf8');

  let mainPart = null;
  for (const match of contentTypes.matchAll(/<Override\b[^>]*>/g)) {
    const tag = match[0];
    const ct = /ContentType\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const partName = /PartName\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (ct === DOCX_MAIN_CONTENT_TYPE && partName) {
      mainPart = partName.replace(/^\//, '');
      break;
    }
  }

  if (!mainPart) {
    throw fail(DOCUMENT_ERROR_CODES.SIGNATURE_MISMATCH, 'File is not a standard .docx document (macro-enabled, template, or non-Word packages are not accepted).');
  }
  if (!zip.entries.has(mainPart)) throw fail(DOCUMENT_ERROR_CODES.MALFORMED_DOCUMENT, 'Word document is missing its main document part.');
  if ([...zip.entries.keys()].some((name) => /vbaProject\.bin$/i.test(name))) {
    throw fail(DOCUMENT_ERROR_CODES.SIGNATURE_MISMATCH, 'Documents containing macros are not accepted.');
  }

  return { mainPart, entryCount: zip.entries.size, totalUncompressedBytes: zip.totalUncompressedBytes };
}

/**
 * Detects the text encoding of a TXT upload and decodes it strictly.
 * Supported: UTF-8 (with or without BOM), UTF-16LE/BE with BOM. Anything else,
 * or binary-looking content, is rejected rather than guessed.
 *
 * @param {Buffer} buffer
 * @returns {{ text: string, encoding: string }}
 */
export function decodeText(buffer) {
  let encoding = 'utf-8';
  let body = buffer;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    body = buffer.subarray(3);
  } else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = 'utf-16le';
    body = buffer.subarray(2);
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = 'utf-16be';
    body = buffer.subarray(2);
  }

  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(body);
  } catch {
    throw fail(DOCUMENT_ERROR_CODES.UNSUPPORTED_ENCODING, 'Text file must be valid UTF-8 or UTF-16 with a byte-order mark.');
  }

  // eslint-disable-next-line no-control-regex
  const controls = (text.match(/[\u0000-\u0008\u000e-\u001f\u007f]/g) || []).length;
  if (text.includes('\u0000') || controls > Math.max(8, text.length * 0.01)) {
    throw fail(DOCUMENT_ERROR_CODES.SIGNATURE_MISMATCH, 'File content looks binary, not plain text.');
  }

  return { text, encoding };
}

/**
 * @typedef {Object} ValidatedDocument
 * @property {'pdf'|'docx'|'txt'} format
 * @property {string} extension - Lowercase, from the allowlist (e.g. ".pdf").
 * @property {string} mimeType - Canonical MIME type for the detected format.
 * @property {string} originalFilename - Sanitized display name (metadata only).
 * @property {number} size - Bytes.
 * @property {Object} details - Format-specific facts (e.g. DOCX main part, TXT encoding).
 */

/**
 * Validates an uploaded document.
 *
 * @param {Object} file
 * @param {Buffer} file.buffer
 * @param {string} file.filename - Client-supplied original filename.
 * @param {string} file.mimeType - Client-supplied MIME type.
 * @param {Object} [options]
 * @param {number} [options.maxBytes=10 MiB]
 * @param {Object} [options.zipLimits]
 * @returns {{ valid: true, document: ValidatedDocument, errors: [] } | { valid: false, document: null, errors: Array<{ code: string, message: string, field?: string }> }}
 */
export function validateDocumentUpload(file, options = {}) {
  try {
    return { valid: true, document: assertValidDocument(file, options), errors: [] };
  } catch (err) {
    if (err instanceof DocumentProcessingError) return { valid: false, document: null, errors: [err.toJSON()] };
    return {
      valid: false,
      document: null,
      errors: [{ code: DOCUMENT_ERROR_CODES.MALFORMED_DOCUMENT, message: 'File could not be validated.' }],
    };
  }
}

/**
 * Throwing variant of validateDocumentUpload.
 * @returns {ValidatedDocument}
 */
export function assertValidDocument(file, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw fail(DOCUMENT_ERROR_CODES.INVALID_INPUT, 'maxBytes must be a positive integer.');
  }

  if (!file || typeof file !== 'object' || file.buffer === undefined || file.buffer === null) {
    throw fail(DOCUMENT_ERROR_CODES.FILE_REQUIRED, 'A file is required.', 'file');
  }
  const { buffer } = file;
  if (!Buffer.isBuffer(buffer)) throw fail(DOCUMENT_ERROR_CODES.FILE_REQUIRED, 'File content must be provided as a Buffer.', 'file');
  if (buffer.length === 0) throw fail(DOCUMENT_ERROR_CODES.FILE_EMPTY, 'File is empty.', 'file');
  if (buffer.length > maxBytes) throw fail(DOCUMENT_ERROR_CODES.FILE_TOO_LARGE, `File exceeds the ${maxBytes}-byte limit.`, 'file');

  const originalFilename = sanitizeFilename(file.filename);
  const extension = path.extname(originalFilename).toLowerCase();
  const format = Object.keys(FORMAT_RULES).find((f) => FORMAT_RULES[f].extensions.includes(extension));
  if (!format) {
    throw fail(DOCUMENT_ERROR_CODES.UNSUPPORTED_EXTENSION, 'Only .pdf, .docx and .txt files are supported.', 'filename');
  }

  const clientMime = baseMimeType(file.mimeType);
  const allMimes = Object.values(FORMAT_RULES).flatMap((r) => r.acceptedMimeTypes);
  if (!allMimes.includes(clientMime)) {
    throw fail(DOCUMENT_ERROR_CODES.UNSUPPORTED_MIME_TYPE, 'File MIME type is not supported.', 'mimeType');
  }
  if (!FORMAT_RULES[format].acceptedMimeTypes.includes(clientMime)) {
    throw fail(DOCUMENT_ERROR_CODES.MIME_TYPE_MISMATCH, 'File MIME type does not match its extension.', 'mimeType');
  }

  let details = {};
  if (format === DOCUMENT_FORMATS.PDF) {
    if (!hasPdfSignature(buffer)) throw fail(DOCUMENT_ERROR_CODES.SIGNATURE_MISMATCH, 'File content is not a PDF.');
  } else if (format === DOCUMENT_FORMATS.DOCX) {
    if (!hasZipSignature(buffer)) throw fail(DOCUMENT_ERROR_CODES.SIGNATURE_MISMATCH, 'File content is not a .docx document.');
    details = verifyDocxStructure(buffer, options.zipLimits);
  } else {
    if (hasPdfSignature(buffer.subarray(0, 8)) || hasZipSignature(buffer)) {
      throw fail(DOCUMENT_ERROR_CODES.SIGNATURE_MISMATCH, 'File content is not plain text.');
    }
    details = { encoding: decodeText(buffer).encoding };
  }

  return {
    format,
    extension,
    mimeType: FORMAT_RULES[format].mimeType,
    originalFilename,
    size: buffer.length,
    details,
  };
}
