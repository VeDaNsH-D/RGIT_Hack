/**
 * @file githubSecurity.test.js
 * @description Tests for credential handling: private key validation, secret
 * redaction, token privacy, installation-token caching, installation-scoped
 * clients, permission checks, and repository metadata mapping.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import util from 'node:util';

import {
  validateAppConfig,
  validateAppSlug,
  readGitHubAppEnv,
  checkInstallationPermissions,
  REQUIRED_READ_PERMISSIONS,
  GitHubAppAuthService,
} from './githubAppAuth.js';
import { GitHubClient, MAX_PAGES_LIMIT } from './githubClient.js';
import { GITHUB_ERROR_CODES, GitHubApiError, redactSecrets, toSafeErrorSummary } from './githubErrors.js';
import { fetchCommits } from './commits.js';
import { mapRepositoryMetadata } from './repositories.js';

const { privateKey: rsaKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PEM = rsaKey.export({ type: 'pkcs1', format: 'pem' });
const RSA_PKCS8_PEM = rsaKey.export({ type: 'pkcs8', format: 'pem' });
const { privateKey: ecKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const EC_PEM = ecKey.export({ type: 'pkcs8', format: 'pem' });

const FINGERPRINT = 'SHA256:q8hY0ZpX3mXw0aJ8b4YbV1v2Qd9a1W1m3eZ0bq8u7yE=';
const TOKEN = 'ghs_InstallationTokenForUnitTests000000000001';

function tokenResponse(token = TOKEN, expiresAt = '2099-01-01T00:00:00Z') {
  return new Response(JSON.stringify({
    token,
    expires_at: expiresAt,
    permissions: { metadata: 'read', issues: 'read' },
    repository_selection: 'selected',
  }), { status: 201, headers: { 'content-type': 'application/json' } });
}

describe('GitHub App private key validation', () => {
  it('accepts PKCS#1 and PKCS#8 RSA keys, with real or escaped newlines', () => {
    assert.equal(validateAppConfig({ appId: 1, privateKey: RSA_PEM }).appId, '1');
    assert.ok(validateAppConfig({ appId: 1, privateKey: RSA_PKCS8_PEM }).privateKey.includes('BEGIN PRIVATE KEY'));
    const escaped = RSA_PEM.replace(/\n/g, '\\n');
    assert.equal(validateAppConfig({ appId: 1, privateKey: escaped }).privateKey.trim(), RSA_PEM.trim());
  });

  it('rejects a SHA256 fingerprint with CONFIG_ERROR and never echoes the value', () => {
    assert.throws(
      () => validateAppConfig({ appId: 5283491, privateKey: FINGERPRINT }),
      (err) => err instanceof GitHubApiError
        && err.code === GITHUB_ERROR_CODES.CONFIG_ERROR
        && !err.message.includes(FINGERPRINT)
        && !err.message.includes('q8hY0'),
    );
  });

  it('rejects a truncated PEM without leaking its contents', () => {
    const truncated = RSA_PEM.slice(0, 200) + '\n-----END RSA PRIVATE KEY-----';
    assert.throws(
      () => validateAppConfig({ appId: 1, privateKey: truncated }),
      (err) => err.code === GITHUB_ERROR_CODES.CONFIG_ERROR && !err.message.includes(RSA_PEM.slice(40, 80)),
    );
  });

  it('rejects non-RSA keys (RS256 requires RSA)', () => {
    assert.throws(
      () => validateAppConfig({ appId: 1, privateKey: EC_PEM }),
      (err) => err.code === GITHUB_ERROR_CODES.CONFIG_ERROR && err.message.includes('RSA'),
    );
  });
});

describe('GitHub App slug and env reading', () => {
  it('validates the app slug format', () => {
    assert.equal(validateAppSlug('nodetorious1'), 'nodetorious1');
    for (const bad of ['', 'Has Caps', 'bad_underscore', '-leading', 'x'.repeat(101), undefined]) {
      assert.throws(() => validateAppSlug(bad), { code: GITHUB_ERROR_CODES.CONFIG_ERROR });
    }
  });

  it('reads GitHub App settings from an env object without touching process.env', () => {
    const env = {
      GITHUB_APP_ID: '5283491',
      GITHUB_APP_SLUG: 'nodetorious1',
      GITHUB_APP_INSTALLATION_ID: '170530734',
      GITHUB_APP_PRIVATE_KEY: 'k',
    };
    assert.deepEqual(readGitHubAppEnv(env), {
      appId: '5283491', appSlug: 'nodetorious1', installationId: '170530734', privateKey: 'k',
    });
    assert.deepEqual(readGitHubAppEnv({}), { appId: '', appSlug: '', installationId: '', privateKey: '' });
  });
});

describe('Secret redaction', () => {
  it('redacts tokens, bearer values, JWTs and PEM blocks', () => {
    const jwtLike = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl';
    const text = `t=${TOKEN} pat=github_pat_ABCDEFGH12345678 Authorization: Bearer abcdefghijklmnopqrstuvwxyz ${jwtLike} ${RSA_PEM}`;
    const out = redactSecrets(text);
    assert.ok(!out.includes(TOKEN));
    assert.ok(!out.includes('github_pat_ABCDEFGH'));
    assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'));
    assert.ok(!out.includes(jwtLike));
    assert.ok(!out.includes('PRIVATE KEY'));
  });

  it('leaves ordinary messages untouched', () => {
    const msg = 'GitHub App installation token request timed out after 10000ms.';
    assert.equal(redactSecrets(msg), msg);
  });

  it('GitHubApiError messages are redacted at construction', () => {
    const err = new GitHubApiError(`failure using ${TOKEN}`);
    assert.ok(!err.message.includes(TOKEN));
  });

  it('toSafeErrorSummary hides messages of unknown errors', () => {
    assert.deepEqual(toSafeErrorSummary(new Error(`secret ${TOKEN}`)), {
      code: GITHUB_ERROR_CODES.INTERNAL_ERROR, message: 'Unexpected internal error.', status: null,
    });
  });
});

describe('Credential privacy on objects', () => {
  it('GitHubClient does not expose its token via inspect, JSON or enumeration', () => {
    const client = new GitHubClient({ token: TOKEN, fetchFn: async () => new Response('{}') });
    assert.ok(!util.inspect(client, { depth: 5, showHidden: true }).includes(TOKEN));
    assert.ok(!JSON.stringify(client).includes(TOKEN));
    assert.equal(client.token, undefined);
    assert.equal(client.isAuthenticated, true);
  });

  it('GitHubAppAuthService does not expose its private key via inspect or JSON', () => {
    const service = new GitHubAppAuthService({ appId: 1, privateKey: RSA_PEM, fetchFn: async () => tokenResponse() });
    const keyBody = RSA_PEM.split('\n')[1];
    assert.ok(!util.inspect(service, { depth: 5, showHidden: true }).includes(keyBody));
    assert.ok(!JSON.stringify(service).includes(keyBody));
    assert.equal(service.rawConfig, undefined);
  });
});

describe('Installation token caching and installation clients', () => {
  const originalEnvToken = process.env.GITHUB_TOKEN;
  afterEach(() => {
    if (originalEnvToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalEnvToken;
  });

  it('reuses a cached token until it nears expiry, then refreshes', async () => {
    let exchanges = 0;
    const service = new GitHubAppAuthService({
      appId: 1,
      privateKey: RSA_PEM,
      fetchFn: async () => { exchanges += 1; return tokenResponse(`${TOKEN}${exchanges}`, '2026-10-12T11:00:00Z'); },
    });
    const at = (iso) => () => new Date(iso).getTime();

    const a = await service.getInstallationToken(7, { now: at('2026-10-12T10:00:00Z') });
    const b = await service.getInstallationToken('7', { now: at('2026-10-12T10:30:00Z') });
    assert.equal(exchanges, 1);
    assert.equal(a.token, b.token);

    await service.getInstallationToken(7, { now: at('2026-10-12T10:56:00Z') });
    assert.equal(exchanges, 2);

    await service.getInstallationToken(7, { forceRefresh: true, now: at('2026-10-12T10:00:00Z') });
    assert.equal(exchanges, 3);
  });

  it('createInstallationClient authenticates with the installation token, never GITHUB_TOKEN', async () => {
    process.env.GITHUB_TOKEN = 'ghp_PersonalAccessTokenThatMustNotBeUsed00';
    const seenAuth = [];
    const fetchFn = async (url, opts) => {
      if (opts.method === 'POST') return tokenResponse();
      seenAuth.push(opts.headers.Authorization);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const service = new GitHubAppAuthService({ appId: 1, privateKey: RSA_PEM, fetchFn });
    const { client, permissions, repositorySelection } = await service.createInstallationClient(170530734);

    await client.get('/installation/repositories');
    assert.deepEqual(seenAuth, [`Bearer ${TOKEN}`]);
    assert.deepEqual(permissions, { metadata: 'read', issues: 'read' });
    assert.equal(repositorySelection, 'selected');
  });

  it('does not create a client when the exchange returns no token', async () => {
    const service = new GitHubAppAuthService({
      appId: 1,
      privateKey: RSA_PEM,
      fetchFn: async () => new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }),
    });
    await assert.rejects(() => service.createInstallationClient(1), { code: GITHUB_ERROR_CODES.HTTP_ERROR });
  });

  it('classifies a rate-limited token exchange as RATE_LIMITED', async () => {
    const service = new GitHubAppAuthService({
      appId: 1,
      privateKey: RSA_PEM,
      fetchFn: async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' },
      }),
    });
    await assert.rejects(() => service.createInstallationToken(1), { code: GITHUB_ERROR_CODES.RATE_LIMITED });
  });

  it('classifies a JWT rejected by GitHub as AUTH_FAILED without leaking the JWT', async () => {
    let sentJwt = '';
    const service = new GitHubAppAuthService({
      appId: 1,
      privateKey: RSA_PEM,
      fetchFn: async (url, opts) => {
        sentJwt = opts.headers.Authorization.slice('Bearer '.length);
        return new Response(JSON.stringify({ message: 'A JSON web token could not be decoded' }), {
          status: 401, headers: { 'content-type': 'application/json' },
        });
      },
    });
    await assert.rejects(
      () => service.createInstallationToken(1),
      (err) => err.code === GITHUB_ERROR_CODES.AUTH_FAILED && !JSON.stringify(err).includes(sentJwt) && !err.message.includes(sentJwt),
    );
  });
});

describe('Installation permission checks', () => {
  it('reports missing read permissions and unexpected write grants', () => {
    assert.deepEqual(REQUIRED_READ_PERMISSIONS, ['metadata', 'issues', 'pull_requests', 'contents']);
    assert.deepEqual(
      checkInstallationPermissions({ metadata: 'read', issues: 'read', pull_requests: 'read', contents: 'read' }),
      { ok: true, missing: [], writeGranted: [] },
    );
    assert.deepEqual(
      checkInstallationPermissions({ metadata: 'read', issues: 'write' }),
      { ok: false, missing: ['pull_requests', 'contents'], writeGranted: ['issues'] },
    );
    assert.equal(checkInstallationPermissions(undefined).ok, false);
  });
});

describe('Client pagination hard limits and response shape', () => {
  it('clamps maxPages to MAX_PAGES_LIMIT', async () => {
    let calls = 0;
    const client = new GitHubClient({
      token: TOKEN,
      fetchFn: async () => {
        calls += 1;
        return new Response('[1]', {
          status: 200,
          headers: { 'content-type': 'application/json', link: '<https://api.github.com/x?page=next>; rel="next"' },
        });
      },
    });
    const result = await client.paginate('/x', {}, { maxPages: 10000 });
    assert.equal(calls, MAX_PAGES_LIMIT);
    assert.equal(result.hasMore, true);
  });

  it('throws UNEXPECTED_RESPONSE for non-array pages when requireArray is set', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      fetchFn: async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await assert.rejects(() => client.paginate('/x', {}, { requireArray: true }), { code: GITHUB_ERROR_CODES.UNEXPECTED_RESPONSE });
  });

  it('captures retry-after for secondary rate limits', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      fetchFn: async () => new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {
        status: 403, headers: { 'content-type': 'application/json', 'retry-after': '60' },
      }),
    });
    await assert.rejects(
      () => client.get('/x'),
      (err) => err.code === GITHUB_ERROR_CODES.RATE_LIMITED && err.rateLimit.retryAfterSeconds === 60,
    );
  });
});

describe('Commit fetcher on empty repositories', () => {
  it('returns an empty successful result for GitHub 409 "Git Repository is empty"', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      fetchFn: async () => new Response(JSON.stringify({ message: 'Git Repository is empty.' }), {
        status: 409, headers: { 'content-type': 'application/json' },
      }),
    });
    const result = await fetchCommits(client, 'acme', 'empty');
    assert.deepEqual(result.commits, []);
    assert.equal(result.repositoryEmpty, true);
  });

  it('still propagates other commit errors', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      fetchFn: async () => new Response('{"message":"Server Error"}', { status: 500, headers: { 'content-type': 'application/json' } }),
    });
    await assert.rejects(() => fetchCommits(client, 'acme', 'relay'), { code: GITHUB_ERROR_CODES.SERVER_ERROR });
  });
});

describe('Repository metadata mapping', () => {
  it('maps only the bounded safe field set', () => {
    const mapped = mapRepositoryMetadata({
      id: 1, node_id: 'R_1', name: 'relay', full_name: 'acme/relay', owner: { login: 'acme' },
      description: 'd', html_url: 'https://github.com/acme/relay', default_branch: 'main', language: 'Go',
      private: false, created_at: '2025-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      pushed_at: '2026-01-02T00:00:00Z', permissions: { admin: true }, owner_token: 'x',
    });
    assert.deepEqual(mapped, {
      id: 1, nodeId: 'R_1', name: 'relay', fullName: 'acme/relay', owner: 'acme', description: 'd',
      htmlUrl: 'https://github.com/acme/relay', defaultBranch: 'main', language: 'Go', isPrivate: false,
      visibility: 'public', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      pushedAt: '2026-01-02T00:00:00Z',
    });
  });

  it('rejects non-object input', () => {
    assert.throws(() => mapRepositoryMetadata(null), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
  });
});
