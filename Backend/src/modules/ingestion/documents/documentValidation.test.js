/**
 * @file documentValidation.test.js
 * @description Validation of PDF/DOCX/TXT uploads and bounded ZIP inspection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateDocumentUpload,
  sanitizeFilename,
  decodeText,
  DEFAULT_MAX_FILE_BYTES,
} from './documentValidation.js';
import { inspectZip } from './zipInspector.js';
import { DOCUMENT_ERROR_CODES as C } from './documentErrors.js';
import { buildPdf, buildDocx, buildZip, docxParts, MIME } from './documentFixtures.js';

const PDF = buildPdf([['Hello']]);
const DOCX = buildDocx(['Hello']);
const TXT = Buffer.from('Hello, world\n');

const codeOf = (file, options) => {
  const r = validateDocumentUpload(file, options);
  assert.equal(r.valid, false, 'expected invalid');
  assert.equal(r.document, null);
  return r.errors[0].code;
};

describe('validateDocumentUpload: accepted formats', () => {
  it('accepts a valid PDF', () => {
    const r = validateDocumentUpload({ buffer: PDF, filename: 'Spec v2.PDF', mimeType: 'application/pdf' });
    assert.equal(r.valid, true);
    assert.deepEqual(
      { format: r.document.format, extension: r.document.extension, mimeType: r.document.mimeType, size: r.document.size, name: r.document.originalFilename },
      { format: 'pdf', extension: '.pdf', mimeType: MIME.pdf, size: PDF.length, name: 'Spec v2.PDF' },
    );
  });

  it('accepts a valid DOCX and reports its main part', () => {
    const r = validateDocumentUpload({ buffer: DOCX, filename: 'notes.docx', mimeType: MIME.docx });
    assert.equal(r.valid, true);
    assert.equal(r.document.format, 'docx');
    assert.equal(r.document.details.mainPart, 'word/document.xml');
  });

  it('accepts valid TXT, ignoring MIME parameters', () => {
    const r = validateDocumentUpload({ buffer: TXT, filename: 'readme.txt', mimeType: 'text/plain; charset=utf-8' });
    assert.equal(r.valid, true);
    assert.equal(r.document.details.encoding, 'utf-8');
  });
});

describe('validateDocumentUpload: rejections', () => {
  it('rejects a missing file', () => {
    assert.equal(codeOf(undefined), C.FILE_REQUIRED);
    assert.equal(codeOf({ filename: 'a.txt', mimeType: MIME.txt }), C.FILE_REQUIRED);
    assert.equal(codeOf({ buffer: 'text', filename: 'a.txt', mimeType: MIME.txt }), C.FILE_REQUIRED);
  });

  it('rejects an empty file', () => {
    assert.equal(codeOf({ buffer: Buffer.alloc(0), filename: 'a.txt', mimeType: MIME.txt }), C.FILE_EMPTY);
  });

  it('enforces the default 10 MiB limit and a configurable limit', () => {
    assert.equal(DEFAULT_MAX_FILE_BYTES, 10 * 1024 * 1024);
    const big = Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1, 0x61);
    assert.equal(codeOf({ buffer: big, filename: 'a.txt', mimeType: MIME.txt }), C.FILE_TOO_LARGE);
    assert.equal(codeOf({ buffer: TXT, filename: 'a.txt', mimeType: MIME.txt }, { maxBytes: 4 }), C.FILE_TOO_LARGE);
  });

  it('rejects unsupported extensions, including double extensions', () => {
    for (const filename of ['a.exe', 'a.zip', 'a.doc', 'a.pdf.exe', 'noextension', 'a.html']) {
      assert.equal(codeOf({ buffer: TXT, filename, mimeType: MIME.txt }), C.UNSUPPORTED_EXTENSION, filename);
    }
  });

  it('rejects unsupported or mismatched MIME types', () => {
    assert.equal(codeOf({ buffer: PDF, filename: 'a.pdf', mimeType: 'application/octet-stream' }), C.UNSUPPORTED_MIME_TYPE);
    assert.equal(codeOf({ buffer: PDF, filename: 'a.pdf' }), C.UNSUPPORTED_MIME_TYPE);
    assert.equal(codeOf({ buffer: PDF, filename: 'a.pdf', mimeType: MIME.txt }), C.MIME_TYPE_MISMATCH);
    assert.equal(codeOf({ buffer: DOCX, filename: 'a.docx', mimeType: 'application/zip' }), C.UNSUPPORTED_MIME_TYPE);
  });

  it('rejects content whose signature does not match the claimed format', () => {
    assert.equal(codeOf({ buffer: TXT, filename: 'a.pdf', mimeType: MIME.pdf }), C.SIGNATURE_MISMATCH);
    assert.equal(codeOf({ buffer: PDF, filename: 'a.docx', mimeType: MIME.docx }), C.SIGNATURE_MISMATCH);
    assert.equal(codeOf({ buffer: PDF, filename: 'a.txt', mimeType: MIME.txt }), C.SIGNATURE_MISMATCH);
    assert.equal(codeOf({ buffer: DOCX, filename: 'a.txt', mimeType: MIME.txt }), C.SIGNATURE_MISMATCH);
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x00, 0x7f, 0x10, 0x11]);
    assert.equal(codeOf({ buffer: binary, filename: 'a.txt', mimeType: MIME.txt }), C.SIGNATURE_MISMATCH);
  });

  it('rejects arbitrary ZIP archives, macro-enabled and template packages as DOCX', () => {
    const plainZip = buildZip({ 'hello.txt': 'hi' });
    assert.equal(codeOf({ buffer: plainZip, filename: 'a.docx', mimeType: MIME.docx }), C.SIGNATURE_MISMATCH);

    const docm = buildDocx(['x'], { mainContentType: 'application/vnd.ms-word.document.macroEnabled.main+xml' });
    assert.equal(codeOf({ buffer: docm, filename: 'a.docx', mimeType: MIME.docx }), C.SIGNATURE_MISMATCH);

    const dotx = buildDocx(['x'], { mainContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml' });
    assert.equal(codeOf({ buffer: dotx, filename: 'a.docx', mimeType: MIME.docx }), C.SIGNATURE_MISMATCH);

    const withMacros = buildZip({ ...docxParts(['x']), 'word/vbaProject.bin': Buffer.from([1, 2, 3]) });
    assert.equal(codeOf({ buffer: withMacros, filename: 'a.docx', mimeType: MIME.docx }), C.SIGNATURE_MISMATCH);
  });

  it('rejects malformed DOCX containers', () => {
    const truncated = DOCX.subarray(0, DOCX.length - 30);
    assert.equal(codeOf({ buffer: truncated, filename: 'a.docx', mimeType: MIME.docx }), C.MALFORMED_DOCUMENT);

    const parts = docxParts(['x']);
    delete parts['word/document.xml'];
    assert.equal(codeOf({ buffer: buildZip(parts), filename: 'a.docx', mimeType: MIME.docx }), C.MALFORMED_DOCUMENT);

    const corrupted = Buffer.from(DOCX);
    corrupted[60] ^= 0xff; // flip a byte inside the first entry's compressed data
    assert.equal(codeOf({ buffer: corrupted, filename: 'a.docx', mimeType: MIME.docx }), C.MALFORMED_DOCUMENT);
  });

  it('rejects path-traversal and path-bearing filenames', () => {
    for (const filename of ['../../etc/passwd.txt', '..\\..\\boot.txt', 'dir/file.txt', '/abs/file.txt', 'C:\\x\\a.txt', '..', '.', '']) {
      assert.equal(codeOf({ buffer: TXT, filename, mimeType: MIME.txt }), C.INVALID_FILENAME, filename);
    }
  });

  it('returns structured, sanitized errors (no content or paths)', () => {
    const secretContent = Buffer.from('%PDF-not really\nTOP-SECRET-CONTENT');
    const r = validateDocumentUpload({ buffer: secretContent, filename: 'a.docx', mimeType: MIME.docx });
    assert.equal(r.valid, false);
    assert.deepEqual(Object.keys(r.errors[0]).sort(), ['code', 'message']);
    assert.ok(!JSON.stringify(r).includes('TOP-SECRET-CONTENT'));
  });
});

describe('sanitizeFilename and decodeText', () => {
  it('strips control characters and enforces length', () => {
    assert.equal(sanitizeFilename('  re\u0000port\u0007.txt  '), 'report.txt');
    assert.throws(() => sanitizeFilename(`${'a'.repeat(256)}.txt`), { code: C.INVALID_FILENAME });
  });

  it('decodes UTF-8 (with/without BOM) and UTF-16 with BOM', () => {
    assert.deepEqual(decodeText(Buffer.from('héllo')), { text: 'héllo', encoding: 'utf-8' });
    assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom')])).text, 'bom');
    assert.deepEqual(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi ✓', 'utf16le')])), { text: 'hi ✓', encoding: 'utf-16le' });
    const be = Buffer.from('hi', 'utf16le').swap16();
    assert.equal(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text, 'hi');
  });

  it('rejects invalid UTF-8 predictably instead of guessing', () => {
    assert.throws(() => decodeText(Buffer.from([0x68, 0xe9, 0x6c, 0x6c, 0x6f])), { code: C.UNSUPPORTED_ENCODING }); // latin-1 "héllo"
  });
});

describe('inspectZip resource limits', () => {
  it('rejects archives that expand beyond the total limit (zip bomb)', () => {
    const bomb = buildZip({ ...docxParts(['x']), 'word/media/zeros.bin': Buffer.alloc(8 * 1024 * 1024) });
    assert.ok(bomb.length < 100 * 1024);
    assert.throws(() => inspectZip(bomb, { maxTotalUncompressedBytes: 4 * 1024 * 1024 }), { code: C.LIMIT_EXCEEDED });
    assert.equal(codeOf({ buffer: bomb, filename: 'a.docx', mimeType: MIME.docx }, { zipLimits: { maxTotalUncompressedBytes: 4 * 1024 * 1024 } }), C.LIMIT_EXCEEDED);
  });

  it('rejects an entry whose real size exceeds its declared size', () => {
    const lying = buildZip(docxParts(['x']), { 'word/document.xml': { declaredSize: 10 } });
    assert.throws(() => inspectZip(lying), { code: C.LIMIT_EXCEEDED });
  });

  it('rejects too many entries and unsafe entry names', () => {
    const many = buildZip(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.xml`, 'x'])));
    assert.throws(() => inspectZip(many, { maxEntries: 4 }), { code: C.LIMIT_EXCEEDED });
    assert.throws(() => inspectZip(buildZip({ '../evil.xml': 'x' })), { code: C.MALFORMED_DOCUMENT });
    assert.throws(() => inspectZip(buildZip({ '/abs.xml': 'x' })), { code: C.MALFORMED_DOCUMENT });
  });
});
