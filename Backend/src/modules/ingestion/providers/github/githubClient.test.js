/**
 * @file githubClient.test.js
 * @description Unit tests for GitHubClient and helper utilities using node:test and node:assert.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubClient,
  validateIdentifier,
  parseLinkHeader,
} from './githubClient.js';
import { GITHUB_ERROR_CODES } from './githubErrors.js';

describe('GitHub Identifier Validation (SSRF mitigation)', () => {
  it('accepts valid alphanumeric repository and owner names', () => {
    assert.equal(validateIdentifier('octocat'), 'octocat');
    assert.equal(validateIdentifier('hello-world'), 'hello-world');
    assert.equal(validateIdentifier('repo.name_v2'), 'repo.name_v2');
  });

  it('rejects path traversal and illegal characters', () => {
    assert.throws(() => validateIdentifier('..'), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
    assert.throws(() => validateIdentifier('.'), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
    assert.throws(() => validateIdentifier('foo/bar'), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
    assert.throws(() => validateIdentifier('../evil'), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
    assert.throws(() => validateIdentifier('evil?query=1'), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
    assert.throws(() => validateIdentifier(''), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
    assert.throws(() => validateIdentifier('   '), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
  });
});

describe('GitHub Link Header Parser', () => {
  it('parses standard RFC 5988 link headers', () => {
    const header = '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=5>; rel="last"';
    const result = parseLinkHeader(header);

    assert.equal(result.next, 'https://api.github.com/repositories/1/issues?page=2');
    assert.equal(result.last, 'https://api.github.com/repositories/1/issues?page=5');
  });

  it('returns empty object for empty or missing headers', () => {
    assert.deepEqual(parseLinkHeader(null), {});
    assert.deepEqual(parseLinkHeader(''), {});
    assert.deepEqual(parseLinkHeader(undefined), {});
  });
});

describe('GitHubClient HTTP Transport & Headers', () => {
  it('attaches proper GitHub headers and token authorization', async () => {
    let capturedUrl = '';
    let capturedHeaders = {};

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return new Response(JSON.stringify({ name: 'relay' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-limit': '5000',
        },
      });
    };

    const client = new GitHubClient({
      token: 'ghp_secret_token_12345',
      fetchFn: mockFetch,
    });

    const result = await client.get('/repos/owner/relay');

    assert.equal(capturedUrl, 'https://api.github.com/repos/owner/relay');
    assert.equal(capturedHeaders.Accept, 'application/vnd.github+json');
    assert.equal(capturedHeaders['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(capturedHeaders.Authorization, 'Bearer ghp_secret_token_12345');
    assert.equal(result.data.name, 'relay');
    assert.equal(result.rateLimit.remaining, 4999);
  });

  it('omits Authorization header when no token is configured', async () => {
    let capturedHeaders = {};

    const mockFetch = async (url, options) => {
      capturedHeaders = options.headers;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new GitHubClient({
      token: null,
      fetchFn: mockFetch,
    });

    await client.get('/rate_limit');
    assert.equal(capturedHeaders.Authorization, undefined);
  });

  it('blocks SSRF when pagination URL attempts to query untrusted origin', async () => {
    const client = new GitHubClient({
      baseUrl: 'https://api.github.com',
      fetchFn: async () => new Response('{}'),
    });

    await assert.rejects(
      async () => client.get('https://attacker-controlled.site/steal-data'),
      (err) => err.code === GITHUB_ERROR_CODES.INVALID_INPUT && err.message.includes('SSRF Warning')
    );
  });
});

describe('GitHubClient Error Categorization & Sanitization', () => {
  const secretToken = 'ghp_super_secret_creds_999';

  it('categorizes 401 as AUTH_FAILED and does not leak token in error', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });

    const client = new GitHubClient({ token: secretToken, fetchFn: mockFetch });

    await assert.rejects(
      async () => client.get('/user'),
      (err) => {
        assert.equal(err.code, GITHUB_ERROR_CODES.AUTH_FAILED);
        assert.equal(err.status, 401);
        assert.ok(!err.message.includes(secretToken));
        assert.ok(!JSON.stringify(err).includes(secretToken));
        return true;
      }
    );
  });

  it('categorizes 403 rate limit depletion as RATE_LIMITED', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-limit': '60',
      },
    });

    const client = new GitHubClient({ fetchFn: mockFetch });

    await assert.rejects(
      async () => client.get('/repos/owner/repo'),
      (err) => {
        assert.equal(err.code, GITHUB_ERROR_CODES.RATE_LIMITED);
        assert.equal(err.rateLimit.remaining, 0);
        return true;
      }
    );
  });

  it('categorizes 403 permission refusal as FORBIDDEN', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'x-ratelimit-remaining': '50',
      },
    });

    const client = new GitHubClient({ fetchFn: mockFetch });

    await assert.rejects(
      async () => client.get('/repos/owner/secret-repo'),
      (err) => err.code === GITHUB_ERROR_CODES.FORBIDDEN
    );
  });

  it('categorizes 404 as NOT_FOUND', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });

    const client = new GitHubClient({ fetchFn: mockFetch });

    await assert.rejects(
      async () => client.get('/repos/owner/nonexistent'),
      (err) => err.code === GITHUB_ERROR_CODES.NOT_FOUND
    );
  });

  it('categorizes 500+ as SERVER_ERROR', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ message: 'Internal Server Error' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });

    const client = new GitHubClient({ fetchFn: mockFetch });

    await assert.rejects(
      async () => client.get('/repos/owner/repo/issues'),
      (err) => err.code === GITHUB_ERROR_CODES.SERVER_ERROR
    );
  });
});

describe('GitHubClient Pagination Helper', () => {
  it('fetches multiple pages until next link is exhausted', async () => {
    let callCount = 0;

    const mockFetch = async (url) => {
      callCount++;
      if (url.includes('page=1') || !url.includes('page=2')) {
        return new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            link: '<https://api.github.com/repos/org/repo/issues?page=2>; rel="next"',
          },
        });
      }

      return new Response(JSON.stringify([{ id: 3 }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    };

    const client = new GitHubClient({ fetchFn: mockFetch });
    const result = await client.paginate('/repos/org/repo/issues', {}, { maxPages: 5 });

    assert.equal(callCount, 2);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.items.length, 3);
    assert.deepEqual(result.items.map((i) => i.id), [1, 2, 3]);
    assert.equal(result.hasMore, false);
  });

  it('respects maxPages limit', async () => {
    let callCount = 0;

    const mockFetch = async () => {
      callCount++;
      return new Response(JSON.stringify([{ id: callCount }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          link: '<https://api.github.com/repos/org/repo/issues?page=next>; rel="next"',
        },
      });
    };

    const client = new GitHubClient({ fetchFn: mockFetch });
    const result = await client.paginate('/repos/org/repo/issues', {}, { maxPages: 3 });

    assert.equal(callCount, 3);
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.hasMore, true);
    assert.equal(result.items.length, 3);
  });
});

describe('GitHubClient Timeout and Path Edge Cases', () => {
  it('aborts and throws TIMEOUT error when request exceeds timeoutMs', async () => {
    const slowFetch = async (_url, { signal }) => {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    const client = new GitHubClient({
      timeoutMs: 25,
      fetchFn: slowFetch,
    });

    await assert.rejects(
      async () => client.get('/repos/owner/repo'),
      (err) => err.code === GITHUB_ERROR_CODES.TIMEOUT && err.message.includes('timed out after 25ms')
    );
  });

  it('rejects protocol-relative path attempts', async () => {
    const client = new GitHubClient({ fetchFn: async () => new Response('{}') });

    await assert.rejects(
      async () => client.get('//malicious.com/api'),
      (err) => err.code === GITHUB_ERROR_CODES.INVALID_INPUT && err.message.includes('protocol-relative')
    );
  });
});

