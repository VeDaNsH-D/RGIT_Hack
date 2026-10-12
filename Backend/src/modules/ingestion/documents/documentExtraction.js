/**
 * @file documentExtraction.js
 * @description Text extraction for PDF, DOCX and TXT documents.
 *
 * Independent of MongoDB, storage, GitHub and AI modules. Works entirely in
 * memory; no temporary files are created. No OCR: scanned PDFs yield an
 * `empty` result rather than an error.
 *
 * Outcome semantics:
 * - status 'extracted': text was found.
 * - status 'empty': the document parsed correctly but contains no extractable text.
 * - throws DocumentProcessingError: the document could not be parsed
 *   (MALFORMED_DOCUMENT / ENCRYPTED_DOCUMENT / EXTRACTION_FAILED) or exceeded limits
 *   (TEXT_TOO_LARGE / LIMIT_EXCEEDED). Callers must treat a throw as "rejected".
 */

import { DOCUMENT_ERROR_CODES, DocumentProcessingError } from './documentErrors.js';
import { DOCUMENT_FORMATS, assertValidDocument, decodeText } from './documentValidation.js';

/**
 * Equal to the SourceRecord persistence content limit (MAX_CONTENT_LENGTH in
 * persistence/sourceRecordStore.js; a test enforces this). Defined here so the
 * extractor does not import the persistence layer or Mongoose.
 */
export const DEFAULT_MAX_TEXT_LENGTH = 1_000_000;
export const DEFAULT_MAX_PDF_PAGES = 1000;

/**
 * Normalizes line endings and whitespace while keeping paragraph boundaries:
 * CRLF/CR -> LF, trailing spaces trimmed per line, 3+ blank lines collapsed to one
 * blank line, NUL and other non-printing control characters removed.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeExtractedText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '')
    .replace(/\f/g, '\n\n')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tooLarge(maxTextLength) {
  return new DocumentProcessingError(
    DOCUMENT_ERROR_CODES.TEXT_TOO_LARGE,
    `Extracted text exceeds the ${maxTextLength}-character limit.`,
  );
}

let pdfjsPromise = null;
async function loadPdfjs() {
  // Legacy build is the Node-compatible distribution of PDF.js.
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * @param {Buffer} buffer
 * @param {{ maxTextLength: number, maxPages: number }} limits
 */
export async function extractPdfText(buffer, { maxTextLength, maxPages }) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false, // never compile font programs with eval (CVE-2024-4367 class)
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });

  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      if (err?.name === 'PasswordException') {
        throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.ENCRYPTED_DOCUMENT, 'Password-protected PDFs are not supported.');
      }
      throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.MALFORMED_DOCUMENT, 'PDF could not be parsed.');
    }

    if (doc.numPages > maxPages) {
      throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.LIMIT_EXCEEDED, `PDF has more than ${maxPages} pages.`);
    }

    const pages = [];
    let length = 0;
    for (let i = 1; i <= doc.numPages; i += 1) {
      let content;
      try {
        const page = await doc.getPage(i);
        content = await page.getTextContent();
        page.cleanup();
      } catch {
        throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.MALFORMED_DOCUMENT, `PDF page ${i} could not be parsed.`);
      }
      const pageText = content.items
        .map((item) => (typeof item.str === 'string' ? item.str : '') + (item.hasEOL ? '\n' : ''))
        .join('');
      length += pageText.length;
      if (length > maxTextLength * 2) throw tooLarge(maxTextLength); // early stop before normalization
      pages.push(pageText);
    }

    return { text: pages.join('\n\n'), pages, metadata: { pageCount: doc.numPages } };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/**
 * @param {Buffer} buffer - Must already have passed DOCX structure validation, which
 *   bounds every archive entry's real size before mammoth decompresses it.
 */
export async function extractDocxText(buffer) {
  const { default: mammoth } = await import('mammoth');
  let result;
  try {
    result = await mammoth.extractRawText({ buffer });
  } catch {
    throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.MALFORMED_DOCUMENT, 'Word document could not be parsed.');
  }
  const warnings = Array.isArray(result.messages) ? result.messages.filter((m) => m.type === 'warning').length : 0;
  return { text: typeof result.value === 'string' ? result.value : '', metadata: { parserWarnings: warnings } };
}

/** @param {Buffer} buffer */
export function extractTxtText(buffer) {
  const { text, encoding } = decodeText(buffer);
  return { text, metadata: { encoding } };
}

/**
 * Extracts text from a PDF, DOCX or TXT document.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer
 * @param {string} params.filename
 * @param {string} params.mimeType
 * @param {import('./documentValidation.js').ValidatedDocument} [params.validated] - Result of
 *   assertValidDocument for this same buffer, to avoid validating twice.
 * @param {Object} [params.limits]
 * @param {number} [params.limits.maxTextLength]
 * @param {number} [params.limits.maxPages]
 * @param {number} [params.limits.maxBytes]
 * @returns {Promise<{ extractedText: string, segments: Array<{ page?: number, text: string }>, detectedFormat: 'pdf'|'docx'|'txt', status: 'extracted'|'empty',
 *   metadata: { characterCount: number, pageCount?: number, encoding?: string, parserWarnings?: number } }>}
 * @throws {DocumentProcessingError}
 */
export async function extractDocumentText({ buffer, filename, mimeType, validated, limits = {} } = {}) {
  const maxTextLength = limits.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const maxPages = limits.maxPages ?? DEFAULT_MAX_PDF_PAGES;
  const doc = validated ?? assertValidDocument({ buffer, filename, mimeType }, { maxBytes: limits.maxBytes });

  let raw;
  try {
    if (doc.format === DOCUMENT_FORMATS.PDF) raw = await extractPdfText(buffer, { maxTextLength, maxPages });
    else if (doc.format === DOCUMENT_FORMATS.DOCX) raw = await extractDocxText(buffer);
    else raw = extractTxtText(buffer);
  } catch (err) {
    if (err instanceof DocumentProcessingError) throw err;
    throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.EXTRACTION_FAILED, 'Text extraction failed.');
  }

  const extractedText = normalizeExtractedText(raw.text);
  if (extractedText.length > maxTextLength) throw tooLarge(maxTextLength);

  // Page-aware segments let the chunker record page numbers. Only PDFs have real pages; DOCX/TXT have no
  // reliable page concept, so they are a single segment without a page (no page number is ever invented).
  const segments = Array.isArray(raw.pages)
    ? raw.pages.map((t, i) => ({ page: i + 1, text: normalizeExtractedText(t) })).filter((seg) => seg.text)
    : (extractedText ? [{ page: undefined, text: extractedText }] : []);

  return {
    extractedText,
    segments,
    detectedFormat: doc.format,
    status: extractedText.length > 0 ? 'extracted' : 'empty',
    metadata: { ...raw.metadata, characterCount: extractedText.length },
  };
}
