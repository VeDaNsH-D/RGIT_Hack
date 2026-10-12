/**
 * REAL application (src/app.js) + REAL MongoDB (mongodb-memory-server).
 * Real: Express app and middleware order, JWT auth, User/Project/ProjectMembership,
 * Document/SourceRecord/SourceConnection collections, multer, extraction, local storage in a temp dir.
 * Not used: any external network service, any x-user-id header.
 * Run with: npm run test:integration
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetCollections, STORAGE_DIR } from './harness.js';

await startMongo();
const { app } = await import('../../src/app.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { User, Project, ProjectMembership, SourceRecord, SourceConnection, Document } = await import('../../src/models/index.js');
const { persistSourceRecordCandidates } = await import('../../src/modules/ingestion/persistence/sourceRecordStore.js');
const { processDocumentUpload, createLocalDocumentStorage } = await import('../../src/modules/ingestion/documents/index.js');
const { buildProjectContextPack } = await import('../../src/services/contextBuilder.js');

describe('real app on real MongoDB', () => {
  let server, base, owner, member, viewer, outsider, project, otherProject;

  const tok = (u) => `Bearer ${signAuthToken(u)}`;
  async function call(method, path, { user, body, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, { method, body, headers: { ...(user ? { Authorization: tok(user) } : {}), ...headers } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, body: json, text };
  }
  const get = (p, user) => call('GET', p, { user });
  const upload = (projectId, content, filename, user, fields = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', new Blob([content], { type: 'text/plain' }), filename);
    return call('POST', `/api/projects/${projectId}/documents`, { user, body: fd });
  };
  const candidate = (projectId, n, over = {}) => ({
    projectId: String(projectId), provider: 'github', recordType: 'issue', externalId: `I_${n}`, title: `Issue ${n}`,
    content: `body ${n}`, contentType: 'text/markdown', url: `https://github.com/acme/relay/issues/${n}`,
    author: 'alice', authorId: '11', createdAt: new Date(2026, 0, n), updatedAt: new Date(2026, 0, n),
    fetchedAt: new Date('2026-02-01T00:00:00Z'), version: 1, isActive: true, isDeleted: false, metadata: { number: n }, ...over,
  });

  before(async () => {
    await resetCollections();
    const mk = (n) => User.create({ email: `${n}@example.com`, name: n });
    [owner, member, viewer, outsider] = await Promise.all(['owner', 'member', 'viewer', 'outsider'].map(mk));
    project = await Project.create({ name: 'P', ownerId: owner._id, createdBy: owner._id });
    otherProject = await Project.create({ name: 'Other', ownerId: outsider._id, createdBy: outsider._id });
    await ProjectMembership.create([
      { projectId: project._id, userId: owner._id, role: 'owner', invitedBy: owner._id },
      { projectId: project._id, userId: member._id, role: 'member', invitedBy: owner._id },
      { projectId: project._id, userId: viewer._id, role: 'viewer', invitedBy: owner._id },
      { projectId: otherProject._id, userId: outsider._id, role: 'owner', invitedBy: outsider._id },
    ]);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await stopMongo();
  });

  describe('authentication, mounting and error shape', () => {
    const routes = (id) => [
      ['GET', `/api/projects/${id}/source-records`], ['GET', `/api/projects/${id}/ingestion/source-records`], ['GET', `/api/projects/${id}/source-records/${new mongoose.Types.ObjectId()}`],
      ['GET', `/api/projects/${id}/documents`], ['GET', `/api/projects/${id}/documents/${new mongoose.Types.ObjectId()}`],
      ['GET', `/api/projects/${id}/ingestion/status`],
      ['POST', `/api/projects/${id}/documents`], ['POST', `/api/projects/${id}/documents/${new mongoose.Types.ObjectId()}/reindex`],
    ];
    it('every ingestion route is mounted and rejects a missing/invalid bearer token with 401', async () => {
      for (const [m, p] of routes(project._id)) {
        assert.equal((await call(m, p)).status, 401, `${m} ${p}`);
        assert.equal((await call(m, p, { headers: { Authorization: 'Bearer not.a.jwt' } })).status, 401, `${m} ${p}`);
      }
    });
    it('x-user-id alone is NOT relied on: the test suite never sends it, and a bearer token is accepted', async () => {
      assert.equal((await get(`/api/projects/${project._id}/ingestion/status`, viewer)).status, 200);
    });
    it('malformed project id -> the established 404 not_found (same body as unknown project)', async () => {
      const r = await get('/api/projects/not-an-id/ingestion/source-records', owner);
      const unknown = await get(`/api/projects/${new mongoose.Types.ObjectId()}/ingestion/source-records`, owner);
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, unknown.body);
    });
    it('unknown project and non-member both -> identical 404', async () => {
      const unknown = await get(`/api/projects/${new mongoose.Types.ObjectId()}/documents`, owner);
      const nonMember = await get(`/api/projects/${project._id}/documents`, outsider);
      assert.equal(unknown.status, 404);
      assert.deepEqual(nonMember.body, unknown.body);
    });
    it('unknown route -> JSON 404; no stack traces anywhere', async () => {
      const r = await get('/api/nope', owner);
      assert.equal(r.status, 404);
      assert.equal(r.body.error, 'not_found');
      assert.ok(!/\bat \S+ \(/.test(r.text));
    });
  });

  describe('role behaviour', () => {
    it('non-member cannot read any project data or upload', async () => {
      for (const p of ['source-records', 'ingestion/source-records', 'documents', 'ingestion/status']) {
        assert.equal((await get(`/api/projects/${project._id}/${p}`, outsider)).status, 404, p);
      }
      assert.equal((await upload(project._id, 'x', 'x.txt', outsider)).status, 404);
    });
    it('viewer can read but cannot upload or reindex (403)', async () => {
      for (const p of ['ingestion/source-records', 'documents', 'ingestion/status']) {
        assert.equal((await get(`/api/projects/${project._id}/${p}`, viewer)).status, 200, p);
      }
      assert.equal((await upload(project._id, 'x', 'x.txt', viewer)).status, 403);
      assert.equal((await call('POST', `/api/projects/${project._id}/documents/${new mongoose.Types.ObjectId()}/reindex`, { user: viewer })).status, 403);
      assert.equal(await Document.countDocuments({ projectId: project._id }), 0);
    });
  });

  describe('upload -> persistence -> read APIs', () => {
    let uploaded;
    it('member upload: 201, real Document + SourceRecord rows, no path in response', async () => {
      const r = await upload(project._id, 'Sprint handoff\nOwner: Alice', 'handoff.txt', member, { title: 'Sprint 12', projectId: String(otherProject._id) });
      assert.equal(r.status, 201, r.text);
      uploaded = r.body.document;
      assert.ok(!r.text.includes(STORAGE_DIR));
      const doc = await Document.findById(uploaded.id).select('+extractedText').lean();
      assert.equal(String(doc.projectId), String(project._id), 'body projectId must be ignored');
      assert.equal(doc.extractedText, 'Sprint handoff\nOwner: Alice');
      assert.equal(await SourceRecord.countDocuments({ projectId: project._id, provider: 'document', externalId: uploaded.id }), 1);
      assert.equal(await Document.countDocuments({ projectId: otherProject._id }), 0);
      assert.equal((await fs.readdir(STORAGE_DIR)).length, 1);
    });
    it('identical re-upload -> 200 duplicate, nothing new stored (regression)', async () => {
      const r = await upload(project._id, 'Sprint handoff\nOwner: Alice', 'again.txt', member);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'duplicate');
      assert.equal(await Document.countDocuments({}), 1);
      assert.equal((await fs.readdir(STORAGE_DIR)).length, 1);
    });
    it('document list/detail show indexed status with no text, bytes, or storage details', async () => {
      const list = await get(`/api/projects/${project._id}/documents`, viewer);
      assert.equal(list.status, 200);
      assert.equal(list.body.pagination.total, 1);
      assert.equal(list.body.items[0].processing.status, 'indexed');
      const one = await get(`/api/projects/${project._id}/documents/${uploaded.id}`, viewer);
      assert.equal(one.status, 200);
      for (const r of [list, one]) {
        assert.ok(!r.text.includes('Sprint handoff'), 'extracted text leaked');
        assert.ok(!r.text.includes(STORAGE_DIR));
        assert.ok(!/extractedText|"key"/.test(r.text));
      }
      assert.equal((await get(`/api/projects/${otherProject._id}/documents/${uploaded.id}`, outsider)).status, 404);
    });
    it('source-record detail for the document returns the normalized text; list does not', async () => {
      const list = await get(`/api/projects/${project._id}/ingestion/source-records?provider=document`, viewer);
      assert.equal(list.body.items.length, 1);
      assert.ok(!list.text.includes('Sprint handoff'));
      const one = await get(`/api/projects/${project._id}/source-records/${list.body.items[0].id}`, viewer);
      assert.equal(one.body.item.content, 'Sprint handoff\nOwner: Alice');
    });
  });

  describe('source-record queries on real Mongoose chains', () => {
    before(async () => {
      await persistSourceRecordCandidates({ projectId: String(project._id), records: Array.from({ length: 25 }, (_, i) => candidate(project._id, i + 1)) });
      await persistSourceRecordCandidates({ projectId: String(project._id), records: [candidate(project._id, 1, { provider: 'jira', externalId: 'J-1', recordType: 'pull_request', title: 'Jira thing' })] });
      await persistSourceRecordCandidates({ projectId: String(otherProject._id), records: [candidate(otherProject._id, 99)] });
      await SourceRecord.create({ projectId: project._id, provider: 'manual', externalId: 'n1', type: 'note', title: 'manual note' });
    });
    it('default page: 20 items, correct total, stable newest-first order, no manual notes', async () => {
      const r = await get(`/api/projects/${project._id}/ingestion/source-records`, member);
      assert.equal(r.body.items.length, 20);
      assert.equal(r.body.pagination.total, 27, '25 github + 1 jira + 1 document; manual and other-project excluded');
      assert.equal(r.body.pagination.totalPages, 2);
      const times = r.body.items.map((i) => new Date(i.createdAt).getTime());
      assert.deepEqual(times, [...times].sort((a, b) => b - a));
      assert.ok(!r.body.items.some((i) => i.provider === 'manual'));
    });
    it('pages do not overlap and cover every record exactly once', async () => {
      const seen = [];
      for (const page of [1, 2, 3]) {
        const r = await get(`/api/projects/${project._id}/ingestion/source-records?limit=10&page=${page}`, member);
        seen.push(...r.body.items.map((i) => i.id));
      }
      assert.equal(seen.length, 27);
      assert.equal(new Set(seen).size, 27);
    });
    it('provider and type filters + counts', async () => {
      const gh = await get(`/api/projects/${project._id}/ingestion/source-records?provider=github&limit=100`, member);
      assert.equal(gh.body.pagination.total, 25);
      const pr = await get(`/api/projects/${project._id}/ingestion/source-records?type=pull_request`, member);
      assert.deepEqual(pr.body.items.map((i) => i.provider), ['jira']);
      const none = await get(`/api/projects/${project._id}/ingestion/source-records?provider=slack`, member);
      assert.deepEqual(none.body, { items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false } });
    });
    it('project isolation: another project’s record id is a 404, and invalid input is a 400', async () => {
      const foreign = await SourceRecord.findOne({ projectId: otherProject._id }).lean();
      assert.equal((await get(`/api/projects/${project._id}/source-records/${foreign._id}`, member)).status, 404);
      assert.equal((await get(`/api/projects/${project._id}/ingestion/source-records?limit=101`, member)).status, 400);
      assert.equal((await get(`/api/projects/${project._id}/source-records/zzz`, member)).status, 400);
    });
    it('detail redacts secrets even when a row was written around the scrubber', async () => {
      const token = ['ghs', '_', 'B'.repeat(36)].join('');
      const rec = await SourceRecord.create({
        projectId: project._id, provider: 'github', externalId: 'raw-1', type: 'issue', title: 'raw',
        url: 'https://u:pw1234@github.com/x', content: 'c',
        metadata: { providerMetadata: { memo: `x ${token}`, list: [{ apiKey: 'k', fine: 1 }], file: '/var/data/relay/a.pdf' } },
      });
      const r = await get(`/api/projects/${project._id}/source-records/${rec._id}`, viewer);
      assert.ok(!r.text.includes(token) && !r.text.includes('pw1234') && !r.text.includes('/var/data'));
      assert.deepEqual(r.body.item.metadata.list, [{ fine: 1 }]);
    });
  });

  describe('ingestion status on real data', () => {
    it('connected comes only from persisted SourceConnection rows; counts via real aggregate; no config leak', async () => {
      const before = await get(`/api/projects/${project._id}/ingestion/status`, viewer);
      assert.ok(before.body.providers.every((p) => p.connected === false));
      await SourceConnection.create({ projectId: project._id, provider: 'github', connectedBy: owner._id, config: { installationId: 123456, owner: 'acme', repo: 'secret-repo', token: 'zzz' } });
      await SourceConnection.create({ projectId: otherProject._id, provider: 'jira', connectedBy: outsider._id });
      const r = await get(`/api/projects/${project._id}/ingestion/status`, viewer);
      const by = Object.fromEntries(r.body.providers.map((p) => [p.provider, p]));
      assert.equal(by.github.connected, true);
      assert.equal(by.jira.connected, false);
      assert.equal(by.github.recordCount, 26, '25 ingested + the raw-written row');
      assert.equal(by.jira.recordCount, 1);
      assert.equal(r.body.documents.recordCount, 1);
      assert.ok(!/123456|secret-repo|zzz|installationId/.test(r.text));
    });
  });

  describe('partial upload recovery through the app', () => {
    let partialDoc;
    before(async () => {
      let first = true;
      const flaky = {
        bulkWrite: (...a) => { if (first) { first = false; return Promise.reject(new Error('connection closed')); } return SourceRecord.bulkWrite(...a); },
        findOne: (...a) => SourceRecord.findOne(...a),
      };
      const r = await processDocumentUpload({
        projectId: project._id, uploadedBy: member._id, storage: createLocalDocumentStorage({ rootDir: STORAGE_DIR }),
        file: { buffer: Buffer.from('Recovery candidate text'), filename: 'partial.txt', mimeType: 'text/plain' },
        sourceRecordModel: flaky,
      });
      assert.equal(r.status, 'partial');
      partialDoc = r.document;
    });
    const reindex = (projectId, docId, user) => call('POST', `/api/projects/${projectId}/documents/${docId}/reindex`, { user });

    it('shows as pending_indexing before recovery', async () => {
      const r = await get(`/api/projects/${project._id}/documents/${partialDoc.id}`, viewer);
      assert.equal(r.body.item.processing.status, 'pending_indexing');
    });
    it('non-member / other project cannot recover it (404); viewer gets 403', async () => {
      assert.equal((await reindex(project._id, partialDoc.id, outsider)).status, 404);
      assert.equal((await reindex(otherProject._id, partialDoc.id, outsider)).status, 404, 'document id from another project');
      assert.equal((await reindex(project._id, partialDoc.id, viewer)).status, 403);
      assert.equal(await SourceRecord.countDocuments({ provider: 'document', externalId: partialDoc.id }), 0);
    });
    it('member recovers it: one SourceRecord, same Document, idempotent on repeat', async () => {
      const docsBefore = await Document.countDocuments({});
      const a = await reindex(project._id, partialDoc.id, member);
      assert.equal(a.status, 200, a.text);
      assert.equal(a.body.status, 'recovered');
      const b = await reindex(project._id, partialDoc.id, member);
      assert.equal(b.body.status, 'already_indexed');
      assert.equal(await SourceRecord.countDocuments({ provider: 'document', externalId: partialDoc.id }), 1);
      assert.equal(await Document.countDocuments({}), docsBefore);
      const doc = await get(`/api/projects/${project._id}/documents/${partialDoc.id}`, viewer);
      assert.equal(doc.body.item.processing.status, 'indexed');
    });
    it('concurrent recoveries create exactly one SourceRecord', async () => {
      const r = await upload(project._id, 'Concurrency doc', 'c.txt', member);
      const id = r.body.document.id;
      await SourceRecord.deleteOne({ provider: 'document', externalId: id }); // simulate a partial upload
      const results = await Promise.all(Array.from({ length: 6 }, () => reindex(project._id, id, member)));
      // A competing retry is refused (409 DOCUMENT_BUSY) rather than double-processed; the winner (200) indexes once.
      assert.ok(results.some((x) => x.status === 200) && results.every((x) => [200, 409].includes(x.status)), JSON.stringify(results.map((x) => x.status)));
      assert.equal(await SourceRecord.countDocuments({ provider: 'document', externalId: id }), 1);
    });
    it('original file gone -> 409 ORIGINAL_UNAVAILABLE, nothing written, Document kept', async () => {
      const r = await upload(project._id, 'Will lose bytes', 'lost.txt', member);
      const id = r.body.document.id;
      const doc = await Document.findById(id).lean();
      await SourceRecord.deleteOne({ provider: 'document', externalId: id });
      await fs.rm(`${STORAGE_DIR}/${doc.storageRef.key}`);
      const rec = await reindex(project._id, id, member);
      assert.equal(rec.status, 409);
      assert.equal(rec.body.code, 'ORIGINAL_UNAVAILABLE');
      assert.ok(!rec.text.includes(STORAGE_DIR));
      assert.equal(await SourceRecord.countDocuments({ provider: 'document', externalId: id }), 0);
      assert.ok(await Document.exists({ _id: id }));
    });
    it('unknown document -> 404; malformed ids -> 400', async () => {
      assert.equal((await reindex(project._id, new mongoose.Types.ObjectId(), member)).status, 404);
      assert.equal((await reindex(project._id, 'bad', member)).status, 400);
    });
  });

  describe('Person 3 ContextPackRequest compatibility', () => {
    it('ingested records satisfy the fields buildProjectContextPack requires', async () => {
      const pack = await buildProjectContextPack(String(project._id));
      assert.equal(pack.case_id, String(project._id));
      const gh = pack.sources.find((s) => s.provider === 'github' && s.external_id === 'I_3');
      assert.ok(gh);
      for (const k of ['id', 'external_id', 'provider', 'record_type', 'title', 'content', 'content_type', 'url', 'author', 'created_at', 'updated_at', 'fetched_at', 'metadata']) {
        assert.ok(k in gh, `missing ${k}`);
      }
      assert.equal(gh.record_type, 'issue');
      assert.equal(gh.url, 'https://github.com/acme/relay/issues/3');
      assert.equal(gh.author, 'alice');
      assert.equal(gh.content, 'body 3');
      assert.ok(gh.fetched_at);
      assert.equal(gh.metadata.sourceCreatedAt.toISOString?.() ?? gh.metadata.sourceCreatedAt, new Date(2026, 0, 3).toISOString());
      assert.equal(gh.metadata.providerMetadata.number, 3);
      const d = pack.documents.find((x) => x.filename === 'handoff.txt');
      assert.equal(d.extracted_text, 'Sprint handoff\nOwner: Alice');
      assert.equal(d.mime_type, 'text/plain');
    });
    it('KNOWN GAP (Person 3): content_type ignores metadata.contentType, so markdown reports as text/plain', async () => {
      const pack = await buildProjectContextPack(String(project._id));
      const gh = pack.sources.find((s) => s.external_id === 'I_3');
      assert.equal(gh.metadata.contentType, 'text/markdown', 'the true content type is available in metadata');
      // Documents the current behaviour so a fix in contextBuilder.js is noticed (this assertion should then be flipped).
      assert.equal(gh.content_type, 'text/plain');
    });
  });

  describe('KNOWN CONFLICT: GET /source-records is shadowed by routes/projects.js (Person 2)', () => {
    it('member-level, different envelope, and returns full content: documented, to be resolved by Person 2', async () => {
      const viewerRes = await get(`/api/projects/${project._id}/source-records`, viewer);
      assert.equal(viewerRes.status, 403, 'projects.js requires member; the ingestion handler allows viewer');
      const r = await get(`/api/projects/${project._id}/source-records?limit=1`, member);
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.sourceRecords), 'projects.js envelope, not { items, pagination }');
      assert.ok('content' in r.body.sourceRecords[0], 'full content is returned in a list');
      // Flip these assertions once Person 2 removes or reorders the duplicate route.
    });
  });

  describe('x-user-id bypass', () => {
    it('is a known open issue owned by Person 2 (see README); regression test lives with the fix', { todo: 'requireAuth still accepts x-user-id without a bearer token in every environment' });
  });
});
