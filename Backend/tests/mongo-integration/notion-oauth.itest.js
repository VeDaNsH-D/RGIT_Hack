import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo } from './harness.js';
let service, State, Connection, user, token, server, origin;
const realFetch = globalThis.fetch;
before(async () => {
  process.env.NOTION_CLIENT_ID = 'notion-test-client';
  process.env.NOTION_CLIENT_SECRET = 'notion-test-secret';
  process.env.NOTION_REDIRECT_URI = 'https://api.example.test/api/connections/notion/callback';
  process.env.FRONTEND_URL = 'https://app.example.test';
  await startMongo();
  service = await import('../../src/services/notionOAuthService.js');
  ({ NotionInstallState: State } = await import('../../src/models/NotionInstallState.js'));
  ({ NotionConnection: Connection } = await import('../../src/models/NotionConnection.js'));
  const { User } = await import('../../src/models/User.js');
  const { signAuthToken } = await import('../../src/middleware/auth.js');
  user = await User.create({ name: 'Notion User', email: 'notion-oauth@example.test' });
  token = signAuthToken(user);
  const { app } = await import('../../src/app.js');
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { globalThis.fetch = realFetch; await new Promise(resolve => server?.close(resolve)); await stopMongo(); });
test('OAuth state is hashed, bound to a user, single-use, and expires', async () => {
  const url = new URL(await service.createNotionInstallUrl(user.id));
  assert.equal(url.searchParams.get('redirect_uri'), process.env.NOTION_REDIRECT_URI);
  assert.equal(url.searchParams.get('owner'), 'user');
  const state = url.searchParams.get('state');
  assert.doesNotMatch(JSON.stringify(await State.find({}).lean()), new RegExp(state));
  assert.equal(await service.consumeNotionState(state), user.id);
  await assert.rejects(service.consumeNotionState(state), /authorize Notion/);
  const expired = new URL(await service.createNotionInstallUrl(user.id, Date.now() - 700000));
  await assert.rejects(service.consumeNotionState(expired.searchParams.get('state')), /authorize Notion/);
});
test('token exchange stays server-side and OAuth credentials are encrypted', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.notion.com/v1/oauth/token');
    assert.match(options.headers.Authorization, /^Basic /);
    assert.equal(JSON.parse(options.body).redirect_uri, process.env.NOTION_REDIRECT_URI);
    return Response.json({ access_token: 'private-notion-access', refresh_token: 'private-notion-refresh', workspace_id: 'w1', workspace_name: 'Example workspace' });
  };
  try {
    const row = await service.completeNotionInstall(user.id, 'test-code');
    assert.equal(row.authMethod, 'oauth');
    assert.doesNotMatch(JSON.stringify(row), /private-notion-access|private-notion-refresh/);
    assert.equal(await service.notionAccessToken(row), 'private-notion-access');
  } finally { globalThis.fetch = realFetch; }
});
test('401 retries refresh the token pair; provider failures cannot overwrite a connection', async () => {
  const row = await Connection.findOne({ userId: user.id });
  globalThis.fetch = async () => Response.json({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh' });
  try {
    const result = await service.withNotionToken(row, async access => {
      if (access === 'private-notion-access') throw Object.assign(new Error('Expired'), { statusCode: 401 });
      return access;
    });
    assert.equal(result, 'refreshed-access');
    assert.equal(await service.notionAccessToken(await Connection.findById(row.id)), result);
    globalThis.fetch = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    await assert.rejects(service.completeNotionInstall(user.id, 'bad-code'));
    assert.equal(await service.notionAccessToken(await Connection.findById(row.id)), result);
  } finally { globalThis.fetch = realFetch; }
});
test('connection APIs hide tokens, require authentication, and reject callback replay', async () => {
  const headers = { Authorization: `Bearer ${token}` };
  const status = await realFetch(`${origin}/api/connections/notion`, { headers });
  const data = await status.json();
  assert.equal(data.connected, true); assert.equal(data.configured, true); assert.equal(data.authMethod, 'oauth');
  assert.doesNotMatch(JSON.stringify(data), /token|secret|refreshed-access/);
  assert.equal((await realFetch(`${origin}/api/connections/notion/install`, { method: 'POST' })).status, 401);
  const response = await realFetch(`${origin}/api/connections/notion/callback?state=invalid`, { redirect: 'manual' });
  assert.equal(response.status, 302); assert.match(response.headers.get('location'), /notion=error/);
});
