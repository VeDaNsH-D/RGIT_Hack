/** Owner-only project deletion on the real app + disposable MongoDB. */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMongo, stopMongo, resetCollections } from './harness.js';

await startMongo();
const { app } = await import('../../src/app.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { User, Project, ProjectMembership, SourceConnection } = await import('../../src/models/index.js');
const realFetch = globalThis.fetch;

describe('project deletion', () => {
  let server, base, owner, member, task;
  const tok = (u) => `Bearer ${signAuthToken(u)}`;
  const call = async (method, path, user) => { const r = await realFetch(`${base}${path}`, { method, headers: user ? { Authorization: tok(user) } : {} }); return { status: r.status }; };
  before(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((r) => server.close(r)); await stopMongo(); });
  beforeEach(async () => {
    await resetCollections();
    owner = await User.create({ email: 'o@example.com', name: 'Owner' });
    member = await User.create({ email: 'm@example.com', name: 'Member' });
  });
  async function seed() {
    const p = await Project.create({ name: 'P', ownerId: owner._id, createdBy: owner._id });
    const q = await Project.create({ name: 'Other', ownerId: owner._id, createdBy: owner._id });
    for (const x of [p, q]) {
      await ProjectMembership.create({ projectId: x._id, userId: owner._id, role: 'owner', invitedBy: owner._id });
      await SourceConnection.create({ projectId: x._id, provider: 'github', connectedBy: owner._id, config: { repositoryId: 1 } });
    }
    await ProjectMembership.create({ projectId: p._id, userId: member._id, role: 'member', invitedBy: owner._id });
    return { p, q };
  }
  it('requires authentication and owner role, and deletes nothing otherwise', async () => {
    const { p } = await seed();
    assert.equal((await call('DELETE', `/api/projects/${p._id}`)).status, 401);
    assert.equal((await call('DELETE', `/api/projects/${p._id}`, member)).status, 403);
    assert.equal((await call('DELETE', `/api/projects/${new (await import('mongoose')).default.Types.ObjectId()}`, owner)).status, 404);
    assert.equal(await Project.countDocuments(), 2);
  });
  it('deletes the project and its data, leaving other projects intact', async () => {
    const { p, q } = await seed();
    assert.equal((await call('DELETE', `/api/projects/${p._id}`, owner)).status, 200);
    assert.equal(await Project.countDocuments({ _id: p._id }), 0);
    assert.equal(await ProjectMembership.countDocuments({ projectId: p._id }), 0);
    assert.equal(await SourceConnection.countDocuments({ projectId: p._id }), 0);
    assert.equal(await Project.countDocuments({ _id: q._id }), 1);
    assert.equal(await SourceConnection.countDocuments({ projectId: q._id }), 1);
    assert.equal((await call('GET', `/api/projects/${p._id}`, owner)).status, 404);
  });
});
