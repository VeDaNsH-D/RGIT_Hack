/** Repository listing + project association on the real app + disposable MongoDB; GitHub is mocked. */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { startMongo, stopMongo, resetCollections } from './harness.js';

await startMongo();
const { app } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { resetGitHubAppAuth } = await import('../../src/services/githubRepositoryService.js');
const { User, Project, ProjectMembership, GitHubInstallation, SourceConnection } = await import('../../src/models/index.js');

const realFetch = globalThis.fetch;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const J = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const repo = (id, name, priv = false) => ({ id, name, full_name: `acme/${name}`, owner: { login: 'acme' }, private: priv, default_branch: 'main', html_url: `https://github.com/acme/${name}`, description: null });
const REPOS = [repo(101, 'relay'), repo(102, 'secret-api', true), repo(103, 'website')];

describe('GitHub repository selection and project association', () => {
  let server, base, alice, bob, carol, gh;
  const tok = (u) => `Bearer ${signAuthToken(u)}`;
  const call = async (method, path, user, body) => {
    const res = await realFetch(`${base}${path}`, { method, headers: { ...(user ? { Authorization: tok(user) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json, text };
  };

  before(async () => {
    Object.assign(config.githubApp, { appId: '5283491', privateKey, appSlug: 'nodetorious1', clientId: 'cid', clientSecret: 'cs', enabled: true });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => (String(url).includes('api.github.com') ? gh(String(url), init) : realFetch(url, init));
  });
  after(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); await stopMongo(); });
  beforeEach(async () => {
    await resetCollections();
    resetGitHubAppAuth();
    alice = await User.create({ email: 'a@example.com', name: 'Alice' });
    bob = await User.create({ email: 'b@example.com', name: 'Bob' });
    carol = await User.create({ email: 'c@example.com', name: 'Carol' }); // never connected GitHub
    await GitHubInstallation.create({ userId: alice._id, installationId: 777, accountLogin: 'acme', accountType: 'Organization', connectedAt: new Date() });
    await GitHubInstallation.create({ userId: bob._id, installationId: 888, accountLogin: 'bobco', accountType: 'Organization', connectedAt: new Date() });
    const json = (d, s = 200) => J(d, s);
    gh = (u) => {
      if (u.endsWith('/app/installations/777/access_tokens')) return json({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
      if (u.endsWith('/app/installations/888/access_tokens')) return json({ token: 'ghs_y', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
      if (u.includes('/installation/repositories')) return json({ total_count: 3, repositories: REPOS });
      return json({ message: 'Not Found' }, 404);
    };
  });
  const create = (user, extra = {}) => call('POST', '/api/projects', user, { name: 'Launch', description: 'd', ...extra });

  it('requires authentication to list repositories', async () => {
    assert.equal((await call('GET', '/api/connections/github/repositories')).status, 401);
  });

  it('lists accessible repositories for a connected user without leaking internals', async () => {
    const r = await call('GET', '/api/connections/github/repositories', alice);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.repositories.map((x) => x.fullName), ['acme/relay', 'acme/secret-api', 'acme/website']);
    const secret = r.body.repositories.find((x) => x.id === 102);
    assert.equal(secret.isPrivate, true); assert.equal(secret.owner, 'acme');
    assert.doesNotMatch(r.text, /ghs_|installationId|777|token/i);
  });

  it('supports search and pagination', async () => {
    assert.deepEqual((await call('GET', '/api/connections/github/repositories?q=WEB', alice)).body.repositories.map((x) => x.id), [103]);
    const p = (await call('GET', '/api/connections/github/repositories?perPage=2&page=2', alice)).body;
    assert.equal(p.repositories.length, 1); assert.equal(p.total, 3); assert.equal(p.hasMore, false);
  });

  it('reports connected:false for a user without an installation', async () => {
    const r = await call('GET', '/api/connections/github/repositories', carol);
    assert.equal(r.status, 200); assert.equal(r.body.connected, false); assert.deepEqual(r.body.repositories, []);
  });

  it('maps GitHub failures and suspended installations to clear errors', async () => {
    gh = () => new Response('{}', { status: 500 });
    assert.equal((await call('GET', '/api/connections/github/repositories', alice)).body.error, 'github_unavailable');
    resetGitHubAppAuth();
    gh = () => J({ message: 'This installation has been suspended' }, 403);
    const r = await call('GET', '/api/connections/github/repositories', alice);
    assert.equal(r.status, 409); assert.equal(r.body.error, 'installation_unavailable');
  });

  it('creates a project without a repository exactly as before', async () => {
    const r = await create(carol);
    assert.equal(r.status, 201); assert.equal(r.body.integrations, undefined);
    assert.equal(await SourceConnection.countDocuments(), 0);
    assert.equal(await ProjectMembership.countDocuments({ projectId: r.body.project.id, role: 'owner' }), 1);
  });

  it('creates a project with a valid repository and persists the association', async () => {
    const r = await create(alice, { integrations: { github: { repositoryId: 101 } } });
    assert.equal(r.status, 201);
    assert.equal(r.body.integrations.github.status, 'connected');
    assert.equal(r.body.integrations.github.repository.fullName, 'acme/relay');
    const row = await SourceConnection.findOne({ projectId: r.body.project.id }).lean();
    assert.equal(row.provider, 'github'); assert.equal(row.config.repositoryId, 101);
    assert.equal(row.config.installationId, 777); assert.equal(String(row.connectedBy), String(alice._id));
    const list = await call('GET', `/api/projects/${r.body.project.id}/integrations`, alice);
    assert.equal(list.body.integrations.github[0].repository.id, 101);
    assert.doesNotMatch(list.text, /777|installation/i);
  });

  it('rejects an inaccessible repository and creates no project', async () => {
    const r = await create(alice, { integrations: { github: { repositoryId: 999 } } });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'repository_not_accessible');
    assert.equal(await Project.countDocuments(), 0);
  });

  it("cannot link a repository from another user's installation, or without GitHub connected", async () => {
    const prev = gh; // bob's installation (token ghs_y) additionally sees a private repo that alice's does not
    gh = (u, init) => (u.includes('/installation/repositories') && String(init?.headers?.Authorization).includes('ghs_y') ? J({ total_count: 1, repositories: [repo(500, 'bob-private', true)] }) : prev(u, init));
    assert.equal((await create(alice, { integrations: { github: { repositoryId: 500 } } })).status, 403);
    assert.equal((await create(carol, { integrations: { github: { repositoryId: 101 } } })).body.error, 'github_not_connected');
    assert.equal(await Project.countDocuments(), 0);
  });

  it('validates the request shape strictly', async () => {
    assert.equal((await create(alice, { integrations: { github: { repositoryId: '101' } } })).status, 400);
    assert.equal((await create(alice, { integrations: { github: { repositoryId: 101, installationId: 888 } } })).status, 400);
    assert.equal((await create(alice, { integrations: { slack: {} } })).status, 400);
  });

  it('reports a failed association instead of claiming success', async () => {
    const orig = SourceConnection.create;
    SourceConnection.create = async () => { throw new Error('boom'); };
    try {
      const r = await create(alice, { integrations: { github: { repositoryId: 101 } } });
      assert.equal(r.status, 201);
      assert.equal(r.body.integrations.github.status, 'failed');
      assert.equal(await Project.countDocuments(), 1);
    } finally { SourceConnection.create = orig; }
  });

  it('supports several repositories per project, rejects duplicates, and allows reuse across projects', async () => {
    const { project } = (await create(alice, { integrations: { github: { repositoryId: 101 } } })).body;
    assert.equal((await call('POST', `/api/projects/${project.id}/integrations/github`, alice, { repositoryId: 103 })).status, 201);
    const dup = await call('POST', `/api/projects/${project.id}/integrations/github`, alice, { repositoryId: 101 });
    assert.equal(dup.status, 409); assert.equal(dup.body.error, 'already_connected');
    assert.equal(await SourceConnection.countDocuments({ projectId: project.id }), 2);
    const other = (await create(alice, { integrations: { github: { repositoryId: 101 } } })).body;
    assert.equal(other.integrations.github.status, 'connected');
  });

  it('enforces project authorization when linking after creation', async () => {
    const { project } = (await create(alice)).body;
    assert.equal((await call('POST', `/api/projects/${project.id}/integrations/github`, null, { repositoryId: 101 })).status, 401);
    assert.equal((await call('POST', `/api/projects/${project.id}/integrations/github`, bob, { repositoryId: 101 })).status, 404); // non-member
    await ProjectMembership.create({ projectId: project.id, userId: bob._id, role: 'member', invitedBy: alice._id });
    assert.equal((await call('POST', `/api/projects/${project.id}/integrations/github`, bob, { repositoryId: 101 })).status, 403); // not owner
    assert.equal((await call('GET', `/api/projects/${project.id}/integrations`, carol)).status, 404);
    assert.equal(await SourceConnection.countDocuments(), 0);
  });

  it('lists none, then persisted connections that survive a re-read, with real timestamps and no fake sync data', async () => {
    const { project } = (await create(alice)).body;
    assert.deepEqual((await call('GET', `/api/projects/${project.id}/integrations`, alice)).body.integrations.github, []);
    await call('POST', `/api/projects/${project.id}/integrations/github`, alice, { repositoryId: 101 });
    await call('POST', `/api/projects/${project.id}/integrations/github`, alice, { repositoryId: 102 });
    const list = (await call('GET', `/api/projects/${project.id}/integrations`, alice)).body.integrations.github;
    assert.deepEqual(list.map((c) => c.repository.fullName), ['acme/relay', 'acme/secret-api']);
    assert.equal(list[1].repository.isPrivate, true);
    assert.ok(!Number.isNaN(Date.parse(list[0].connectedAt))); assert.equal(list[0].sync.status, 'pending'); assert.equal(list[0].sync.lastSuccessAt, null); assert.equal(list[0].stats.state, 'not_synced'); assert.equal(list[0].stats.openIssues, null);
  });

  it('removes only the association, with owner-only authorization', async () => {
    const { project } = (await create(alice, { integrations: { github: { repositoryId: 101 } } })).body;
    const other = (await create(alice, { integrations: { github: { repositoryId: 101 } } })).body.project;
    const [{ id }] = (await call('GET', `/api/projects/${project.id}/integrations`, alice)).body.integrations.github;
    const url = `/api/projects/${project.id}/integrations/github/${id}`;
    assert.equal((await call('DELETE', url)).status, 401);
    assert.equal((await call('DELETE', url, bob)).status, 404); // non-member
    await ProjectMembership.create({ projectId: project.id, userId: bob._id, role: 'member', invitedBy: alice._id });
    assert.equal((await call('DELETE', url, bob)).status, 403);
    assert.equal((await call('DELETE', `/api/projects/${other.id}/integrations/github/${id}`, alice)).status, 404); // other project's id scope
    assert.equal((await call('DELETE', `/api/projects/${project.id}/integrations/github/nope`, alice)).status, 400);
    assert.equal((await call('DELETE', url, alice)).status, 200);
    assert.equal((await call('DELETE', url, alice)).status, 404);
    assert.equal(await Project.countDocuments({ _id: project.id }), 1);
    assert.equal(await SourceConnection.countDocuments({ projectId: other.id }), 1);
  });
});
