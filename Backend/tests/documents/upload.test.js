/**
 * POST /api/projects/:id/documents — route tests over real HTTP.
 *
 * Real: JWT auth (requireAuth), attachProject()/requireRole(), multer, the
 * document processing pipeline (validation, PDF/DOCX/TXT extraction, local
 * storage in a temp dir, real Document schema validation, real SourceRecord
 * persistence logic). Mocked: Project/ProjectMembership lookups and the two
 * persistence models (in-memory). No database or network access.
 */

import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

// config.js requires these at import time; provide test values only if unset.
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:1/relay-test-unused';
process.env.JWT_SECRET ??= 'test-jwt-secret-that-is-at-least-32-characters';
process.env.CRON_SECRET ??= 'test-cron-secret';

const { createDocumentsRouter } = await import('../../src/routes/documents.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { Project } = await import('../../src/models/Project.js');
const { ProjectMembership } = await import('../../src/models/ProjectMembership.js');
const { createLocalDocumentStorage } = await import('../../src/modules/ingestion/documents/index.js');
const { InMemoryDocumentModel } = await import('../../src/modules/ingestion/documents/inMemoryDocumentModel.js');
const { InMemorySourceRecordModel } = await import('../../src/modules/ingestion/persistence/inMemorySourceRecordModel.js');
const { buildPdf, MIME } = await import('../../src/modules/ingestion/documents/documentFixtures.js');

const PROJECT_ID = '665f1c2e8b3a4d0012345678';
const OTHER_PROJECT_ID = '665f1c2e8b3a4d0087654321';
const MEMBER = '665f1c2e8b3a4d00aaaaaaaa';
const VIEWER = '665f1c2e8b3a4d00bbbbbbbb';
const OUTSIDER = '665f1c2e8b3a4d00cccccccc';
const OWNER = '665f1c2e8b3a4d00dddddddd';
const MAX_BYTES = 4096;

const ROLES = { [MEMBER]: 'member', [VIEWER]: 'viewer', [OWNER]: 'owner' };
const tokenFor = (userId) => signAuthToken({ _id: new mongoose.Types.ObjectId(userId) });

describe('POST /api/projects/:id/documents', () => {
  let server;
  let baseUrl;
  let rootDir;
  let documents;
  let sourceRecords;
  let processCalls;

  before(async () => {
    // Database lookups used by attachProject()/getMembership().
    mock.method(Project, 'findById', async (id) => (String(id) === PROJECT_ID ? { _id: new mongoose.Types.ObjectId(PROJECT_ID) } : null));
    mock.method(ProjectMembership, 'findOne', async ({ projectId, userId }) => {
      const role = String(projectId) === PROJECT_ID ? ROLES[String(userId)] : undefined;
      return role ? { projectId, userId, role } : null;
    });

    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-upload-route-'));
    const { processDocumentUpload } = await import('../../src/modules/ingestion/documents/index.js');

    const app = express();
    app.use(express.json());
    app.use('/api/projects', createDocumentsRouter({
      storage: createLocalDocumentStorage({ rootDir }),
      maxBytes: MAX_BYTES,
      documentModel: { create: (data) => documents.create(data) },
      sourceRecordModel: {
        bulkWrite: (...a) => sourceRecords.bulkWrite(...a),
        findOne: (...a) => sourceRecords.findOne(...a),
      },
      processUpload: (args) => { processCalls += 1; return processDocumentUpload(args); },
    }));
    // Same error-handler contract as src/app.js
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      const status = err.status || err.statusCode || 500;
      res.status(status).json({ error: err.code || 'internal_error', message: status < 500 ? err.message : 'Internal server error' });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
  });

  after(async () => {
    mock.restoreAll();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    documents = new InMemoryDocumentModel();
    sourceRecords = new InMemorySourceRecordModel();
    processCalls = 0;
  });

  afterEach(async () => {
    for (const f of await fs.readdir(rootDir)) await fs.rm(path.join(rootDir, f), { force: true });
  });

  function form(fileContent, filename, type, fields = {}) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (fileContent !== undefined) fd.append('file', new Blob([fileContent], { type }), filename);
    return fd;
  }

  async function post(body, { userId = MEMBER, projectId = PROJECT_ID, headers = {} } = {}) {
    const res = await fetch(`${baseUrl}/${projectId}/documents`, {
      method: 'POST',
      headers: { ...(userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}), ...headers },
      body,
    });
    return { status: res.status, body: await res.json() };
  }

  const storedFiles = async () => fs.readdir(rootDir);

  it('201: authenticated member uploads a TXT file', async () => {
    const { status, body } = await post(form('Handoff notes\r\nOwner: Alice', 'handoff.txt', 'text/plain', {
      title: 'Sprint 12 handoff',
      projectId: OTHER_PROJECT_ID, // must be ignored
      uploadedBy: OUTSIDER, // must be ignored
    }));

    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.status, 'succeeded');
    assert.deepEqual(body.persisted, { file: true, document: true, sourceRecord: true });
    assert.equal(body.document.title, 'Sprint 12 handoff');
    assert.equal(body.document.filename, 'handoff.txt');
    assert.equal(body.document.mimeType, MIME.txt);
    assert.equal(body.extraction.detectedFormat, 'txt');
    assert.equal(body.sourceRecord.createdCount, 1);
    assert.match(body.contentHash, /^[a-f0-9]{64}$/);

    const [doc] = documents.docs;
    assert.equal(doc.projectId.toHexString(), PROJECT_ID);
    assert.equal(doc.uploadedBy.toHexString(), MEMBER);
    assert.equal(doc.extractedText, 'Handoff notes\nOwner: Alice');
    const [record] = sourceRecords.all();
    assert.equal(record.projectId.toHexString(), PROJECT_ID);
    assert.equal(record.externalId, body.document.id);

    // No internal storage details or filesystem paths in the response
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes(rootDir));
    assert.ok(!raw.includes(doc.storageRef.key));
  });

  it('201: owners (stricter than member) can upload; PDF text is extracted', async () => {
    const { status, body } = await post(form(buildPdf([['Quarterly plan']]), 'plan.pdf', MIME.pdf), { userId: OWNER });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(documents.docs[0].extractedText, 'Quarterly plan');
    assert.equal(body.extraction.pageCount, 1);
  });

  it('401: missing or invalid authentication', async () => {
    const missing = await post(form('x', 'a.txt', 'text/plain'), { userId: null });
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error, 'unauthorized');

    const invalid = await post(form('x', 'a.txt', 'text/plain'), { userId: null, headers: { Authorization: 'Bearer not-a-jwt' } });
    assert.equal(invalid.status, 401);
    assert.equal(processCalls, 0);
    assert.equal(documents.createCalls, 0);
  });

  it('404: user without access to the project (existence not leaked)', async () => {
    const outsider = await post(form('x', 'a.txt', 'text/plain'), { userId: OUTSIDER });
    assert.equal(outsider.status, 404);
    assert.equal(outsider.body.error, 'not_found');

    const unknownProject = await post(form('x', 'a.txt', 'text/plain'), { projectId: OTHER_PROJECT_ID });
    assert.equal(unknownProject.status, 404);
    assert.equal(processCalls, 0);
    assert.deepEqual(await storedFiles(), []);
  });

  it('403: viewer role is insufficient', async () => {
    const { status, body } = await post(form('x', 'a.txt', 'text/plain'), { userId: VIEWER });
    assert.equal(status, 403);
    assert.equal(body.error, 'forbidden');
    assert.equal(processCalls, 0);
  });

  it('400: missing file; 415: non-multipart request', async () => {
    const noFile = await post(form(undefined, null, null, { title: 'no file' }));
    assert.equal(noFile.status, 400);
    assert.equal(noFile.body.code, 'FILE_REQUIRED');

    const json = await fetch(`${baseUrl}/${PROJECT_ID}/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(MEMBER)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'aGVsbG8=' }),
    });
    assert.equal(json.status, 415);
    assert.equal((await json.json()).code, 'MULTIPART_REQUIRED');

    const wrongField = new FormData();
    wrongField.append('document', new Blob(['x'], { type: 'text/plain' }), 'a.txt');
    const wrong = await post(wrongField);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'UNEXPECTED_FILE_FIELD');
    assert.equal(processCalls, 0);
  });

  it('415: unsupported file type, mismatched MIME, or content that does not match the extension', async () => {
    const exe = await post(form('MZ\x90\x00', 'tool.exe', 'application/octet-stream'));
    assert.equal(exe.status, 415);
    assert.equal(exe.body.code, 'UNSUPPORTED_EXTENSION');
    assert.equal(exe.body.status, 'failed');
    assert.equal(exe.body.stage, 'validation');

    const mismatch = await post(form('hello', 'a.txt', 'application/pdf'));
    assert.equal(mismatch.status, 415);
    assert.equal(mismatch.body.code, 'MIME_TYPE_MISMATCH');

    const fakePdf = await post(form('just text', 'fake.pdf', 'application/pdf'));
    assert.equal(fakePdf.status, 415);
    assert.equal(fakePdf.body.code, 'SIGNATURE_MISMATCH');

    assert.equal(documents.createCalls, 0);
    assert.deepEqual(await storedFiles(), []);
  });

  it('413: oversized upload is rejected by the multipart limit before processing', async () => {
    const { status, body } = await post(form(Buffer.alloc(MAX_BYTES + 1, 0x61), 'big.txt', 'text/plain'));
    assert.equal(status, 413);
    assert.equal(body.code, 'FILE_TOO_LARGE');
    assert.equal(processCalls, 0);
    assert.equal(documents.createCalls, 0);
  });

  it('200: identical content in the same project returns the existing document', async () => {
    const first = await post(form('Same bytes', 'a.txt', 'text/plain'));
    const second = await post(form('Same bytes', 'renamed.txt', 'text/plain'));

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.status, 'duplicate');
    assert.equal(second.body.duplicateOf.documentId, first.body.document.id);
    assert.deepEqual(second.body.persisted, { file: false, document: false, sourceRecord: false });
    assert.equal(documents.docs.length, 1);
    assert.equal((await storedFiles()).length, 1);
  });

  it('422: extraction failure (malformed PDF) stores nothing', async () => {
    const { status, body } = await post(form('%PDF-1.4\nnot a real pdf', 'broken.pdf', 'application/pdf'));
    assert.equal(status, 422);
    assert.equal(body.code, 'MALFORMED_DOCUMENT');
    assert.equal(body.stage, 'extraction');
    assert.equal(body.status, 'failed');
    assert.equal(documents.createCalls, 0);
    assert.deepEqual(await storedFiles(), []);
  });

  it('207: Document saved but SourceRecord persistence failed is reported as partial', async () => {
    sourceRecords.failNextBulkWrite(new Error('connection closed: mongodb://user:pw@10.0.0.9'));
    const { status, body } = await post(form('Important context', 'ctx.txt', 'text/plain'));

    assert.equal(status, 207);
    assert.equal(body.status, 'partial');
    assert.deepEqual(body.persisted, { file: true, document: true, sourceRecord: false });
    assert.equal(body.errors[0].code, 'SOURCE_RECORD_PERSISTENCE_FAILED');
    assert.deepEqual(body.reconciliation, { required: true, action: 'retry_source_record', documentId: body.document.id });
    assert.equal(documents.docs.length, 1);
    assert.equal(sourceRecords.docs.size, 0);
    assert.ok(!JSON.stringify(body).includes('10.0.0.9'));
  });

  it('500: Document persistence failure is not reported as success and leaves no stored file', async () => {
    documents.failNextCreate(new Error('MongoServerError: not primary'));
    const { status, body } = await post(form('x', 'a.txt', 'text/plain'));
    assert.equal(status, 500);
    assert.equal(body.error, 'document_processing_failed');
    assert.equal(body.code, 'DOCUMENT_PERSISTENCE_FAILED');
    assert.equal(body.status, 'failed');
    assert.equal(body.persisted.document, false);
    assert.ok(!JSON.stringify(body).includes('not primary'));
    assert.ok(!('stack' in body));
    assert.deepEqual(await storedFiles(), []);
  });
});
