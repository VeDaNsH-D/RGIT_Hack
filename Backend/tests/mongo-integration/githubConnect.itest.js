/** GitHub App install/connection flow on the real app + disposable MongoDB; GitHub itself is mocked. */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { startMongo, stopMongo, resetCollections } from './harness.js';

await startMongo();
const { app } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { User, GitHubInstallation, GitHubInstallState } = await import('../../src/models/index.js');

const realFetch = globalThis.fetch;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const APP_ID = '5283491';

describe('GitHub connection flow', () => {
  let server, base, alice, bob, gh;
  const tok = (u) => `Bearer ${signAuthToken(u)}`;
  const call = async (method, path, user) => {
    const res = await realFetch(`${base}${path}`, { method, redirect: 'manual', headers: user ? { Authorization: tok(user) } : {} });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { /* redirect */ }
    return { status: res.status, body, text, location: res.headers.get('location') };
  };
  const startInstall = async (user) => new URL((await call('POST', '/api/connections/github/install', user)).body.url).searchParams.get('state');
  const callback = (params) => call('GET', `/api/connections/github/callback?${new URLSearchParams(params)}`);
  const reasonOf = (r) => new URL(r.location).searchParams;

  before(async () => {
    Object.assign(config.githubApp, { appId: APP_ID, privateKey, appSlug: 'nodetorious1', clientId: 'cid', clientSecret: 'csecret', enabled: true });
    config.frontendUrl = 'http://front.test';
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (!u.includes('github.com')) return realFetch(url, init);
      return gh(u, init);
    };
  });
  after(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); await stopMongo(); });
  beforeEach(async () => {
    await resetCollections();
    alice = await User.create({ email: 'a@example.com', name: 'Alice' });
    bob = await User.create({ email: 'b@example.com', name: 'Bob' });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    gh = (u) => {
      if (u.endsWith('/login/oauth/access_token')) return json({ access_token: 'user-token' });
      if (u.includes('/user/installations')) return json({ installations: [{ id: 777 }] });
      if (u.endsWith('/app/installations/777')) return json({ id: 777, app_id: Number(APP_ID), account: { login: 'acme', type: 'Organization' }, repository_selection: 'selected' });
      return json({ message: 'Not Found' }, 404);
    };
  });

  it('rejects unauthenticated initiation and status', async () => {
    assert.equal((await call('POST', '/api/connections/github/install')).status, 401);
    assert.equal((await call('GET', '/api/connections/github')).status, 401);
  });

  it('returns a GitHub install URL with random state for an authenticated user', async () => {
    const r = await call('POST', '/api/connections/github/install', alice);
    assert.equal(r.status, 200);
    const url = new URL(r.body.url);
    assert.equal(url.origin + url.pathname, 'https://github.com/apps/nodetorious1/installations/new');
    assert.ok(url.searchParams.get('state').length >= 40);
    assert.notEqual(await startInstall(alice), await startInstall(alice));
  });

  it('reports not_configured without client credentials', async () => {
    const saved = config.githubApp.clientSecret; config.githubApp.clientSecret = '';
    try { assert.equal((await call('POST', '/api/connections/github/install', alice)).status, 503); } finally { config.githubApp.clientSecret = saved; }
  });

  it('connects, persists safely, and reports status only to the owning user', async () => {
    const state = await startInstall(alice);
    const r = await callback({ state, installation_id: '777', setup_action: 'install', code: 'abc' });
    assert.equal(r.status, 302);
    assert.equal(reasonOf(r).get('github'), 'connected');
    const row = await GitHubInstallation.findOne({ userId: alice._id }).lean();
    assert.equal(row.installationId, 777); assert.equal(row.accountLogin, 'acme');
    const s = await call('GET', '/api/connections/github', alice);
    assert.equal(s.body.connected, true);
    assert.equal(s.body.accounts[0].login, 'acme');
    assert.equal(s.body.repositoryAssociationRequired, true);
    assert.doesNotMatch(s.text, /777|token|secret|PRIVATE/i);
    assert.equal((await call('GET', '/api/connections/github', bob)).body.connected, false);
  });

  it('re-running the install is idempotent', async () => {
    for (let i = 0; i < 2; i += 1) await callback({ state: await startInstall(alice), installation_id: '777', code: 'abc' });
    assert.equal(await GitHubInstallation.countDocuments({ userId: alice._id }), 1);
  });

  it('rejects replayed, unknown, and missing state', async () => {
    const state = await startInstall(alice);
    await callback({ state, installation_id: '777', code: 'abc' });
    assert.equal(reasonOf(await callback({ state, installation_id: '777', code: 'abc' })).get('reason'), 'invalid_state');
    assert.equal(reasonOf(await callback({ state: 'x'.repeat(43), installation_id: '777', code: 'abc' })).get('reason'), 'invalid_state');
    assert.equal(reasonOf(await callback({ installation_id: '777' })).get('reason'), 'invalid_state');
  });

  it('rejects expired state', async () => {
    const state = await startInstall(alice);
    await GitHubInstallState.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    const r = await callback({ state, installation_id: '777', code: 'abc' });
    assert.equal(reasonOf(r).get('reason'), 'expired_state');
    assert.equal(await GitHubInstallation.countDocuments(), 0);
  });

  it('a new install start invalidates the previous pending state', async () => {
    const first = await startInstall(alice); await startInstall(alice);
    assert.equal(reasonOf(await callback({ state: first, installation_id: '777', code: 'abc' })).get('reason'), 'invalid_state');
  });

  it('handles cancellation and approval-pending without connecting', async () => {
    assert.equal(reasonOf(await callback({ state: await startInstall(alice), error: 'access_denied' })).get('github'), 'cancelled');
    assert.equal(reasonOf(await callback({ state: await startInstall(alice), setup_action: 'request', installation_id: '777' })).get('github'), 'pending');
    assert.equal(await GitHubInstallation.countDocuments(), 0);
  });

  it('refuses an installation the user cannot access, or a missing authorization code', async () => {
    gh = (u) => (u.includes('/user/installations') ? new Response(JSON.stringify({ installations: [{ id: 1 }] })) : u.endsWith('/login/oauth/access_token') ? new Response(JSON.stringify({ access_token: 't' })) : new Response('{}', { status: 404 }));
    assert.equal(reasonOf(await callback({ state: await startInstall(alice), installation_id: '777', code: 'abc' })).get('reason'), 'installation_forbidden');
    assert.equal(reasonOf(await callback({ state: await startInstall(alice), installation_id: '777' })).get('reason'), 'authorization_required');
    assert.equal(await GitHubInstallation.countDocuments(), 0);
  });

  it('refuses invalid, unknown, foreign-app, and suspended installations', async () => {
    assert.equal(reasonOf(await callback({ state: await startInstall(alice), installation_id: 'abc', code: 'c' })).get('reason'), 'invalid_installation');
    const base = gh;
    gh = (u) => (u.endsWith('/app/installations/777') ? new Response('{}', { status: 404 }) : base(u));
    assert.equal(reasonOf(await callback({ state: await startInstall(alice), installation_id: '777', code: 'c' })).get('reason'), 'installation_not_found');
    gh = (u) => (u.endsWith('/app/installations/777') ? new Response(JSON.stringify({ id: 777, app_id: 1, account: { login: 'x', type: 'User' } })) : base(u));
    assert.equal(reasonOf(await callback({ state: await startInstall(alice), installation_id: '777', code: 'c' })).get('reason'), 'installation_unverified');
    gh = (u) => (u.endsWith('/app/installations/777') ? new Response(JSON.stringify({ id: 777, app_id: 5283491, suspended_at: '2026-01-01', account: { login: 'x', type: 'User' } })) : base(u));
    assert.equal(reasonOf(await callback({ state: await startInstall(alice), installation_id: '777', code: 'c' })).get('reason'), 'installation_suspended');
    assert.equal(await GitHubInstallation.countDocuments(), 0);
  });
});
