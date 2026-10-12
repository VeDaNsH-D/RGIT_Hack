import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import {
  validateAppConfig,
  validateInstallationId,
  generateAppJwt,
  GitHubAppAuthService,
} from './githubAppAuth.js';
import {
  mapDiscoveredRepository,
  listInstallationRepositories,
} from './installationDiscovery.js';
import { GitHubClient } from './githubClient.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from './githubErrors.js';

// Generate a real ephemeral RSA key pair for testing RS256 signing and verification
const { privateKey: rawPrivateKey, publicKey: rawPublicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const TEST_PRIVATE_KEY = rawPrivateKey.export({ type: 'pkcs1', format: 'pem' });
const TEST_PUBLIC_KEY = rawPublicKey.export({ type: 'pkcs1', format: 'pem' });

describe('GitHub App Authentication: Configuration & Input Validation', () => {
  it('validates correct GitHub App config and normalizes escaped newlines', () => {
    const rawWithEscapes = TEST_PRIVATE_KEY.replace(/\n/g, '\\n');
    const config = validateAppConfig({
      appId: 123456,
      privateKey: rawWithEscapes,
      baseUrl: 'https://api.github.com/',
    });

    assert.equal(config.appId, '123456');
    assert.equal(config.privateKey, TEST_PRIVATE_KEY);
    assert.equal(config.baseUrl, 'https://api.github.com');
  });

  it('rejects missing or non-numeric appId with CONFIG_ERROR', () => {
    assert.throws(
      () => validateAppConfig({ appId: '', privateKey: TEST_PRIVATE_KEY }),
      (err) => err instanceof GitHubApiError && err.code === GITHUB_ERROR_CODES.CONFIG_ERROR
    );

    assert.throws(
      () => validateAppConfig({ appId: 'not-a-number', privateKey: TEST_PRIVATE_KEY }),
      (err) => err instanceof GitHubApiError && err.code === GITHUB_ERROR_CODES.CONFIG_ERROR
    );
  });

  it('rejects missing or non-PEM private key with CONFIG_ERROR', () => {
    assert.throws(
      () => validateAppConfig({ appId: '123456', privateKey: '' }),
      (err) => err instanceof GitHubApiError && err.code === GITHUB_ERROR_CODES.CONFIG_ERROR
    );

    assert.throws(
      () => validateAppConfig({ appId: '123456', privateKey: 'some-random-string' }),
      (err) => err instanceof GitHubApiError && err.code === GITHUB_ERROR_CODES.CONFIG_ERROR
    );
  });

  it('validates numeric and string positive installation IDs', () => {
    assert.equal(validateInstallationId(987654), 987654);
    assert.equal(validateInstallationId('987654'), 987654);
  });

  it('rejects invalid or non-positive installation IDs with INVALID_INPUT', () => {
    const invalidValues = [0, -1, 'invalid', '', null, undefined, 1.5];
    for (const val of invalidValues) {
      assert.throws(
        () => validateInstallationId(val),
        (err) => err instanceof GitHubApiError && err.code === GITHUB_ERROR_CODES.INVALID_INPUT
      );
    }
  });
});

describe('GitHub App Authentication: JWT Claim Construction and Signing', () => {
  it('generates an RS256-signed JWT with exact claims conforming to GitHub specification', () => {
    const fixedTime = 1700000000;
    const token = generateAppJwt({
      appId: '889900',
      privateKey: TEST_PRIVATE_KEY,
      nowInSeconds: fixedTime,
    });

    assert.ok(typeof token === 'string' && token.split('.').length === 3);

    // Verify token signature and claims with corresponding public key
    const decoded = jwt.verify(token, TEST_PUBLIC_KEY, {
      algorithms: ['RS256'],
      ignoreExpiration: true,
    });

    assert.equal(decoded.iss, '889900');
    assert.equal(decoded.iat, fixedTime - 60); // 60 seconds clock skew tolerance
    assert.equal(decoded.exp, fixedTime - 60 + 540); // 9 minutes total lifespan from iat
  });

  it('throws CONFIG_ERROR if signing fails with corrupted key', () => {
    assert.throws(
      () =>
        generateAppJwt({
          appId: '889900',
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\ncorrupted\n-----END RSA PRIVATE KEY-----',
        }),
      (err) => err instanceof GitHubApiError && err.code === GITHUB_ERROR_CODES.CONFIG_ERROR
    );
  });
});

describe('GitHub App Authentication: Installation Token Exchange Service', () => {
  it('successfully exchanges App JWT for installation access token', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedHeaders = {};
    let capturedBody = null;

    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      capturedMethod = opts.method;
      capturedHeaders = opts.headers;
      capturedBody = opts.body ? JSON.parse(opts.body) : null;

      return {
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          token: 'ghs_installation_test_token_secret_value',
          expires_at: '2026-10-12T15:00:00Z',
          permissions: { issues: 'read', contents: 'read' },
          repository_selection: 'selected',
        }),
      };
    };

    const service = new GitHubAppAuthService({
      appId: '123456',
      privateKey: TEST_PRIVATE_KEY,
      fetchFn: mockFetch,
    });

    const result = await service.createInstallationToken(556677, {
      repositories: ['repo-a', 'repo-b'],
      permissions: { contents: 'read' },
    });

    assert.equal(capturedUrl, 'https://api.github.com/app/installations/556677/access_tokens');
    assert.equal(capturedMethod, 'POST');
    assert.equal(capturedHeaders.Accept, 'application/vnd.github+json');
    assert.ok(capturedHeaders.Authorization.startsWith('Bearer '));
    assert.deepEqual(capturedBody, {
      repositories: ['repo-a', 'repo-b'],
      permissions: { contents: 'read' },
    });

    assert.equal(result.token, 'ghs_installation_test_token_secret_value');
    assert.equal(result.expiresAt.toISOString(), '2026-10-12T15:00:00.000Z');
    assert.equal(result.repositorySelection, 'selected');
  });

  it('categorizes 401 response as AUTH_FAILED and does not leak token or key in error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'A JSON web token could not be verified' }),
    });

    const service = new GitHubAppAuthService({
      appId: '123456',
      privateKey: TEST_PRIVATE_KEY,
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => service.createInstallationToken(1122),
      (err) => {
        assert.ok(err instanceof GitHubApiError);
        assert.equal(err.code, GITHUB_ERROR_CODES.AUTH_FAILED);
        assert.equal(err.status, 401);
        assert.ok(!err.message.includes(TEST_PRIVATE_KEY));
        return true;
      }
    );
  });

  it('categorizes 404 response as NOT_FOUND when installation does not exist', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'Installation not found' }),
    });

    const service = new GitHubAppAuthService({
      appId: '123456',
      privateKey: TEST_PRIVATE_KEY,
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => service.createInstallationToken(9999999),
      (err) => {
        assert.ok(err instanceof GitHubApiError);
        assert.equal(err.code, GITHUB_ERROR_CODES.NOT_FOUND);
        assert.equal(err.status, 404);
        return true;
      }
    );
  });

  it('categorizes 429 response as RATE_LIMITED', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'API rate limit exceeded' }),
    });

    const service = new GitHubAppAuthService({
      appId: '123456',
      privateKey: TEST_PRIVATE_KEY,
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => service.createInstallationToken(1122),
      (err) => {
        assert.ok(err instanceof GitHubApiError);
        assert.equal(err.code, GITHUB_ERROR_CODES.RATE_LIMITED);
        assert.equal(err.status, 429);
        return true;
      }
    );
  });

  it('handles request timeout cleanly with TIMEOUT error code', async () => {
    const mockFetch = async (_url, opts) => {
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    const service = new GitHubAppAuthService({
      appId: '123456',
      privateKey: TEST_PRIVATE_KEY,
      timeoutMs: 30,
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => service.createInstallationToken(1122),
      (err) => {
        assert.ok(err instanceof GitHubApiError);
        assert.equal(err.code, GITHUB_ERROR_CODES.TIMEOUT);
        return true;
      }
    );
  });

  it('handles network failure with NETWORK_ERROR code', async () => {
    const mockFetch = async () => {
      throw new Error('ECONNRESET');
    };

    const service = new GitHubAppAuthService({
      appId: '123456',
      privateKey: TEST_PRIVATE_KEY,
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => service.createInstallationToken(1122),
      (err) => {
        assert.ok(err instanceof GitHubApiError);
        assert.equal(err.code, GITHUB_ERROR_CODES.NETWORK_ERROR);
        assert.ok(err.message.includes('ECONNRESET'));
        return true;
      }
    );
  });
});

describe('GitHub Repository Discovery: Mapping and Listing Accessible Repositories', () => {
  it('maps raw GitHub repository data to safe Relay metadata format', () => {
    const rawRepo = {
      id: 456789,
      name: 'relay',
      full_name: 'acme/relay',
      owner: { login: 'acme', id: 100 },
      private: true,
      default_branch: 'develop',
      html_url: 'https://github.com/acme/relay',
      description: 'Handoff and continuity platform',
      permissions: { admin: true, pull: true }, // Extra sensitive metadata that shouldn't leak unmapped
    };

    const mapped = mapDiscoveredRepository(rawRepo);

    assert.deepEqual(mapped, {
      id: 456789,
      name: 'relay',
      fullName: 'acme/relay',
      owner: 'acme',
      isPrivate: true,
      defaultBranch: 'develop',
      htmlUrl: 'https://github.com/acme/relay',
      description: 'Handoff and continuity platform',
    });
    // Verifies permissions object or unwanted internal tokens are not included
    assert.equal(mapped.permissions, undefined);
  });

  it('discovers installation repositories with pagination', async () => {
    const page1Data = {
      total_count: 3,
      repositories: [
        { id: 1, name: 'repo-1', full_name: 'org/repo-1', owner: { login: 'org' }, private: false, default_branch: 'main', html_url: 'https://github.com/org/repo-1' },
        { id: 2, name: 'repo-2', full_name: 'org/repo-2', owner: { login: 'org' }, private: true, default_branch: 'main', html_url: 'https://github.com/org/repo-2' },
      ],
    };

    const page2Data = {
      total_count: 3,
      repositories: [
        { id: 3, name: 'repo-3', full_name: 'org/repo-3', owner: { login: 'org' }, private: false, default_branch: 'main', html_url: 'https://github.com/org/repo-3' },
      ],
    };

    let callCount = 0;
    const mockFetch = async (url) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'application/json',
            Link: '<https://api.github.com/installation/repositories?page=2>; rel="next"',
          }),
          json: async () => page1Data,
        };
      }

      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
        }),
        json: async () => page2Data,
      };
    };

    const client = new GitHubClient({
      token: 'ghs_installation_test_token',
      fetchFn: mockFetch,
    });

    const result = await listInstallationRepositories(client, { perPage: 2, maxPages: 5 });

    assert.equal(result.totalCount, 3);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.hasMore, false);
    assert.equal(result.repositories.length, 3);
    assert.equal(result.repositories[0].name, 'repo-1');
    assert.equal(result.repositories[2].name, 'repo-3');
  });

  it('enforces configured maxRepos limit across pagination', async () => {
    const page1Data = {
      total_count: 10,
      repositories: [
        { id: 1, name: 'repo-1', full_name: 'org/repo-1', owner: { login: 'org' } },
        { id: 2, name: 'repo-2', full_name: 'org/repo-2', owner: { login: 'org' } },
      ],
    };

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/json',
        Link: '<https://api.github.com/installation/repositories?page=2>; rel="next"',
      }),
      json: async () => page1Data,
    });

    const client = new GitHubClient({
      token: 'ghs_installation_test_token',
      fetchFn: mockFetch,
    });

    // Request cap of 1 repository
    const result = await listInstallationRepositories(client, { maxRepos: 1 });

    assert.equal(result.repositories.length, 1);
    assert.equal(result.hasMore, true);
  });

  it('enforces configured maxPages limit', async () => {
    const pageData = {
      total_count: 100,
      repositories: [
        { id: 1, name: 'repo-1', full_name: 'org/repo-1', owner: { login: 'org' } },
      ],
    };

    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
          Link: `<https://api.github.com/installation/repositories?page=${fetchCount + 1}>; rel="next"`,
        }),
        json: async () => pageData,
      };
    };

    const client = new GitHubClient({
      token: 'ghs_installation_test_token',
      fetchFn: mockFetch,
    });

    const result = await listInstallationRepositories(client, { maxPages: 2 });

    assert.equal(result.pagesFetched, 2);
    assert.equal(fetchCount, 2);
    assert.equal(result.hasMore, true);
  });
});
