/**
 * @file documentExtraction.test.js
 * @description Text extraction with the real PDF.js and mammoth parsers on generated fixtures.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDocumentText,
  normalizeExtractedText,
  DEFAULT_MAX_TEXT_LENGTH,
} from './documentExtraction.js';
import { MAX_CONTENT_LENGTH } from '../persistence/sourceRecordStore.js';
import { DOCUMENT_ERROR_CODES as C } from './documentErrors.js';
import { buildPdf, buildDocx, buildZip, docxParts, MIME } from './documentFixtures.js';

const extract = (buffer, filename, mimeType, limits) => extractDocumentText({ buffer, filename, mimeType, limits });

describe('PDF extraction', () => {
  it('extracts text from every page, separating pages with a blank line', async () => {
    const r = await extract(buildPdf([['Handoff plan', 'Owner: Alice'], ['Risks (open)']]), 'plan.pdf', MIME.pdf);
    assert.equal(r.detectedFormat, 'pdf');
    assert.equal(r.status, 'extracted');
    assert.equal(r.extractedText, 'Handoff plan\nOwner: Alice\n\nRisks (open)');
    assert.equal(r.metadata.pageCount, 2);
    assert.equal(r.metadata.characterCount, r.extractedText.length);
  });

  it('reports a valid PDF without text as empty, not as a failure', async () => {
    const r = await extract(buildPdf([[]]), 'scan.pdf', MIME.pdf);
    assert.equal(r.status, 'empty');
    assert.equal(r.extractedText, '');
    assert.equal(r.metadata.pageCount, 1);
  });

  it('rejects a malformed PDF with a sanitized parser error', async () => {
    const bad = Buffer.from('%PDF-1.7\nthis is not a real pdf body SECRET-BODY');
    await assert.rejects(() => extract(bad, 'bad.pdf', MIME.pdf), (err) => {
      assert.equal(err.code, C.MALFORMED_DOCUMENT);
      assert.ok(!err.message.includes('SECRET-BODY'));
      assert.ok(!/[\\/](Users|tmp|node_modules)[\\/]/.test(err.message));
      return true;
    });
  });

  it('enforces a page limit', async () => {
    await assert.rejects(() => extract(buildPdf([['a'], ['b']]), 'a.pdf', MIME.pdf, { maxPages: 1 }), { code: C.LIMIT_EXCEEDED });
  });
});

describe('DOCX extraction', () => {
  it('extracts paragraphs with paragraph boundaries and Unicode intact', async () => {
    const r = await extract(buildDocx(['Decision: ship v2', 'Ünïcödé — 日本語 ✓ & <tags>']), 'notes.docx', MIME.docx);
    assert.equal(r.detectedFormat, 'docx');
    assert.equal(r.status, 'extracted');
    assert.equal(r.extractedText, 'Decision: ship v2\n\nÜnïcödé — 日本語 ✓ & <tags>');
  });

  it('reports an empty document as empty', async () => {
    const r = await extract(buildDocx([]), 'empty.docx', MIME.docx);
    assert.equal(r.status, 'empty');
    assert.equal(r.extractedText, '');
  });

  it('rejects a DOCX whose document XML cannot be parsed', async () => {
    const parts = docxParts(['x']);
    parts['word/document.xml'] = 'not xml <<< PRIVATE-NOTE';
    await assert.rejects(() => extract(buildZip(parts), 'a.docx', MIME.docx), (err) => {
      assert.equal(err.code, C.MALFORMED_DOCUMENT);
      assert.ok(!err.message.includes('PRIVATE-NOTE'));
      return true;
    });
  });

  it('rejects malformed containers before invoking the parser', async () => {
    await assert.rejects(() => extract(buildZip({ 'a.txt': 'x' }), 'a.docx', MIME.docx), { code: C.SIGNATURE_MISMATCH });
  });
});

describe('TXT extraction', () => {
  it('decodes UTF-8 and normalizes line endings without losing paragraphs', async () => {
    const r = await extract(Buffer.from('line one\r\nline two  \r\n\r\n\r\n\r\nnext para 日本\r'), 'a.txt', MIME.txt);
    assert.equal(r.extractedText, 'line one\nline two\n\nnext para 日本');
    assert.equal(r.metadata.encoding, 'utf-8');
  });

  it('decodes UTF-16LE with a BOM', async () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße ✓', 'utf16le')]);
    const r = await extract(buf, 'a.txt', MIME.txt);
    assert.equal(r.extractedText, 'Grüße ✓');
    assert.equal(r.metadata.encoding, 'utf-16le');
  });

  it('treats whitespace-only text as empty', async () => {
    assert.equal((await extract(Buffer.from(' \n\t\r\n '), 'a.txt', MIME.txt)).status, 'empty');
  });

  it('rejects invalid encodings predictably', async () => {
    await assert.rejects(() => extract(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'a.txt', MIME.txt), { code: C.UNSUPPORTED_ENCODING });
  });
});

describe('Shared extraction behavior', () => {
  it('enforces the extracted-text limit for every format', async () => {
    const limits = { maxTextLength: 10 };
    await assert.rejects(() => extract(Buffer.from('x'.repeat(11)), 'a.txt', MIME.txt, limits), { code: C.TEXT_TOO_LARGE });
    await assert.rejects(() => extract(buildDocx(['x'.repeat(11)]), 'a.docx', MIME.docx, limits), { code: C.TEXT_TOO_LARGE });
    await assert.rejects(() => extract(buildPdf([['x'.repeat(11)]]), 'a.pdf', MIME.pdf, limits), { code: C.TEXT_TOO_LARGE });
    assert.equal((await extract(Buffer.from('x'.repeat(10)), 'a.txt', MIME.txt, limits)).status, 'extracted');
  });

  it('default text limit equals the SourceRecord persistence content limit', () => {
    assert.equal(DEFAULT_MAX_TEXT_LENGTH, MAX_CONTENT_LENGTH);
  });

  it('validates input itself when called directly', async () => {
    await assert.rejects(() => extract(Buffer.from('hello'), 'a.exe', MIME.txt), { code: C.UNSUPPORTED_EXTENSION });
    await assert.rejects(() => extract(Buffer.alloc(0), 'a.txt', MIME.txt), { code: C.FILE_EMPTY });
  });

  it('normalizeExtractedText keeps paragraph boundaries and strips control characters', () => {
    assert.equal(normalizeExtractedText('a\r\n\r\n\r\n\r\nb\u0000c\fd   \n'), 'a\n\nbc\n\nd');
  });
});
