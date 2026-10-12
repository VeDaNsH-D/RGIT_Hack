/**
 * @file documentProcessingService.test.js
 * @description End-to-end tests of the document pipeline with real parsers, real
 * local storage in a temporary directory, the real Document schema (via
 * InMemoryDocumentModel) and the real SourceRecord persistence adapter (via
 * InMemorySourceRecordModel). No database or network access.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

import { processDocumentUpload, persistDocumentSourceRecord, computeContentHash } from './documentProcessingService.js';
import { createLocalDocumentStorage, isValidStorageKey } from './documentStorage.js';
import { DOCUMENT_ERROR_CODES as C } from './documentErrors.js';
import { InMemoryDocumentModel } from './inMemoryDocumentModel.js';
import { InMemoryChunkModel } from './inMemoryChunkModel.js';
import { InMemorySourceRecordModel } from '../persistence/inMemorySourceRecordModel.js';
import { buildPdf, buildDocx, MIME } from './documentFixtures.js';

const PROJECT_ID = '665f1c2e8b3a4d0012345678';
const OTHER_PROJECT_ID = '665f1c2e8b3a4d0087654321';
const USER_ID = '665f1c2e8b3a4d00aaaaaaaa';
const NOW = new Date('2026-10-12T10:00:00Z');

let rootDir;
let storage;
let documents;
let sourceRecords;
let chunks;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-doc-test-'));
  storage = createLocalDocumentStorage({ rootDir });
  documents = new InMemoryDocumentModel();
  sourceRecords = new InMemorySourceRecordModel();
  chunks = new InMemoryChunkModel();
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

const txt = (text, filename = 'notes.txt') => ({ buffer: Buffer.from(text), filename, mimeType: MIME.txt });

function upload(file, extra = {}) {
  return processDocumentUpload({
    projectId: PROJECT_ID,
    uploadedBy: USER_ID,
    file,
    storage,
    documentModel: documents,
    sourceRecordModel: sourceRecords,
    chunkModel: chunks,
    now: () => NOW,
    ...extra,
  });
}

const storedFiles = async () => (await fs.readdir(rootDir)).sort();

/** Wraps a storage adapter and counts calls. */
function spyStorage(inner, overrides = {}) {
  const calls = { put: 0, delete: 0 };
  return {
    calls,
    name: 'spy',
    put: async (args) => { calls.put += 1; return (overrides.put || inner.put)(args); },
    delete: async (key) => { calls.delete += 1; return (overrides.delete || inner.delete)(key); },
    read: inner.read,
  };
}

describe('processDocumentUpload: success', () => {
  it('stores the file, persists the Document and its SourceRecord', async () => {
    const pdf = buildPdf([['Handoff for Q4', 'Owner: Alice'], ['Open risks']]);
    const result = await upload({ buffer: pdf, filename: 'Q4 Handoff.pdf', mimeType: MIME.pdf }, { title: '  Q4   handoff ' });

    assert.equal(result.status, 'succeeded', JSON.stringify(result.errors));
    assert.deepEqual(result.persisted, { file: true, document: true, sourceRecord: true });
    assert.deepEqual(result.errors, []);
    assert.equal(result.extraction.detectedFormat, 'pdf');
    assert.equal(result.extraction.pageCount, 2);

    // Document fields (validated by the real Document schema)
    const [doc] = documents.docs;
    assert.equal(doc.projectId.toHexString(), PROJECT_ID);
    assert.equal(doc.uploadedBy.toHexString(), USER_ID);
    assert.equal(doc.title, 'Q4 handoff');
    assert.equal(doc.filename, 'Q4 Handoff.pdf');
    assert.equal(doc.mimeType, MIME.pdf);
    assert.equal(doc.size, pdf.length);
    assert.equal(doc.url, '');
    assert.equal(doc.storageRef.provider, 'none');
    assert.ok(isValidStorageKey(doc.storageRef.key));
    assert.equal(doc.extractedText, 'Handoff for Q4\nOwner: Alice\n\nOpen risks');
    assert.equal(result.document.id, String(doc._id));

    // Stored bytes are identical and keyed by a generated name, not the filename
    assert.deepEqual(await storedFiles(), [doc.storageRef.key]);
    assert.ok(Buffer.from(await storage.read(doc.storageRef.key)).equals(pdf));

    // SourceRecord references the persisted Document
    const [record] = sourceRecords.all();
    assert.equal(record.provider, 'document');
    assert.equal(record.type, 'document');
    assert.equal(record.externalId, String(doc._id));
    assert.equal(record.projectId.toHexString(), PROJECT_ID);
    assert.equal(record.title, 'Q4 handoff');
    assert.equal(record.content, doc.extractedText);
    assert.equal(record.metadata.sourceCreatedAt.getTime(), doc.createdAt.getTime());
    assert.equal(record.metadata.fetchedAt.toISOString(), NOW.toISOString());
    assert.equal(record.metadata.extractionStatus, 'extracted');
    assert.equal(record.metadata.authorId, USER_ID);
    const pm = record.metadata.providerMetadata;
    assert.equal(pm.documentId, String(doc._id));
    assert.equal(pm.contentHash, crypto.createHash('sha256').update(pdf).digest('hex'));
    assert.equal(pm.contentHashAlgorithm, 'sha256');
    assert.equal(pm.filename, 'Q4 Handoff.pdf');
    assert.equal(pm.detectedFormat, 'pdf');
    assert.equal(pm.pageCount, 2);
    assert.equal(result.sourceRecord.createdCount, 1);
  });

  it('processes DOCX and TXT, deriving the title from the filename', async () => {
    const docx = await upload({ buffer: buildDocx(['Decision: use Atlas', 'Ünïcödé ✓']), filename: 'decisions.docx', mimeType: MIME.docx });
    const text = await upload(txt('Plain notes\r\nline 2'));

    assert.equal(docx.status, 'succeeded');
    assert.equal(text.status, 'succeeded');
    assert.deepEqual(documents.docs.map((d) => [d.title, d.extractedText]), [
      ['decisions', 'Decision: use Atlas\n\nÜnïcödé ✓'],
      ['notes', 'Plain notes\nline 2'],
    ]);
    assert.equal(sourceRecords.docs.size, 2);
  });

  it('computes SHA-256 over the original bytes', () => {
    const buf = Buffer.from('abc');
    assert.equal(computeContentHash(buf), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('keeps a valid document with no extractable text and warns', async () => {
    const result = await upload({ buffer: buildPdf([[]]), filename: 'scan.pdf', mimeType: MIME.pdf });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.extraction.status, 'empty');
    assert.equal(result.warnings[0].code, C.NO_EXTRACTABLE_TEXT);
    assert.equal(sourceRecords.all()[0].metadata.extractionStatus, 'empty');
    assert.equal(sourceRecords.all()[0].content, '');
  });
});

describe('processDocumentUpload: identical content and same filenames', () => {
  it('recognizes identical bytes in the same project and stores nothing new', async () => {
    const first = await upload(txt('Same bytes', 'a.txt'));
    const second = await upload(txt('Same bytes', 'renamed.txt'));

    assert.equal(second.status, 'duplicate');
    assert.equal(second.duplicateOf.documentId, first.document.id);
    assert.equal(second.contentHash, first.contentHash);
    assert.deepEqual(second.persisted, { file: false, document: false, sourceRecord: false });
    assert.equal(documents.docs.length, 1);
    assert.equal(sourceRecords.docs.size, 1);
    assert.equal((await storedFiles()).length, 1);
  });

  it('creates a distinct instance for identical bytes when duplicatePolicy is "allow"', async () => {
    const first = await upload(txt('Same bytes'));
    const second = await upload(txt('Same bytes'), { duplicatePolicy: 'allow' });
    assert.equal(second.status, 'succeeded');
    assert.notEqual(second.document.id, first.document.id);
    assert.equal(sourceRecords.docs.size, 2);
  });

  it('does not treat identical bytes in another project as a duplicate', async () => {
    await upload(txt('Same bytes'));
    const other = await upload(txt('Same bytes'), { projectId: OTHER_PROJECT_ID });
    assert.equal(other.status, 'succeeded');
    assert.equal(sourceRecords.all().filter((r) => r.projectId.toHexString() === OTHER_PROJECT_ID).length, 1);
  });

  it('never overwrites an earlier upload with the same filename but different content', async () => {
    const v1 = await upload(txt('Version one', 'plan.txt'));
    const v2 = await upload(txt('Version two', 'plan.txt'));

    assert.equal(v2.status, 'succeeded');
    assert.notEqual(v1.document.id, v2.document.id);
    assert.notEqual(v1.contentHash, v2.contentHash);
    assert.equal(documents.docs.length, 2);
    assert.equal(sourceRecords.docs.size, 2);
    const [k1, k2] = documents.docs.map((d) => d.storageRef.key);
    assert.notEqual(k1, k2);
    assert.equal((await storage.read(k1)).toString(), 'Version one');
    assert.equal((await storage.read(k2)).toString(), 'Version two');
  });
});

describe('processDocumentUpload: failures never report false success', () => {
  it('validation failure: nothing stored or persisted', async () => {
    const spy = spyStorage(storage);
    const result = await upload({ buffer: Buffer.from('MZ binary'), filename: 'tool.exe', mimeType: 'application/octet-stream' }, { storage: spy });
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'validation');
    assert.equal(result.errors[0].code, C.UNSUPPORTED_EXTENSION);
    assert.equal(spy.calls.put, 0);
    assert.equal(documents.createCalls, 0);
    assert.equal(sourceRecords.bulkWriteCalls.length, 0);
  });

  it('extraction failure: nothing stored or persisted', async () => {
    const result = await upload({ buffer: Buffer.from('%PDF-1.4\ngarbage'), filename: 'x.pdf', mimeType: MIME.pdf });
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'extraction');
    assert.equal(result.errors[0].code, C.MALFORMED_DOCUMENT);
    assert.deepEqual(await storedFiles(), []);
    assert.equal(documents.createCalls, 0);
  });

  it('duplicate-lookup failure: fails before storing anything', async () => {
    sourceRecords.failNextFind();
    const result = await upload(txt('x'));
    assert.equal(result.status, 'failed');
    assert.equal(result.errors[0].code, C.DUPLICATE_LOOKUP_FAILED);
    assert.deepEqual(await storedFiles(), []);
  });

  it('storage failure: no Document or SourceRecord, not reported as saved', async () => {
    const failing = spyStorage(storage, { put: async () => { throw new Error(`EACCES: permission denied, open '${rootDir}/x'`); } });
    const result = await upload(txt('x'), { storage: failing });
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'storage');
    assert.equal(result.errors[0].code, C.STORAGE_FAILED);
    assert.deepEqual(result.persisted, { file: false, document: false, sourceRecord: false });
    assert.equal(documents.createCalls, 0);
    assert.ok(!JSON.stringify(result).includes(rootDir));
  });

  it('Document persistence failure: the newly stored file is removed', async () => {
    documents.failNextCreate(new Error('MongoServerError: connection to 10.0.0.5 closed'));
    const result = await upload(txt('x'));
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'document');
    assert.equal(result.errors[0].code, C.DOCUMENT_PERSISTENCE_FAILED);
    assert.equal(result.persisted.file, false);
    assert.equal(result.reconciliation, null);
    assert.deepEqual(await storedFiles(), []);
    assert.equal(sourceRecords.bulkWriteCalls.length, 0);
    assert.ok(!JSON.stringify(result).includes('10.0.0.5'));
  });

  it('Document persistence failure + cleanup failure: both reported, original error first', async () => {
    documents.failNextCreate();
    const leaky = spyStorage(storage, { delete: async () => { throw new Error('EBUSY'); } });
    const result = await upload(txt('x'), { storage: leaky });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.errors.map((e) => e.code), [C.DOCUMENT_PERSISTENCE_FAILED, C.CLEANUP_FAILED]);
    assert.equal(result.persisted.file, true);
    assert.equal(result.reconciliation.action, 'delete_orphaned_file');
    assert.ok(isValidStorageKey(result.reconciliation.storageKey));
  });

  it('SourceRecord persistence failure: partial result with a working retry path', async () => {
    sourceRecords.failNextBulkWrite();
    const result = await upload(txt('Important context'));

    assert.equal(result.status, 'partial');
    assert.deepEqual(result.persisted, { file: true, document: true, sourceRecord: false });
    assert.equal(result.errors[0].code, C.SOURCE_RECORD_PERSISTENCE_FAILED);
    assert.equal(result.sourceRecord.persisted, false);
    assert.deepEqual(result.reconciliation, {
      required: true, action: 'retry_source_record', documentId: result.document.id, contentHash: result.contentHash,
    });
    assert.equal(sourceRecords.docs.size, 0);

    // Retry from the persisted Document (as a reconciliation job would)
    const retry = await persistDocumentSourceRecord({
      document: documents.docs[0],
      extraction: { extractedText: documents.docs[0].extractedText, detectedFormat: 'txt', status: 'extracted', metadata: {} },
      contentHash: result.reconciliation.contentHash,
      sourceRecordModel: sourceRecords,
    });
    assert.equal(retry.createdCount, 1);
    assert.equal(sourceRecords.all()[0].externalId, result.document.id);
  });
});

describe('Local storage adapter', () => {
  it('generates keys and never uses the original filename', async () => {
    const { key, storageRef } = await storage.put({ buffer: Buffer.from('x'), extension: '.txt' });
    assert.ok(isValidStorageKey(key));
    assert.deepEqual(storageRef, { provider: 'none', key, url: '' });
  });

  it('rejects traversal keys and unsupported extensions', async () => {
    for (const key of ['../etc/passwd', '..', '/etc/passwd', 'a/b.txt', `${crypto.randomUUID()}.exe`]) {
      await assert.rejects(() => storage.delete(key), { code: C.STORAGE_FAILED });
      await assert.rejects(() => storage.read(key), { code: C.STORAGE_FAILED });
    }
    await assert.rejects(() => storage.put({ buffer: Buffer.from('x'), extension: '.sh' }), { code: C.STORAGE_FAILED });
  });

  it('does not delete files it does not recognize and reports missing keys', async () => {
    await fs.writeFile(path.join(rootDir, 'pre-existing.txt'), 'keep me');
    assert.equal(await storage.delete(`${crypto.randomUUID()}.txt`), false);
    await assert.rejects(() => storage.delete('pre-existing.txt'), { code: C.STORAGE_FAILED });
    assert.equal(await fs.readFile(path.join(rootDir, 'pre-existing.txt'), 'utf8'), 'keep me');
  });

  it('leaves no temporary files and hides paths when a write fails', async () => {
    const fileAsRoot = path.join(rootDir, 'not-a-directory');
    await fs.writeFile(fileAsRoot, 'x');
    const broken = createLocalDocumentStorage({ rootDir: fileAsRoot });
    await assert.rejects(() => broken.put({ buffer: Buffer.from('x'), extension: '.txt' }), (err) => {
      assert.equal(err.code, C.STORAGE_FAILED);
      assert.ok(!err.message.includes(rootDir));
      return true;
    });
    await upload(txt('ok'));
    assert.ok((await storedFiles()).every((f) => !f.startsWith('.tmp-')));
  });
});

describe('Security', () => {
  it('requires a valid projectId and uploadedBy from the caller (no implicit project)', async () => {
    for (const projectId of [undefined, '', 'default-project', 'acme/relay']) {
      await assert.rejects(() => upload(txt('x'), { projectId }), { code: C.INVALID_INPUT });
    }
    await assert.rejects(() => upload(txt('x'), { uploadedBy: 'anonymous' }), { code: C.INVALID_INPUT });
    await assert.rejects(() => upload(txt('x'), { storage: null }), { code: C.INVALID_INPUT });
    assert.equal(documents.createCalls, 0);
  });

  it('a path-traversal filename is rejected and never reaches the filesystem', async () => {
    const result = await upload(txt('x', '../../../etc/cron.d/evil.txt'));
    assert.equal(result.errors[0].code, C.INVALID_FILENAME);
    assert.deepEqual(await storedFiles(), []);
  });

  it('results contain no filesystem paths and no file bytes outside extracted text', async () => {
    const pdf = buildPdf([['Visible text']]);
    const result = await upload({ buffer: pdf, filename: 'a.pdf', mimeType: MIME.pdf });
    const serializedResult = JSON.stringify(result);
    assert.ok(!serializedResult.includes(rootDir));
    assert.ok(!serializedResult.includes(os.tmpdir()));

    const base64 = pdf.toString('base64').slice(0, 40);
    const record = sourceRecords.all()[0];
    const docObject = documents.docs[0].toObject();
    for (const blob of [JSON.stringify(record.metadata), JSON.stringify({ ...docObject, extractedText: undefined })]) {
      assert.ok(!blob.includes('%PDF'), 'raw PDF bytes leaked');
      assert.ok(!blob.includes(base64), 'base64 file bytes leaked');
      assert.ok(!blob.includes('"type":"Buffer"'), 'Buffer serialized into metadata');
    }
  });

  it('credential-like filenames are redacted in SourceRecord metadata', async () => {
    await upload(txt('x', 'ghs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.txt'));
    assert.ok(!JSON.stringify(sourceRecords.all()[0].metadata).includes('ghs_AbCd'));
  });

  it('does not log anything (so no content or credentials reach logs)', async (t) => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => t.mock.method(console, m));
    await upload({ buffer: buildPdf([['Secret plan']]), filename: 'a.pdf', mimeType: MIME.pdf });
    await upload({ buffer: Buffer.from('%PDF-1.4\nbroken'), filename: 'b.pdf', mimeType: MIME.pdf });
    documents.failNextCreate();
    await upload(txt('y'));
    assert.equal(spies.reduce((n, s) => n + s.mock.callCount(), 0), 0);
  });

  it('records are always associated with the supplied project, never the file', async () => {
    await upload(txt('x'), { projectId: new mongoose.Types.ObjectId(OTHER_PROJECT_ID) });
    assert.equal(documents.docs[0].projectId.toHexString(), OTHER_PROJECT_ID);
    assert.equal(sourceRecords.all()[0].projectId.toHexString(), OTHER_PROJECT_ID);
  });
});
