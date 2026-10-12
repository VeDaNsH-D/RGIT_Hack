/** Repository content analysis: real app + disposable MongoDB; GitHub is mocked. */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { startMongo, stopMongo, resetCollections } from './harness.js';

await startMongo();
const { app } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { resetGitHubAppAuth } = await import('../../src/services/githubRepositoryService.js');
const { resetSyncAuth } = await import('../../src/services/githubSyncEngine.js');
const { LOCK_TTL_MS } = await import('../../src/services/repositoryAnalysisService.js');
const { User, Project, ProjectMembership, GitHubInstallation, SourceConnection, SourceRecord, RepositorySnapshot, RepositoryFile } = await import('../../src/models/index.js');
after(async () => { await stopMongo(); });

const realFetch = globalThis.fetch;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const J = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const sha = (s) => createHash('sha1').update(s).digest('hex');
const FILES = () => ({
  'README.md': '# Relay\n\nA handoff platform.\n\n## Setup\nRun `npm install` then `npm start`.\n\n## Tests\n`npm test`',
  'package.json': JSON.stringify({ name: 'relay', main: 'src/server.js', scripts: { start: 'node src/server.js', test: 'node --test' }, dependencies: { express: '^5', mongoose: '^8' } }),
  'src/server.js': "import routes from './routes/users.js'\napp.use(routes)\nconst port = process.env.PORT\n",
  'src/routes/users.js': "router.get('/api/users', list)\nexport function list() {}\n",
  'src/models/User.js': "export const User = mongoose.model('User', schema)\n",
  '.env': 'JWT_SECRET=supersecretvalue1234567890abc\n',
  '.env.example': 'JWT_SECRET=\nPORT=\n',
  'src/config.js': 'export const key = "ghp_' + 'a'.repeat(36) + '"\n',
  'node_modules/x/index.js': 'module.exports = 1',
  'logo.png': 'binary',
});

describe('repository analysis', () => {
  let server, base, alice, bob, viewer, project, connection, gh, calls, repo;
  const tok = (u) => `Bearer ${signAuthToken(u)}`;
  const call = async (method, path, u, body) => {
    const res = await realFetch(`${base}${path}`, { method, headers: { ...(u ? { Authorization: tok(u) } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json, text };
  };
  const analyzeUrl = () => `/api/projects/${project._id}/integrations/github/${connection._id}/analyze`;
  const status = async (u = alice) => (await call('GET', `/api/projects/${project._id}/repository-knowledge`, u)).body.repositories[0].analysis;
  const state = { files: FILES(), head: 'c1', truncated: false, repoStatus: 200 };
  const treeOf = () => Object.entries(state.files).map(([path, text]) => ({ path, type: 'blob', sha: sha(text), size: text.length }));

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
    Object.assign(config.githubApp.analysis, { maxFiles: 150, maxFileBytes: 100_000, maxTotalBytes: 3_000_000, maxFileChars: 40_000, concurrency: 3 });
    Object.assign(state, { files: FILES(), head: 'c1', truncated: false, repoStatus: 200 });
    calls = [];
    repo = { id: 101, full_name: 'acme/relay', default_branch: 'main', description: 'Relay', private: true };
    alice = await User.create({ email: 'a@example.com', name: 'Alice' });
    bob = await User.create({ email: 'b@example.com', name: 'Bob' });
    viewer = await User.create({ email: 'v@example.com', name: 'Viewer' });
    await GitHubInstallation.create({ userId: alice._id, installationId: 777, accountLogin: 'acme', accountType: 'Organization', connectedAt: new Date() });
    project = await Project.create({ name: 'P', ownerId: alice._id, createdBy: alice._id });
    for (const [u, role] of [[alice, 'owner'], [bob, 'member'], [viewer, 'viewer']]) await ProjectMembership.create({ projectId: project._id, userId: u._id, role, invitedBy: alice._id });
    connection = await SourceConnection.create({ projectId: project._id, provider: 'github', connectedBy: alice._id, config: { sync: { status: 'pending' }, installationId: 777, repositoryId: 101, owner: 'acme', repo: 'relay', fullName: 'acme/relay', isPrivate: true } });
    gh = (u, init) => {
      calls.push(u.pathname + u.search);
      if (u.pathname.endsWith('/access_tokens')) return J({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
      if (u.pathname === '/repos/acme/relay') return state.repoStatus === 200 ? J(repo) : J({ message: 'no' }, state.repoStatus);
      if (u.pathname === '/repos/acme/relay/branches/main') return J({ commit: { sha: `${state.head}`.padEnd(40, '0'), commit: { tree: { sha: `tree-${state.head}` } } } });
      if (u.pathname.startsWith('/repos/acme/relay/git/trees/')) return J({ tree: treeOf(), truncated: state.truncated });
      const m = u.pathname.match(/\/git\/blobs\/(.+)$/);
      if (m) { const entry = Object.entries(state.files).find(([p, t]) => sha(t) === m[1]); return entry ? J({ encoding: 'base64', content: Buffer.from(entry[1]).toString('base64') }) : J({ message: 'x' }, 404); }
      return J({ message: 'Not Found' }, 404);
    };
  });

  it('is not analyzed before the first run', async () => {
    assert.equal((await status()).status, 'not_analyzed');
  });

  it('analyzes the repository, records the commit, and extracts verified knowledge', async () => {
    const r = await call('POST', analyzeUrl(), alice);
    assert.equal(r.status, 200);
    const a = r.body.analysis;
    assert.equal(a.snapshot.commitSha, 'c1'.padEnd(40, '0')); assert.equal(a.snapshot.branch, 'main');
    assert.equal(a.freshness.state, 'current');
    // secret-named file, secret-containing file, dependency dir and binary are all accounted for, none analyzed
    assert.deepEqual(a.snapshot.coverage.excluded, { secret_file: 1, dependency_or_build_dir: 1, binary: 1 });
    assert.equal(a.snapshot.coverage.secretSkipped, 1);
    assert.equal(a.snapshot.status, 'partial'); assert.equal(a.status, 'partial'); // the credential-bearing file was NOT analyzed, so it is not "completed"
    const snap = await RepositorySnapshot.findOne({}).lean();
    const k = snap.knowledge;
    assert.ok(k.routes.some((x) => x.method === 'GET' && x.path === '/api/users' && x.file === 'src/routes/users.js'));
    assert.deepEqual(k.envVariables.map((e) => e.name).sort(), ['JWT_SECRET', 'PORT']);
    assert.equal(k.models[0].name, 'User'); assert.ok(k.entryPoints.includes('src/server.js'));
    assert.deepEqual(k.overview.frameworks.sort(), ['Express', 'Mongoose']);
    assert.ok(k.buildAndTest.some((b) => b.name === 'start')); assert.match(k.setupDocs[0].excerpt, /npm install/);
    const stored = await RepositoryFile.find({}).select('path').lean();
    const paths = stored.map((f) => f.path);
    for (const never of ['.env', 'src/config.js', 'node_modules/x/index.js', 'logo.png']) assert.ok(!paths.includes(never), never);
    assert.ok(!JSON.stringify(snap).includes('supersecretvalue') && !JSON.stringify(stored).includes('ghp_'));
    assert.doesNotMatch(r.text, /ghs_|JWT_SECRET=|export function list/); // the API returns coverage, not file contents
  });

  it('reports a clean repository as completed with 100% coverage', async () => {
    delete state.files['src/config.js'];
    const a = (await call('POST', analyzeUrl(), alice)).body.analysis;
    assert.equal(a.status, 'completed'); assert.equal(a.snapshot.coverage.percent, 100);
    assert.equal(a.snapshot.coverage.analyzed, a.snapshot.coverage.eligible);
  });

  it('never claims complete coverage when the budget, size limit, or tree truncation cut files', async () => {
    delete state.files['src/config.js'];
    Object.assign(config.githubApp.analysis, { maxFiles: 3 });
    state.files['big.js'] = 'x'.repeat(200_000);
    state.truncated = true;
    const a = (await call('POST', analyzeUrl(), alice)).body.analysis;
    const c = a.snapshot.coverage;
    assert.equal(a.status, 'partial'); assert.equal(c.analyzed, 3); assert.ok(c.overBudget > 0); assert.equal(c.tooLarge, 1); assert.equal(c.treeTruncated, true);
    assert.ok(c.percent < 100);
    const snap = await RepositorySnapshot.findOne({}).lean();
    assert.ok(snap.knowledge.limitations.length >= 3);
    const paths = snap.fileManifest.map((f) => f.path);
    assert.ok(paths.includes('README.md') && paths.includes('package.json')); // important files are prioritized
  });

  it('skips unchanged commits, fetches only changed blobs, and reports file-level changes', async () => {
    delete state.files['src/config.js'];
    await call('POST', analyzeUrl(), alice);
    calls.length = 0;
    const same = (await call('POST', analyzeUrl(), alice)).body.analysis;
    assert.equal(same.status, 'completed'); assert.ok(!calls.some((c) => c.includes('/git/trees/') || c.includes('/git/blobs/')));
    // new commit: modify one file, delete one, rename one, add one
    state.head = 'c2';
    state.files['src/server.js'] += '// changed\n';
    delete state.files['src/models/User.js'];
    state.files['src/models/Account.js'] = "export const User = mongoose.model('User', schema)\n"; // same content as deleted file, new path => rename
    state.files['src/new.js'] = 'export const n = 1\n';
    calls.length = 0;
    const a = (await call('POST', analyzeUrl(), alice)).body.analysis;
    assert.equal(a.snapshot.commitSha, 'c2'.padEnd(40, '0')); assert.equal(a.snapshot.mode, 'incremental');
    assert.deepEqual(a.snapshot.changes.added, ['src/new.js']); assert.deepEqual(a.snapshot.changes.modified, ['src/server.js']);
    assert.deepEqual(a.snapshot.changes.renamed, [{ from: 'src/models/User.js', to: 'src/models/Account.js' }]); assert.deepEqual(a.snapshot.changes.deleted, []);
    assert.equal(calls.filter((c) => c.includes('/git/blobs/')).length, 2); // server.js + new.js only (Account.js blob is cached by sha)
    assert.equal(await RepositorySnapshot.countDocuments(), 2);
    assert.ok(!(await RepositoryFile.find({ path: 'src/models/User.js' }).lean()).length); // deleted content is garbage-collected
  });

  it('detects stale knowledge from newer synced commits and push webhooks, and a forced refresh works', async () => {
    delete state.files['src/config.js'];
    await call('POST', analyzeUrl(), alice);
    await SourceRecord.create({ projectId: project._id, provider: 'github', externalId: 'C_new', type: 'commit', title: 'newer', metadata: { sourceUpdatedAt: new Date(), providerMetadata: { repositoryId: 101, sha: 'f'.repeat(40) } } });
    const s = await status();
    assert.equal(s.freshness.state, 'stale'); assert.match(s.freshness.reasons[0], /newer commit \(fffffff\)/);
    await SourceRecord.deleteMany({});
    await SourceConnection.updateOne({ _id: connection._id }, { 'config.analysis.staleAt': new Date(Date.now() + 1000) });
    assert.match((await status()).freshness.reasons[0], /new pushes/);
    calls.length = 0;
    const forced = (await call('POST', analyzeUrl(), alice, { force: true })).body.analysis;
    assert.ok(calls.some((c) => c.includes('/git/trees/'))); assert.equal(forced.freshness.state, 'current');
  });

  it('keeps the last good snapshot when a later run fails, and says so', async () => {
    delete state.files['src/config.js'];
    await call('POST', analyzeUrl(), alice);
    state.head = 'c2'; state.repoStatus = 403;
    const a = (await call('POST', analyzeUrl(), alice)).body.analysis;
    assert.equal(a.status, 'failed'); assert.match(a.error.message, /Contents: read/);
    assert.equal(a.snapshot.commitSha, 'c1'.padEnd(40, '0')); // previous knowledge still usable
    state.repoStatus = 200;
    for (const [code, text] of [[404, /not found/i], [500, /could not be analyzed/]]) { state.repoStatus = code; assert.match((await call('POST', analyzeUrl(), alice)).body.analysis.error.message, text); }
    assert.doesNotMatch(JSON.stringify(await status()), /ghs_|stack/);
  });

  it('fails clearly for an unavailable installation, a mismatched repository, and when nothing could be analyzed', async () => {
    await GitHubInstallation.updateMany({}, { status: 'suspended' });
    assert.equal((await call('POST', analyzeUrl(), alice)).body.analysis.error.code, 'INSTALLATION_UNAVAILABLE');
    await GitHubInstallation.updateMany({}, { status: 'active' });
    repo.id = 999;
    assert.equal((await call('POST', analyzeUrl(), alice)).body.analysis.error.code, 'REPOSITORY_MISMATCH');
    repo.id = 101;
    gh = ((orig) => (u, i) => (u.pathname.includes('/git/blobs/') ? J({ message: 'boom' }, 500) : orig(u, i)))(gh);
    const a = (await call('POST', analyzeUrl(), alice)).body.analysis;
    assert.equal(a.status, 'failed'); assert.equal(a.snapshot, null); // nothing is published, nothing is claimed
  });

  it('prevents concurrent analyses and recovers abandoned locks', async () => {
    await SourceConnection.updateOne({ _id: connection._id }, { $set: { 'config.analysis.status': 'analyzing', 'config.analysis.runId': 'other', 'config.analysis.lockedAt': new Date() } });
    const busy = await call('POST', analyzeUrl(), alice);
    assert.equal(busy.status, 409); assert.equal(busy.body.error, 'analysis_in_progress');
    assert.equal((await status()).status, 'analyzing');
    await SourceConnection.updateOne({ _id: connection._id }, { $set: { 'config.analysis.lockedAt': new Date(Date.now() - LOCK_TTL_MS - 1000) } });
    assert.equal((await status()).status, 'failed');
    assert.equal((await call('POST', analyzeUrl(), alice)).status, 200);
    assert.equal(await RepositorySnapshot.countDocuments(), 1);
  });

  it('enforces authorization and project isolation', async () => {
    assert.equal((await call('POST', analyzeUrl())).status, 401);
    assert.equal((await call('POST', analyzeUrl(), viewer)).status, 403);
    const outsider = await User.create({ email: 'o@example.com', name: 'O' });
    assert.equal((await call('POST', analyzeUrl(), outsider)).status, 404);
    assert.equal((await call('GET', `/api/projects/${project._id}/repository-knowledge`, outsider)).status, 404);
    assert.equal((await call('GET', `/api/projects/${project._id}/repository-knowledge`, viewer)).status, 200);
    const other = await Project.create({ name: 'Other', ownerId: alice._id, createdBy: alice._id });
    await ProjectMembership.create({ projectId: other._id, userId: alice._id, role: 'owner', invitedBy: alice._id });
    assert.equal((await call('POST', `/api/projects/${other._id}/integrations/github/${connection._id}/analyze`, alice)).status, 404);
    assert.equal((await call('POST', analyzeUrl(), bob)).status, 200); // members may analyze
    assert.equal(await RepositoryFile.countDocuments({ projectId: other._id }), 0);
  });

  it('purges stored repository content when the repository is disconnected or the project is deleted', async () => {
    await call('POST', analyzeUrl(), alice);
    assert.ok(await RepositoryFile.countDocuments() > 0);
    assert.equal((await call('DELETE', `/api/projects/${project._id}/integrations/github/${connection._id}`, alice)).status, 200);
    assert.equal(await RepositoryFile.countDocuments(), 0); assert.equal(await RepositorySnapshot.countDocuments(), 0);
    const c2 = await SourceConnection.create({ projectId: project._id, provider: 'github', connectedBy: alice._id, config: { sync: { status: 'pending' }, installationId: 777, repositoryId: 101, owner: 'acme', repo: 'relay', fullName: 'acme/relay' } });
    await call('POST', `/api/projects/${project._id}/integrations/github/${c2._id}/analyze`, alice);
    assert.ok(await RepositoryFile.countDocuments() > 0);
    assert.equal((await call('DELETE', `/api/projects/${project._id}`, alice)).status, 200);
    assert.equal(await RepositoryFile.countDocuments(), 0); assert.equal(await RepositorySnapshot.countDocuments(), 0);
  });
});
