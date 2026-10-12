/**
 * Smoke tests through the REAL assembled app (src/app.js), no database.
 * Project/ProjectMembership lookups are mocked; every assertion here is decided
 * before any other collection is touched. DB-backed behaviour is covered by
 * `npm run test:integration` (tests/mongo-integration/app.itest.js).
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';

process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:1/relay-test-unused';
process.env.JWT_SECRET ??= 'test-jwt-secret-that-is-at-least-32-characters';
process.env.CRON_SECRET ??= 'test-cron-secret';

const { app } = await import('../../src/app.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { Project } = await import('../../src/models/Project.js');
const { ProjectMembership } = await import('../../src/models/ProjectMembership.js');

const PROJECT = '665f1c2e8b3a4d0012345678';
const DOC = '665f1c2e8b3a4d00eeeeeeee';
const VIEWER = '665f1c2e8b3a4d00bbbbbbbb';
const OUTSIDER = '665f1c2e8b3a4d00cccccccc';
const token = (id) => signAuthToken({ _id: new mongoose.Types.ObjectId(id) });

describe('real app smoke (no database)', () => {
  let server, base;
  before(async () => {
    mock.method(Project, 'findById', async (id) => (String(id) === PROJECT ? { _id: new mongoose.Types.ObjectId(PROJECT) } : null));
    mock.method(ProjectMembership, 'findOne', async ({ projectId, userId }) =>
      (String(projectId) === PROJECT && String(userId) === VIEWER ? { projectId, userId, role: 'viewer' } : null));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    mock.restoreAll();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const call = async (method, path, user, extra = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: user ? { Authorization: `Bearer ${token(user)}` } : {}, ...extra });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };

  const ROUTES = [
    ['GET', `/api/projects/${PROJECT}/ingestion/source-records`],
    ['GET', `/api/projects/${PROJECT}/source-records/${DOC}`],
    ['GET', `/api/projects/${PROJECT}/documents`],
    ['GET', `/api/projects/${PROJECT}/documents/${DOC}`],
    ['GET', `/api/projects/${PROJECT}/ingestion/status`],
    ['POST', `/api/projects/${PROJECT}/documents`],
    ['POST', `/api/projects/${PROJECT}/documents/${DOC}/reindex`],
  ];

  it('health check works', async () => {
    assert.equal((await call('GET', '/api/health')).status, 200);
  });

  it('every ingestion route is mounted and requires a bearer token (401)', async () => {
    for (const [m, p] of ROUTES) {
      const r = await call(m, p);
      assert.equal(r.status, 401, `${m} ${p}`);
      assert.equal(r.body.error, 'unauthorized');
    }
  });

  it('a garbage bearer token is rejected (401) on every route', async () => {
    for (const [m, p] of ROUTES) {
      const r = await fetch(`${base}${p}`, { method: m, headers: { Authorization: 'Bearer nope' } });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  });

  it('malformed project id -> the established 404 "Project not found" on every route', async () => {
    for (const [m, p] of ROUTES) {
      const r = await call(m, p.replace(PROJECT, 'not-an-id'), VIEWER);
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal(r.body.error, 'not_found');
    }
  });

  it('malformed sub-resource ids -> 400 once membership is established', async () => {
    for (const p of [`/api/projects/${PROJECT}/source-records/zzz`, `/api/projects/${PROJECT}/documents/zzz`]) {
      assert.equal((await call('GET', p, VIEWER)).status, 400, p);
    }
  });

  it('non-members get 404 on reads, upload and reindex', async () => {
    for (const [m, p] of ROUTES) assert.equal((await call(m, p, OUTSIDER)).status, 404, `${m} ${p}`);
  });

  it('viewers are refused (403) on upload and reindex before the body is parsed', async () => {
    assert.equal((await call('POST', `/api/projects/${PROJECT}/documents`, VIEWER)).status, 403);
    assert.equal((await call('POST', `/api/projects/${PROJECT}/documents/${DOC}/reindex`, VIEWER)).status, 403);
  });

  it('unknown routes return the JSON 404 contract', async () => {
    const r = await call('GET', '/api/does-not-exist', VIEWER);
    assert.deepEqual(r.body, { error: 'not_found', message: 'Route not found' });
  });
});
