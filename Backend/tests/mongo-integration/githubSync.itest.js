/** Sync engine, activity/stats APIs, locking and authorization: real app + disposable MongoDB; GitHub mocked. */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { startMongo, stopMongo, resetCollections } from './harness.js';

await startMongo();
const { app } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { resetGitHubAppAuth } = await import('../../src/services/githubRepositoryService.js');
const { resetSyncAuth, LOCK_TTL_MS } = await import('../../src/services/githubSyncEngine.js');
const { User, Project, ProjectMembership, GitHubInstallation, SourceConnection, SourceRecord, GitHubWebhookDelivery } = await import('../../src/models/index.js');

after(async () => { await stopMongo(); });
const realFetch = globalThis.fetch;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const J = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const user = (login) => ({ login, id: login.length, node_id: `U_${login}` });
const REPO = { id: 101, node_id: 'R_101', name: 'relay', full_name: 'acme/relay', owner: user('acme'), private: false, default_branch: 'main', html_url: 'https://github.com/acme/relay', description: 'Relay', updated_at: '2026-01-02T00:00:00Z', created_at: '2025-01-01T00:00:00Z' };
const issue = (n, state = 'open', extra = {}) => ({ id: 1000 + n, node_id: `I_${n}`, number: n, title: `Issue ${n}`, body: `Body ${n}`, state, user: user('alice'), labels: [{ name: 'bug' }], assignees: [user('bob')], created_at: '2026-01-01T00:00:00Z', updated_at: `2026-01-0${n}T00:00:00Z`, html_url: `https://github.com/acme/relay/issues/${n}`, ...extra });
const pr = (n, state = 'open', extra = {}) => ({ id: 2000 + n, node_id: `PR_${n}`, number: n, title: `PR ${n}`, body: `PR body ${n}`, state, draft: false, user: user('carol'), requested_reviewers: [user('dave')], assignees: [], labels: [], created_at: '2026-01-03T00:00:00Z', updated_at: `2026-01-0${n}T00:00:00Z`, html_url: `https://github.com/acme/relay/pull/${n}`, head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) }, ...extra });
const commit = (sha, msg) => ({ sha, node_id: `C_${sha.slice(0, 4)}`, html_url: `https://github.com/acme/relay/commit/${sha}`, commit: { message: msg, author: { name: 'Alice', email: 'a@x.test', date: '2026-01-05T00:00:00Z' }, committer: { name: 'Alice', date: '2026-01-05T00:00:00Z' } }, author: user('alice'), parents: [] });

describe('GitHub sync engine and activity APIs', () => {
  let server, base, alice, bob, viewer, project, connection, gh, calls;
  const tok = (u) => `Bearer ${signAuthToken(u)}`;
  const call = async (method, path, u) => {
    const res = await realFetch(`${base}${path}`, { method, headers: u ? { Authorization: tok(u) } : {} });
    const text = await res.text(); let body = null; try { body = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body, text };
  };
  const syncUrl = () => `/api/projects/${project._id}/integrations/github/${connection._id}/sync`;
  const state = { issues: [], pulls: [], commits: [], repo: REPO, repoStatus: 200 };

  before(async () => {
    Object.assign(config.githubApp, { appId: '5283491', privateKey, appSlug: 'x', clientId: 'c', clientSecret: 's', enabled: true });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => (String(url).includes('api.github.com') ? gh(new URL(String(url)), init) : realFetch(url, init));
  });
  after(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); });
  beforeEach(async () => {
    await resetCollections(); resetGitHubAppAuth(); resetSyncAuth();
    Object.assign(state, { issues: [issue(1), issue(2, 'closed'), { ...issue(7), pull_request: { url: 'x' } }], pulls: [pr(7), pr(8, 'closed', { merged_at: '2026-01-06T00:00:00Z' })], commits: [commit('a'.repeat(40), 'Add feature\n\ndetails')], repo: REPO, repoStatus: 200 });
    calls = [];
    alice = await User.create({ email: 'a@example.com', name: 'Alice' });
    bob = await User.create({ email: 'b@example.com', name: 'Bob' });
    viewer = await User.create({ email: 'v@example.com', name: 'Viewer' });
    await GitHubInstallation.create({ userId: alice._id, installationId: 777, accountLogin: 'acme', accountType: 'Organization', connectedAt: new Date() });
    project = await Project.create({ name: 'P', ownerId: alice._id, createdBy: alice._id });
    await ProjectMembership.create({ projectId: project._id, userId: alice._id, role: 'owner', invitedBy: alice._id });
    await ProjectMembership.create({ projectId: project._id, userId: bob._id, role: 'member', invitedBy: alice._id });
    await ProjectMembership.create({ projectId: project._id, userId: viewer._id, role: 'viewer', invitedBy: alice._id });
    connection = await SourceConnection.create({ projectId: project._id, provider: 'github', connectedBy: alice._id, config: { sync: { status: 'pending' }, installationId: 777, repositoryId: 101, owner: 'acme', repo: 'relay', fullName: 'acme/relay', htmlUrl: REPO.html_url, isPrivate: false } });
    gh = (u, init) => {
      calls.push(`${init?.method || 'GET'} ${u.pathname}${u.search}`);
      if (u.pathname.endsWith('/access_tokens')) return J({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
      if (u.pathname === '/repos/acme/relay') return state.repoStatus === 200 ? J(state.repo) : J({ message: 'x' }, state.repoStatus);
      if (u.pathname === '/repos/acme/relay/issues') return J(state.issues);
      if (u.pathname === '/repos/acme/relay/pulls') return J(state.pulls);
      if (u.pathname === '/repos/acme/relay/commits') return J(state.commits);
      return J({ message: 'Not Found' }, 404);
    };
  });

  it('shows pending with no counts before any sync (not a fake zero)', async () => {
    const r = await call('GET', `/api/projects/${project._id}/integrations`, alice);
    const c = r.body.integrations.github[0];
    assert.equal(c.sync.status, 'pending'); assert.equal(c.stats.state, 'not_synced'); assert.equal(c.stats.openIssues, null);
  });

  it('syncs metadata, issues, pull requests and commits, with PRs kept out of issues', async () => {
    const r = await call('POST', syncUrl(), alice);
    assert.equal(r.status, 200);
    const c = r.body.integration.github;
    assert.equal(c.sync.status, 'completed'); assert.ok(c.sync.lastSuccessAt);
    assert.equal(c.stats.state, 'ready'); assert.equal(c.stats.openIssues, 1); assert.equal(c.stats.openPullRequests, 1);
    const types = await SourceRecord.aggregate([{ $match: { projectId: project._id } }, { $group: { _id: '$type', n: { $sum: 1 } } }]);
    assert.deepEqual(Object.fromEntries(types.map((t) => [t._id, t.n])), { repository: 1, issue: 2, pull_request: 2, commit: 1 });
    const rec = await SourceRecord.findOne({ type: 'issue' }).lean();
    assert.equal(rec.metadata.providerMetadata.repositoryId, 101);
    assert.equal(rec.metadata.providerMetadata.repositoryFullName, 'acme/relay');
    assert.doesNotMatch(r.text, /ghs_|access_token|BEGIN/i);
  });

  it('is idempotent and updates changed records without duplicating', async () => {
    await call('POST', syncUrl(), alice);
    const before = await SourceRecord.countDocuments();
    state.issues = [issue(1, 'closed', { title: 'Issue 1 (renamed)' }), issue(3)];
    const r = await call('POST', syncUrl(), alice);
    assert.equal(r.body.integration.github.sync.status, 'completed');
    assert.equal(await SourceRecord.countDocuments(), before + 1);
    assert.equal((await SourceRecord.findOne({ title: 'Issue 1 (renamed)' }).lean()).metadata.providerMetadata.state, 'closed');
    assert.equal(r.body.integration.github.stats.openIssues, 1); // issue 3 only; issue 1 closed
  });

  it('uses an incremental window after a completed sync and a full fetch otherwise', async () => {
    await call('POST', syncUrl(), alice);
    assert.ok(!calls.some((c) => c.includes('/issues') && c.includes('since=')));
    calls.length = 0;
    await call('POST', syncUrl(), alice);
    assert.ok(calls.some((c) => c.includes('/issues') && c.includes('since=')));
  });

  it('reports failure honestly and keeps earlier data and counts marked stale', async () => {
    await call('POST', syncUrl(), alice);
    state.repoStatus = 403;
    const r = await call('POST', syncUrl(), alice);
    const c = r.body.integration.github;
    assert.equal(c.sync.status, 'failed'); assert.equal(c.sync.errors[0].code, 'FORBIDDEN');
    assert.ok(c.sync.lastSuccessAt);
    assert.equal(c.stats.state, 'stale'); assert.equal(c.stats.openIssues, 1);
    assert.doesNotMatch(r.text, /ghs_|stack|at /);
  });

  it('marks a partial sync as partial rather than successful', async () => {
    gh = ((orig) => (u, i) => (u.pathname.endsWith('/commits') ? J({ message: 'boom' }, 500) : orig(u, i)))(gh);
    const c = (await call('POST', syncUrl(), alice)).body.integration.github;
    assert.equal(c.sync.status, 'partial'); assert.equal(c.sync.lastSuccessAt, null);
    assert.equal(c.stats.state, 'stale');
  });

  it('fails clearly for a deleted repository, an unavailable installation, and rate limits', async () => {
    state.repoStatus = 404;
    assert.equal((await call('POST', syncUrl(), alice)).body.integration.github.sync.errors[0].code, 'NOT_FOUND');
    state.repoStatus = 200;
    await GitHubInstallation.updateMany({}, { status: 'suspended' });
    const c = (await call('POST', syncUrl(), alice)).body.integration.github;
    assert.equal(c.sync.status, 'failed'); assert.equal(c.sync.errors[0].code, 'INSTALLATION_UNAVAILABLE');
    await GitHubInstallation.updateMany({}, { status: 'active' });
    gh = ((orig) => (u, i) => (u.pathname === '/repos/acme/relay' ? new Response('{"message":"rate limit"}', { status: 403, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' } }) : orig(u, i)))(gh);
    assert.equal((await call('POST', syncUrl(), alice)).body.integration.github.sync.errors[0].code, 'RATE_LIMITED');
  });

  it('prevents concurrent syncs, recovers abandoned locks, and ignores stale run completions', async () => {
    await SourceConnection.updateOne({ _id: connection._id }, { $set: { 'config.sync.status': 'syncing', 'config.sync.runId': 'other', 'config.sync.lockedAt': new Date() } });
    const busy = await call('POST', syncUrl(), alice);
    assert.equal(busy.status, 409); assert.equal(busy.body.error, 'sync_in_progress');
    assert.equal((await call('GET', `/api/projects/${project._id}/integrations`, alice)).body.integrations.github[0].sync.status, 'syncing');
    await SourceConnection.updateOne({ _id: connection._id }, { $set: { 'config.sync.lockedAt': new Date(Date.now() - LOCK_TTL_MS - 1000) } });
    assert.equal((await call('GET', `/api/projects/${project._id}/integrations`, alice)).body.integrations.github[0].sync.status, 'failed');
    assert.equal((await call('POST', syncUrl(), alice)).body.integration.github.sync.status, 'completed');
    // A late finish from a dead run must not overwrite the newer completed state.
    const { SourceConnection: SC } = await import('../../src/models/index.js');
    const res = await SC.findOneAndUpdate({ _id: connection._id, 'config.sync.runId': 'other' }, { $set: { 'config.sync.status': 'failed' } });
    assert.equal(res, null);
    assert.equal((await SC.findById(connection._id).lean()).config.sync.status, 'completed');
  });

  it('enforces roles: viewers cannot sync, non-members and outsiders get 404, unauthenticated 401', async () => {
    assert.equal((await call('POST', syncUrl())).status, 401);
    assert.equal((await call('POST', syncUrl(), viewer)).status, 403);
    const outsider = await User.create({ email: 'o@example.com', name: 'O' });
    assert.equal((await call('POST', syncUrl(), outsider)).status, 404);
    assert.equal((await call('POST', syncUrl(), bob)).status, 200); // members may sync
  });

  it('refuses a connection id from another project', async () => {
    const other = await Project.create({ name: 'Other', ownerId: alice._id, createdBy: alice._id });
    await ProjectMembership.create({ projectId: other._id, userId: alice._id, role: 'owner', invitedBy: alice._id });
    assert.equal((await call('POST', `/api/projects/${other._id}/integrations/github/${connection._id}/sync`, alice)).status, 404);
  });

  it('serves paginated, project-scoped activity with GitHub links and no leakage across projects', async () => {
    await call('POST', syncUrl(), alice);
    const otherProject = await Project.create({ name: 'Other', ownerId: bob._id, createdBy: bob._id });
    await ProjectMembership.create({ projectId: otherProject._id, userId: bob._id, role: 'owner', invitedBy: bob._id });
    await SourceRecord.create({ projectId: otherProject._id, provider: 'github', externalId: 'leak', type: 'issue', title: 'SECRET other project', metadata: { providerMetadata: { state: 'open', repositoryId: 101 } } });
    const issues = (await call('GET', `/api/projects/${project._id}/github/activity?kind=issues`, viewer)).body;
    assert.deepEqual(issues.items.map((i) => i.number), [1]);
    assert.equal(issues.items[0].url, 'https://github.com/acme/relay/issues/1'); assert.deepEqual(issues.items[0].assignees, ['bob']);
    const all = await call('GET', `/api/projects/${project._id}/github/activity?kind=issues&state=all`, viewer);
    assert.doesNotMatch(all.text, /SECRET/); assert.equal(all.body.total, 2);
    const pulls = (await call('GET', `/api/projects/${project._id}/github/activity?kind=pulls&state=all&limit=1&page=2`, viewer)).body;
    assert.equal(pulls.items.length, 1); assert.equal(pulls.hasMore, false); assert.equal(pulls.total, 2);
    const commits = (await call('GET', `/api/projects/${project._id}/github/activity?kind=commits`, viewer)).body;
    assert.equal(commits.items[0].sha, 'aaaaaaa'); assert.doesNotMatch(JSON.stringify(commits), /a@x\.test/);
    assert.equal((await call('GET', `/api/projects/${project._id}/github/activity?kind=nope`, viewer)).status, 400);
    assert.equal((await call('GET', `/api/projects/${project._id}/github/activity?kind=issues`, await User.create({ email: 'z@example.com', name: 'Z' }))).status, 404);
  });

  it('reports a genuine zero after a successful sync of an empty repository', async () => {
    Object.assign(state, { issues: [], pulls: [], commits: [] });
    const c = (await call('POST', syncUrl(), alice)).body.integration.github;
    assert.equal(c.stats.state, 'ready'); assert.equal(c.stats.openIssues, 0); assert.equal(c.stats.openPullRequests, 0);
  });
});

describe('GitHub webhooks', () => {
  let server, base, alice, project, connection;
  const SECRET = 'whsec_test';
  const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const post = (payload, { event = 'push', id = 'd-1', secret = SECRET, signature } = {}) => {
    const body = JSON.stringify(payload);
    return realFetch(`${base}/api/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': id, ...(signature !== null ? { 'x-hub-signature-256': signature ?? sign(body, secret) } : {}) }, body });
  };
  before(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => (String(url).includes('api.github.com') ? Promise.resolve(J({ message: 'offline in test' }, 500)) : realFetch(url, init));
  });
  after(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); });
  beforeEach(async () => {
    await resetCollections(); resetGitHubAppAuth(); resetSyncAuth();
    config.githubApp.webhookSecret = SECRET;
    alice = await User.create({ email: 'a@example.com', name: 'Alice' });
    project = await Project.create({ name: 'P', ownerId: alice._id, createdBy: alice._id });
    connection = await SourceConnection.create({ projectId: project._id, provider: 'github', connectedBy: alice._id, config: { sync: { status: 'completed' }, installationId: 777, repositoryId: 101, owner: 'acme', repo: 'relay', fullName: 'acme/relay' } });
  });
  const payload = { repository: { id: 101 }, installation: { id: 777 } };

  it('is disabled without a configured secret', async () => {
    config.githubApp.webhookSecret = '';
    assert.equal((await post(payload)).status, 503);
  });
  it('rejects missing, malformed, and wrong signatures without side effects', async () => {
    assert.equal((await post(payload, { signature: null })).status, 401);
    assert.equal((await post(payload, { signature: 'sha256=zz' })).status, 401);
    assert.equal((await post(payload, { secret: 'other' })).status, 401);
    assert.equal(await GitHubWebhookDelivery.countDocuments(), 0);
    assert.equal((await SourceConnection.findById(connection._id).lean()).config.sync.staleAt, undefined);
  });
  it('accepts a signed push, marks only matching connections stale, and de-duplicates the delivery', async () => {
    assert.equal((await post(payload)).status, 202);
    await new Promise((r) => setTimeout(r, 150));
    const row = await SourceConnection.findById(connection._id).lean();
    assert.ok(row.config.sync.staleAt || row.config.sync.status === 'failed'); // background sync (mocked offline) already attempted
    const again = await post(payload);
    assert.equal(again.status, 200); assert.equal((await again.json()).duplicate, true);
    const unrelated = await post({ repository: { id: 999 }, installation: { id: 777 } }, { id: 'd-2' });
    assert.equal((await unrelated.json()).connections, 0);
    const wrongInstall = await post({ repository: { id: 101 }, installation: { id: 1 } }, { id: 'd-3' });
    assert.equal((await wrongInstall.json()).connections, 0);
  });
  it('suspends a deleted installation', async () => {
    await GitHubInstallation.create({ userId: alice._id, installationId: 777, accountLogin: 'acme', accountType: 'Organization', connectedAt: new Date() });
    assert.equal((await post({ action: 'deleted', installation: { id: 777 } }, { event: 'installation', id: 'd-9' })).status, 202);
    assert.equal((await GitHubInstallation.findOne({ installationId: 777 }).lean()).status, 'suspended');
  });
});
