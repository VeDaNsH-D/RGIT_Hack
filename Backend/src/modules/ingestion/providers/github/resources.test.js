/**
 * @file resources.test.js
 * @description Unit tests for GitHub resource fetchers (repositories, issues, pull requests, commits).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from './githubClient.js';
import { GITHUB_ERROR_CODES } from './githubErrors.js';
import { fetchRepositoryMetadata } from './repositories.js';
import { fetchIssues } from './issues.js';
import { fetchPullRequests } from './pullRequests.js';
import { fetchCommits } from './commits.js';

describe('GitHub Resource Fetcher: Repositories', () => {
  it('successfully retrieves repository metadata', async () => {
    const mockRepoPayload = {
      id: 12345,
      name: 'relay',
      full_name: 'relay-org/relay',
      description: 'Continuity platform',
      default_branch: 'main',
    };

    const mockFetch = async (url) => {
      assert.equal(url, 'https://api.github.com/repos/relay-org/relay');
      return new Response(JSON.stringify(mockRepoPayload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-remaining': '4990',
        },
      });
    };

    const client = new GitHubClient({ fetchFn: mockFetch });
    const result = await fetchRepositoryMetadata(client, 'relay-org', 'relay');

    assert.equal(result.repository.id, 12345);
    assert.equal(result.repository.name, 'relay');
    assert.equal(result.rateLimit.remaining, 4990);
  });

  it('validates owner and repo identifiers', async () => {
    const client = new GitHubClient({ fetchFn: async () => new Response('{}') });

    await assert.rejects(
      async () => fetchRepositoryMetadata(client, '../malicious', 'relay'),
      { code: GITHUB_ERROR_CODES.INVALID_INPUT }
    );

    await assert.rejects(
      async () => fetchRepositoryMetadata(client, 'relay-org', 're/po'),
      { code: GITHUB_ERROR_CODES.INVALID_INPUT }
    );
  });

  it('propagates client errors correctly', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });

    const client = new GitHubClient({ fetchFn: mockFetch });

    await assert.rejects(
      async () => fetchRepositoryMetadata(client, 'relay-org', 'unknown-repo'),
      (err) => {
        assert.equal(err.code, GITHUB_ERROR_CODES.NOT_FOUND);
        assert.equal(err.status, 404);
        return true;
      }
    );
  });
});

describe('GitHub Resource Fetcher: Issues', () => {
  it('fetches issues and excludes pull requests by default', async () => {
    const mixedPayload = [
      { id: 101, number: 1, title: 'Real Issue', body: 'Bug report' },
      { id: 102, number: 2, title: 'Pull Request as Issue', body: 'Fix PR', pull_request: { url: 'https://...' } },
      { id: 103, number: 3, title: 'Another Issue', body: 'Enhancement' },
    ];

    const mockFetch = async (url) => {
      assert.ok(url.includes('/repos/org/project/issues'));
      return new Response(JSON.stringify(mixedPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new GitHubClient({ fetchFn: mockFetch });
    const result = await fetchIssues(client, 'org', 'project');

    assert.equal(result.totalFetched, 2);
    assert.deepEqual(result.issues.map((i) => i.id), [101, 103]);
    assert.ok(result.issues.every((i) => !i.pull_request));
  });

  it('includes pull requests when excludePullRequests is false', async () => {
    const mixedPayload = [
      { id: 101, number: 1, title: 'Issue 1' },
      { id: 102, number: 2, title: 'PR 1', pull_request: {} },
    ];

    const mockFetch = async () => new Response(JSON.stringify(mixedPayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const client = new GitHubClient({ fetchFn: mockFetch });
    const result = await fetchIssues(client, 'org', 'project', { excludePullRequests: false });

    assert.equal(result.totalFetched, 2);
    assert.deepEqual(result.issues.map((i) => i.id), [101, 102]);
  });

  it('rejects invalid state values', async () => {
    const client = new GitHubClient({ fetchFn: async () => new Response('[]') });

    await assert.rejects(
      async () => fetchIssues(client, 'org', 'project', { state: 'invalid-state' }),
      { code: GITHUB_ERROR_CODES.INVALID_INPUT }
    );
  });

  it('handles pagination and honors maxPages', async () => {
    let callCount = 0;
    const mockFetch = async (url) => {
      callCount++;
      const hasPage2 = url.includes('page=2');
      return new Response(JSON.stringify([{ id: callCount, title: `Issue ${callCount}` }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          link: !hasPage2 ? '<https://api.github.com/repos/org/project/issues?page=2>; rel="next"' : '',
        },
      });
    };

    const client = new GitHubClient({ fetchFn: mockFetch });
    const result = await fetchIssues(client, 'org', 'project', { maxPages: 2 });

    assert.equal(callCount, 2);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.totalFetched, 2);
  });
});

describe('GitHub Resource Fetcher: Pull Requests', () => {
  it('fetches pull requests with state filter and pagination parameters', async () => {
    let capturedUrl = '';
    const mockPRs = [
      { id: 501, number: 10, title: 'Feat: Add ingestion', state: 'open' },
    ];

    const mockFetch = async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify(mockPRs), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new GitHubClient({ fetchFn: mockFetch });
    const result = await fetchPullRequests(client, 'org', 'repo', {
      state: 'open',
      perPage: 25,
      maxPages: 1,
    });

    assert.ok(capturedUrl.includes('/repos/org/repo/pulls'));
    assert.ok(capturedUrl.includes('state=open'));
    assert.ok(capturedUrl.includes('per_page=25'));
    assert.equal(result.totalFetched, 1);
    assert.equal(result.pullRequests[0].id, 501);
  });

  it('rejects invalid PR state', async () => {
    const client = new GitHubClient({ fetchFn: async () => new Response('[]') });

    await assert.rejects(
      async () => fetchPullRequests(client, 'org', 'repo', { state: 'archived' }),
      { code: GITHUB_ERROR_CODES.INVALID_INPUT }
    );
  });
});

describe('GitHub Resource Fetcher: Commits', () => {
  it('fetches commits with optional branch SHA filter', async () => {
    let capturedUrl = '';
    const mockCommits = [
      { sha: 'abc1234', commit: { message: 'Initial commit', author: { name: 'Alice' } } },
    ];

    const mockFetch = async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify(mockCommits), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new GitHubClient({ fetchFn: mockFetch });
    const result = await fetchCommits(client, 'org', 'repo', {
      sha: 'feature/auth-setup',
      perPage: 15,
    });

    assert.ok(capturedUrl.includes('/repos/org/repo/commits'));
    assert.ok(capturedUrl.includes('sha=feature%2Fauth-setup') || capturedUrl.includes('sha=feature/auth-setup'));
    assert.ok(capturedUrl.includes('per_page=15'));
    assert.equal(result.totalFetched, 1);
    assert.equal(result.commits[0].sha, 'abc1234');
  });

  it('rejects invalid or path-traversal Git SHA/ref', async () => {
    const client = new GitHubClient({ fetchFn: async () => new Response('[]') });

    await assert.rejects(
      async () => fetchCommits(client, 'org', 'repo', { sha: '../master' }),
      { code: GITHUB_ERROR_CODES.INVALID_INPUT }
    );

    await assert.rejects(
      async () => fetchCommits(client, 'org', 'repo', { sha: 'branch;rm -rf' }),
      { code: GITHUB_ERROR_CODES.INVALID_INPUT }
    );
  });

  it('enforces valid GitHubClient parameter', async () => {
    await assert.rejects(
      async () => fetchCommits(null, 'org', 'repo'),
      TypeError
    );

    await assert.rejects(
      async () => fetchCommits({}, 'org', 'repo'),
      TypeError
    );
  });
});
