/** Task -> GitHub issue creation, repository selection, retry and reconciliation: real app + disposable MongoDB; GitHub mocked. */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { startMongo, stopMongo, resetCollections } from './harness.js';

await startMongo();
const { app } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { resetSyncAuth } = await import('../../src/services/githubSyncEngine.js');
const { resetGitHubAppAuth } = await import('../../src/services/githubRepositoryService.js');
const { issueMarker } = await import('../../src/services/githubIssueSync.js');
const { User, Project, ProjectMembership, GitHubInstallation, SourceConnection, Task } = await import('../../src/models/index.js');

const realFetch = globalThis.fetch;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const J = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const REPOS = { 101: 'backend-service', 102: 'frontend-app', 103: 'infrastructure', 201: 'other-project-repo' };

describe('task creation with GitHub issues', () => {
  let server, base, alice, bob, viewer, outsider, project, other, conns, gh, issues, posts, labels, failPost, afterPost;
  const tok = (u) => `Bearer ${signAuthToken(u)}`;
  const call = async (method, path, user, body) => {
    const res = await realFetch(`${base}${path}`, { method, headers: { ...(user ? { Authorization: tok(user) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json, text };
  };
  const link = (proj, id, installationId = 777) => SourceConnection.create({ projectId: proj._id, provider: 'github', connectedBy: alice._id, config: { installationId, repositoryId: id, owner: 'acme', repo: REPOS[id], fullName: `acme/${REPOS[id]}`, htmlUrl: `https://github.com/acme/${REPOS[id]}`, isPrivate: false } });
  const newTask = (user, body, proj = project) => call('POST', `/api/projects/${proj._id}/tasks`, user, { title: 'Fix login', description: 'Details', priority: 'high', ...body });

  before(async () => {
    Object.assign(config.githubApp, { appId: '5283491', privateKey, appSlug: 'x', clientId: 'cid', clientSecret: 'cs', enabled: true });
    config.frontendUrl = 'https://relay.example';
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => (String(url).includes('api.github.com') ? gh(String(url), init) : realFetch(url, init));
  });
  after(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); await stopMongo(); });

  beforeEach(async () => {
    await resetCollections(); resetGitHubAppAuth(); resetSyncAuth();
    alice = await User.create({ email: 'a@example.com', name: 'Alice' });
    bob = await User.create({ email: 'b@example.com', name: 'Bob' });
    viewer = await User.create({ email: 'v@example.com', name: 'Vi' });
    outsider = await User.create({ email: 'o@example.com', name: 'Out' });
    project = await Project.create({ name: 'P', ownerId: alice._id, createdBy: alice._id });
    other = await Project.create({ name: 'Other', ownerId: bob._id, createdBy: bob._id });
    await ProjectMembership.create({ projectId: project._id, userId: alice._id, role: 'owner', invitedBy: alice._id });
    await ProjectMembership.create({ projectId: project._id, userId: bob._id, role: 'member', invitedBy: alice._id });
    await ProjectMembership.create({ projectId: project._id, userId: viewer._id, role: 'viewer', invitedBy: alice._id });
    await ProjectMembership.create({ projectId: other._id, userId: bob._id, role: 'owner', invitedBy: bob._id });
    await GitHubInstallation.create({ userId: alice._id, installationId: 777, accountLogin: 'acme', accountType: 'Organization', connectedAt: new Date() });
    conns = {};
    issues = {}; posts = []; labels = ['bug', 'priority: high']; failPost = null; afterPost = null;
    gh = async (u, init = {}) => {
      const { pathname, searchParams } = new URL(u);
      const method = init.method || 'GET';
      if (/\/app\/installations\/\d+\/access_tokens$/.test(pathname)) return J({ token: 'ghs_secret_token_value', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
      let m;
      if ((m = pathname.match(/^\/repositories\/(\d+)$/))) {
        const id = Number(m[1]);
        return REPOS[id] ? J({ id, name: REPOS[id], owner: { login: 'acme' }, html_url: `https://github.com/acme/${REPOS[id]}`, has_issues: true }) : J({ message: 'Not Found' }, 404);
      }
      if ((m = pathname.match(/^\/repos\/acme\/([^/]+)\/labels$/))) return J(labels.map((name) => ({ name })));
      if ((m = pathname.match(/^\/repos\/acme\/([^/]+)\/issues$/))) {
        const repo = m[1];
        issues[repo] ??= [];
        if (method === 'GET') return J(issues[repo].slice().reverse());
        const body = JSON.parse(init.body);
        posts.push({ repo, body });
        if (failPost && failPost !== 'after') return J({ message: 'boom' }, failPost);
        const n = issues[repo].length + 1;
        issues[repo].push({ number: n, id: 9000 + n, title: body.title, body: body.body, html_url: `https://github.com/acme/${repo}/issues/${n}` });
        if (failPost === 'after') return J({ message: 'upstream error' }, 502);
        if (afterPost) await afterPost();
        return J(issues[repo][n - 1], 201);
      }
      return J({ message: 'Not Found' }, 404);
    };
  });

  // ---- repository listing -------------------------------------------------------------
  it('lists only the project’s own repositories, with no credentials or installation ids', async () => {
    await link(project, 101); await link(project, 102); await link(other, 201);
    const r = await call('GET', `/api/projects/${project._id}/github/repositories`, alice);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.repositories.map((x) => x.fullName), ['acme/backend-service', 'acme/frontend-app']);
    assert.equal(r.body.repositories[0].available, true);
    assert.doesNotMatch(r.text, /ghs_|installationId|777|token|201/i);
  });
  it('reports no repositories for a project without any', async () => {
    const r = await call('GET', `/api/projects/${project._id}/github/repositories`, alice);
    assert.deepEqual(r.body, { connected: false, repositories: [] });
  });
  it('flags repositories whose installation is suspended', async () => {
    await link(project, 101);
    await GitHubInstallation.updateOne({ installationId: 777 }, { status: 'suspended' });
    assert.equal((await call('GET', `/api/projects/${project._id}/github/repositories`, alice)).body.repositories[0].available, false);
  });
  it('blocks repository enumeration for non-members, viewers and anonymous callers', async () => {
    await link(project, 101);
    const url = `/api/projects/${project._id}/github/repositories`;
    assert.equal((await call('GET', url, outsider)).status, 404);
    assert.equal((await call('GET', url, viewer)).status, 403);
    assert.equal((await call('GET', url)).status, 401);
  });

  // ---- creation -----------------------------------------------------------------------
  it('keeps task creation without GitHub working (no repositories)', async () => {
    const r = await newTask(alice, {});
    assert.equal(r.status, 201);
    assert.equal(r.body.task.github.status, 'not_connected');
    assert.equal(posts.length, 0);
  });
  it('rejects a repository id when the project has no repositories', async () => {
    assert.equal((await newTask(alice, { githubRepositoryId: 101 })).body.error, 'invalid_repository');
    assert.equal(await Task.countDocuments(), 0);
  });
  it('uses the only repository when exactly one exists', async () => {
    await link(project, 101);
    const r = await newTask(alice, { githubRepositoryId: 101 });
    assert.equal(r.status, 201);
    assert.equal(r.body.task.github.status, 'synced');
    assert.equal(r.body.task.github.issueNumber, 1);
    assert.equal(r.body.task.github.issueUrl, 'https://github.com/acme/backend-service/issues/1');
    assert.equal(r.body.task.github.repository.fullName, 'acme/backend-service');
    assert.doesNotMatch(r.text, /ghs_|installationId/);
  });
  it('creates the issue in the SELECTED repository when several exist', async () => {
    await link(project, 101); await link(project, 102); await link(project, 103);
    const r = await newTask(alice, { githubRepositoryId: 102 });
    assert.equal(r.body.task.github.repository.fullName, 'acme/frontend-app');
    assert.deepEqual(posts.map((p) => p.repo), ['frontend-app']);
    const r3 = await newTask(alice, { githubRepositoryId: 103, title: 'Infra' });
    assert.deepEqual(posts.map((p) => p.repo), ['frontend-app', 'infrastructure']);
    assert.equal(r3.body.task.github.issueUrl, 'https://github.com/acme/infrastructure/issues/1');
  });
  it('rejects a missing selection when several repositories exist, without creating a task', async () => {
    await link(project, 101); await link(project, 102);
    const r = await newTask(alice, {});
    assert.equal(r.status, 400); assert.equal(r.body.error, 'repository_required');
    assert.equal(await Task.countDocuments(), 0); assert.equal(posts.length, 0);
  });
  it('lets the user opt out explicitly with a null repository', async () => {
    await link(project, 101); await link(project, 102);
    const r = await newTask(alice, { githubRepositoryId: null });
    assert.equal(r.status, 201); assert.equal(r.body.task.github, null); assert.equal(posts.length, 0);
  });
  it('rejects unknown repository ids and repositories of another project', async () => {
    await link(project, 101); await link(other, 201);
    for (const id of [999, 201]) {
      const r = await newTask(alice, { githubRepositoryId: id });
      assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_repository');
    }
    assert.equal((await newTask(alice, { githubRepositoryId: 'acme/x' })).status, 400);
    assert.equal(await Task.countDocuments(), 0); assert.equal(posts.length, 0);
  });
  it('rejects a repository disconnected after the modal loaded', async () => {
    const c = await link(project, 101); await link(project, 102);
    await SourceConnection.deleteOne({ _id: c._id });
    const r = await newTask(alice, { githubRepositoryId: 101 });
    assert.equal(r.body.error, 'invalid_repository');
    assert.equal(posts.length, 0);
  });
  it('refuses to create the task when the installation is suspended or removed', async () => {
    await link(project, 101);
    await GitHubInstallation.updateOne({ installationId: 777 }, { status: 'suspended' });
    const r = await newTask(alice, { githubRepositoryId: 101 });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'repository_unavailable');
    assert.equal(await Task.countDocuments(), 0); assert.equal(posts.length, 0);
  });
  it('enforces project access and role', async () => {
    await link(project, 101);
    assert.equal((await newTask(outsider, { githubRepositoryId: 101 })).status, 404);
    assert.equal((await newTask(viewer, { githubRepositoryId: 101 })).status, 403);
    assert.equal(posts.length, 0);
  });

  // ---- issue content ------------------------------------------------------------------
  it('maps title, description, priority, due date and a correlation marker into the issue', async () => {
    await link(project, 101);
    const r = await newTask(alice, { githubRepositoryId: 101, deadline: '2026-12-31T23:59:00.000Z' });
    const { body } = posts[0];
    assert.equal(body.title, 'Fix login');
    assert.match(body.body, /Details/); assert.match(body.body, /Priority: high/); assert.match(body.body, /Due: 2026-12-31/);
    assert.match(body.body, /relay\.example\/projects\//);
    assert.ok(body.body.includes(issueMarker(r.body.task.id)));
    assert.deepEqual(body.labels, ['priority: high']);
    assert.equal('assignees' in body, false);
  });
  it('still creates the issue when the priority label does not exist, and never creates labels', async () => {
    labels = ['bug'];
    await link(project, 101);
    const r = await newTask(alice, { githubRepositoryId: 101 });
    assert.equal(r.body.task.github.status, 'synced');
    assert.equal('labels' in posts[0].body, false);
    assert.ok(r.body.task.github.warnings.includes('priority_label_missing'));
  });
  it('creates the issue without an assignee when the teammate has no verified GitHub account', async () => {
    await link(project, 101);
    const r = await newTask(alice, { githubRepositoryId: 101, assignee: String(bob._id) });
    assert.equal(r.body.task.github.status, 'synced');
    assert.ok(r.body.task.github.warnings.includes('assignee_not_mapped'));
    assert.equal('assignees' in posts[0].body, false);
  });

  // ---- failure, retry, duplicates -----------------------------------------------------
  it('keeps the task and records a failure when GitHub creation fails; retry reuses it', async () => {
    await link(project, 101); await link(project, 102);
    failPost = 500;
    const r = await newTask(alice, { githubRepositoryId: 102 });
    assert.equal(r.status, 201);
    assert.equal(r.body.task.github.status, 'failed');
    assert.equal(r.body.task.github.issueUrl, null);
    assert.equal(r.body.task.github.retryable, true);
    assert.equal(await Task.countDocuments(), 1);
    failPost = null;
    const retry = await call('POST', `/api/tasks/${r.body.task.id}/github/retry`, bob);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.task.github.status, 'synced');
    assert.equal(retry.body.task.github.repository.fullName, 'acme/frontend-app');
    assert.equal(await Task.countDocuments(), 1);
    assert.equal(issues['frontend-app'].length, 1);
    assert.equal(issues['backend-service'], undefined);
  });
  it('does not create a second issue when retrying a synced task', async () => {
    await link(project, 101);
    const r = await newTask(alice, { githubRepositoryId: 101 });
    const retry = await call('POST', `/api/tasks/${r.body.task.id}/github/retry`, alice);
    assert.equal(retry.status, 200); assert.equal(issues['backend-service'].length, 1);
  });
  it('adopts an issue GitHub created before an ambiguous failure instead of duplicating it', async () => {
    await link(project, 101);
    failPost = 'after'; // issue is created, but the response is an error
    const r = await newTask(alice, { githubRepositoryId: 101 });
    assert.equal(r.body.task.github.status, 'failed');
    assert.equal(issues['backend-service'].length, 1);
    failPost = null;
    const retry = await call('POST', `/api/tasks/${r.body.task.id}/github/retry`, alice);
    assert.equal(retry.body.task.github.status, 'synced');
    assert.equal(retry.body.task.github.issueNumber, 1);
    assert.equal(issues['backend-service'].length, 1);
    assert.equal(posts.length, 1);
  });
  it('recovers when the issue was created but persisting the reference failed', async () => {
    await link(project, 101);
    const realUpdate = Task.findOneAndUpdate.bind(Task);
    let broke = false;
    Task.findOneAndUpdate = (filter, update, ...rest) => {
      if (!broke && update?.$set?.['github.status'] === 'synced') { broke = true; throw new Error('db write failed'); }
      return realUpdate(filter, update, ...rest);
    };
    let r;
    try { r = await newTask(alice, { githubRepositoryId: 101 }); } finally { Task.findOneAndUpdate = realUpdate; }
    assert.equal(broke, true);
    assert.equal(r.body.task.github.status, 'failed');
    assert.equal(issues['backend-service'].length, 1);
    const retry = await call('POST', `/api/tasks/${r.body.task.id}/github/retry`, alice);
    assert.equal(retry.body.task.github.status, 'synced');
    assert.equal(issues['backend-service'].length, 1);
  });
  it('serializes concurrent retries into a single issue', async () => {
    await link(project, 101);
    failPost = 500;
    const r = await newTask(alice, { githubRepositoryId: 101 });
    failPost = null;
    afterPost = () => new Promise((res) => setTimeout(res, 50));
    const results = await Promise.all([1, 2, 3].map(() => call('POST', `/api/tasks/${r.body.task.id}/github/retry`, alice)));
    assert.equal(issues['backend-service'].length, 1);
    assert.ok(results.some((x) => x.status === 200 && x.body.task.github.status === 'synced'));
    assert.ok(results.every((x) => [200, 409].includes(x.status)));
  });
  it('fails a retry for a removed repository instead of using another one', async () => {
    const c = await link(project, 101); await link(project, 102);
    failPost = 500;
    const r = await newTask(alice, { githubRepositoryId: 101 });
    failPost = null;
    await SourceConnection.deleteOne({ _id: c._id });
    const retry = await call('POST', `/api/tasks/${r.body.task.id}/github/retry`, alice);
    assert.equal(retry.body.task.github.status, 'failed');
    assert.equal(retry.body.task.github.error.code, 'repository_disconnected');
    assert.equal(issues['frontend-app'] ?? 0, 0);
    assert.equal((issues['backend-service'] || []).length, 0);
  });
  it('fails a retry when the installation was suspended meanwhile', async () => {
    await link(project, 101);
    failPost = 500;
    const r = await newTask(alice, { githubRepositoryId: 101 });
    failPost = null;
    await GitHubInstallation.updateOne({ installationId: 777 }, { status: 'suspended' });
    const retry = await call('POST', `/api/tasks/${r.body.task.id}/github/retry`, alice);
    assert.equal(retry.body.task.github.error.code, 'installation_unavailable');
  });
  it('rejects retries from non-members, viewers and tasks without a GitHub link', async () => {
    await link(project, 101);
    failPost = 500;
    const r = await newTask(alice, { githubRepositoryId: 101 });
    failPost = null;
    assert.equal((await call('POST', `/api/tasks/${r.body.task.id}/github/retry`, outsider)).status, 404);
    assert.equal((await call('POST', `/api/tasks/${r.body.task.id}/github/retry`, viewer)).status, 403);
    const local = await newTask(alice, { githubRepositoryId: null, title: 'local' });
    assert.equal((await call('POST', `/api/tasks/${local.body.task.id}/github/retry`, alice)).status, 409);
  });
  it('never leaks tokens in failure state', async () => {
    await link(project, 101);
    failPost = 500;
    const r = await newTask(alice, { githubRepositoryId: 101 });
    assert.doesNotMatch(r.text, /ghs_|Bearer|private key/i);
    assert.doesNotMatch(JSON.stringify((await Task.findById(r.body.task.id).lean()).github), /ghs_/);
  });
  it('exposes the GitHub state in the project context used by the task list', async () => {
    await link(project, 101);
    await newTask(alice, { githubRepositoryId: 101 });
    const ctx = await call('GET', `/api/projects/${project._id}/context`, alice);
    assert.equal(ctx.body.tasks[0].github.status, 'synced');
    assert.equal(ctx.body.tasks[0].github.issueNumber, 1);
  });
});
