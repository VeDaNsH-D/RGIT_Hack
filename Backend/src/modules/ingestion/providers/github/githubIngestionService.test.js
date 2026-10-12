/**
 * @file githubIngestionService.test.js
 * @description Unit tests for the unified GitHub fetch-and-normalize service.
 * All GitHub responses are mocked; no credentials or network access required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient } from './githubClient.js';
import { GITHUB_ERROR_CODES } from './githubErrors.js';
import {
  fetchGitHubRepositoryData,
  fetchGitHubRepositoryDataForInstallation,
  MAX_ITEMS_PER_RESOURCE,
} from './githubIngestionService.js';
import { validateSourceRecordCandidate } from '../../contracts/sourceRecord.js';

const PROJECT_ID = '665f1c2e8b3a4d0012345678';
const FIXED_NOW = new Date('2026-10-12T10:00:00Z');
const SECRET_TOKEN = 'ghs_unitTestInstallationTokenValue1234567890';

const REPO = {
  id: 42,
  node_id: 'R_kgDOrepo',
  name: 'relay',
  full_name: 'acme/relay',
  owner: { login: 'acme', id: 7 },
  description: 'Handoff platform',
  html_url: 'https://github.com/acme/relay',
  default_branch: 'main',
  language: 'JavaScript',
  private: true,
  visibility: 'private',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  permissions: { admin: true },
};

const ISSUES = [
  {
    id: 1, node_id: 'I_1', number: 1, title: 'Bug', body: 'Broken', state: 'open',
    user: { login: 'alice', id: 11 }, assignee: { login: 'bob' }, assignees: [{ login: 'bob' }],
    labels: [{ name: 'bug' }], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    html_url: 'https://github.com/acme/relay/issues/1',
  },
  // GitHub returns PRs from the issues endpoint; this must not become an issue record.
  {
    id: 2, node_id: 'I_2_pr_as_issue', number: 2, title: 'Add feature', state: 'open',
    pull_request: { url: 'https://api.github.com/repos/acme/relay/pulls/2' },
    user: { login: 'carol', id: 12 }, html_url: 'https://github.com/acme/relay/pull/2',
  },
];

const PULLS = [
  {
    id: 200, node_id: 'PR_2', number: 2, title: 'Add feature', body: 'Implements X', state: 'open',
    draft: true, merged_at: null, user: { login: 'carol', id: 12 },
    head: { ref: 'feature/x', sha: 'aaa' }, base: { ref: 'main', sha: 'bbb' },
    created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-02T00:00:00Z',
    html_url: 'https://github.com/acme/relay/pull/2',
  },
];

const COMMITS = [
  {
    sha: '1111111111111111111111111111111111111111', node_id: 'C_1',
    commit: {
      message: 'Fix login\n\nDetails',
      author: { name: 'Alice', email: 'a@example.com', date: '2026-03-01T00:00:00Z' },
      committer: { name: 'Alice', date: '2026-03-01T01:00:00Z' },
    },
    author: { login: 'alice', id: 11 },
    parents: [{ sha: '0000000000000000000000000000000000000000' }],
    html_url: 'https://github.com/acme/relay/commit/1111111111111111111111111111111111111111',
  },
];

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Creates a mock fetch that routes by URL path. `overrides` replace default
 * handlers; each handler receives the parsed URL.
 */
function mockGitHub(overrides = {}) {
  const calls = [];
  const handlers = {
    '/repos/acme/relay': () => json(REPO),
    '/repos/acme/relay/issues': () => json(ISSUES),
    '/repos/acme/relay/pulls': () => json(PULLS),
    '/repos/acme/relay/commits': () => json(COMMITS),
    ...overrides,
  };

  const fetchFn = async (url, opts) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), headers: opts.headers });
    const handler = handlers[parsed.pathname];
    if (!handler) return json({ message: 'Not Found' }, 404);
    return handler(parsed);
  };

  return { fetchFn, calls };
}

function run(fetchFn, extra = {}) {
  const client = new GitHubClient({ token: SECRET_TOKEN, fetchFn });
  return fetchGitHubRepositoryData({
    owner: 'acme',
    repo: 'relay',
    projectId: PROJECT_ID,
    client,
    now: () => FIXED_NOW,
    ...extra,
  });
}

function assertCountInvariant(result) {
  for (const [name, r] of Object.entries(result.resources)) {
    assert.equal(r.fetchedCount, r.normalizedCount + r.skippedCount + r.failedCount, `invariant for ${name}`);
  }
  assert.equal(result.fetchedCount, result.normalizedCount + result.skippedCount + result.failedCount);
}

describe('fetchGitHubRepositoryData: successful ingestion', () => {
  it('fetches and normalizes repository, issues, pull requests and commits', async () => {
    const { fetchFn } = mockGitHub();
    const { records, repository, result } = await run(fetchFn);

    assert.deepEqual(records.map((r) => r.recordType), ['repository', 'issue', 'pull_request', 'commit']);
    for (const record of records) {
      assert.deepEqual(validateSourceRecordCandidate(record), { valid: true, errors: [] });
      assert.equal(record.projectId, PROJECT_ID);
      assert.equal(record.provider, 'github');
      assert.equal(record.fetchedAt.toISOString(), FIXED_NOW.toISOString());
    }

    assert.equal(result.status, 'succeeded');
    assert.equal(result.persisted, false);
    assert.equal(result.createdCount, null);
    assert.equal(result.updatedCount, null);
    assert.deepEqual(result.errors, []);
    assert.equal(result.source.fullName, 'acme/relay');
    assertCountInvariant(result);

    // Safe repository metadata
    assert.equal(repository.fullName, 'acme/relay');
    assert.equal(repository.owner, 'acme');
    assert.equal(repository.language, 'JavaScript');
    assert.equal(repository.visibility, 'private');
    assert.equal(repository.defaultBranch, 'main');
    assert.equal(repository.createdAt, '2025-01-01T00:00:00Z');
    assert.equal(repository.permissions, undefined);
  });

  it('excludes pull requests from issue records and never duplicates a PR', async () => {
    const { fetchFn } = mockGitHub();
    const { records, result } = await run(fetchFn);

    const issues = records.filter((r) => r.recordType === 'issue');
    const prs = records.filter((r) => r.recordType === 'pull_request');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].metadata.number, 1);
    assert.equal(prs.length, 1);
    assert.equal(prs[0].metadata.number, 2);
    assert.ok(!records.some((r) => r.url === 'https://github.com/acme/relay/pull/2' && r.recordType === 'issue'));

    assert.equal(result.resources.issues.fetchedCount, 2);
    assert.equal(result.resources.issues.excludedPullRequestCount, 1);
    assert.equal(result.resources.issues.skippedCount, 1);
  });

  it('preserves issue, PR and commit provider metadata', async () => {
    const { fetchFn } = mockGitHub();
    const { records } = await run(fetchFn);
    const issue = records.find((r) => r.recordType === 'issue');
    const pr = records.find((r) => r.recordType === 'pull_request');
    const commit = records.find((r) => r.recordType === 'commit');

    assert.deepEqual(issue.metadata.labels, ['bug']);
    assert.equal(issue.metadata.assignee, 'bob');
    assert.equal(issue.author, 'alice');
    assert.equal(pr.metadata.draft, true);
    assert.equal(pr.metadata.merged, false);
    assert.equal(pr.metadata.head_branch, 'feature/x');
    assert.equal(pr.metadata.base_branch, 'main');
    assert.equal(commit.metadata.sha, COMMITS[0].sha);
    assert.equal(commit.title, 'Fix login');
    assert.equal(commit.createdAt.toISOString(), '2026-03-01T00:00:00.000Z');
  });

  it('sends the installation token only as an Authorization header', async () => {
    const { fetchFn, calls } = mockGitHub();
    await run(fetchFn);
    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.equal(call.headers.Authorization, `Bearer ${SECRET_TOKEN}`);
      assert.ok(!JSON.stringify(call.query).includes(SECRET_TOKEN));
    }
  });
});

describe('fetchGitHubRepositoryData: missing fields and empty repositories', () => {
  it('handles missing optional fields safely', async () => {
    const { fetchFn } = mockGitHub({
      '/repos/acme/relay': () => json({ id: 42, node_id: 'R_x', name: 'relay', full_name: 'acme/relay' }),
      '/repos/acme/relay/issues': () => json([{ id: 5, number: 5, title: null, body: null, user: null, labels: null }]),
      '/repos/acme/relay/pulls': () => json([{ id: 6, number: 6, title: 'T', body: null, user: null, head: null, base: null }]),
      '/repos/acme/relay/commits': () => json([{ sha: 'abcdef1234', commit: { message: '' }, author: null, parents: [null] }]),
    });
    const { records, repository, result } = await run(fetchFn);

    assert.equal(result.status, 'succeeded');
    assert.equal(records.length, 4);
    for (const record of records) assert.equal(validateSourceRecordCandidate(record).valid, true);

    const commit = records.find((r) => r.recordType === 'commit');
    assert.equal(commit.author, undefined);
    assert.equal(commit.title, 'Commit abcdef1234');
    assert.equal(records.find((r) => r.recordType === 'issue').title, 'Issue #5');
    assert.equal(repository.description, null);
    assert.equal(repository.defaultBranch, null);
  });

  it('treats an empty repository as a successful empty result, not a failure', async () => {
    const { fetchFn } = mockGitHub({
      '/repos/acme/relay/issues': () => json([]),
      '/repos/acme/relay/pulls': () => json([]),
      '/repos/acme/relay/commits': () => json({ message: 'Git Repository is empty.' }, 409),
    });
    const { records, result } = await run(fetchFn);

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.errors, []);
    assert.equal(records.length, 1);
    assert.equal(result.resources.commits.status, 'succeeded');
    assert.equal(result.resources.commits.repositoryEmpty, true);
    assert.equal(result.resources.issues.status, 'succeeded');
    assert.equal(result.resources.issues.fetchedCount, 0);
  });
});

describe('fetchGitHubRepositoryData: limits and pagination', () => {
  it('derives per_page from the item limit and stops at the limit', async () => {
    const page = (n) => Array.from({ length: 3 }, (_, i) => ({ id: n * 10 + i, node_id: `I_${n}_${i}`, number: n * 10 + i, title: 't' }));
    const { fetchFn, calls } = mockGitHub({
      '/repos/acme/relay/issues': (url) => {
        const p = Number(url.searchParams.get('page') || 1);
        return json(page(p), 200, { link: `<https://api.github.com/repos/acme/relay/issues?page=${p + 1}&per_page=3>; rel="next"` });
      },
    });
    const { result } = await run(fetchFn, { limits: { issues: 3, pullRequests: 1, commits: 1 } });

    const issueCalls = calls.filter((c) => c.path.endsWith('/issues'));
    assert.equal(issueCalls.length, 1);
    assert.equal(issueCalls[0].query.per_page, '3');
    assert.equal(result.resources.issues.normalizedCount, 3);
    assert.equal(result.resources.issues.hasMore, true);
    assert.equal(calls.find((c) => c.path.endsWith('/pulls')).query.per_page, '1');
  });

  it('trims items beyond the limit and counts them as skipped', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...COMMITS[0], sha: `${i}`.repeat(40), node_id: `C_${i}` }));
    const { fetchFn } = mockGitHub({ '/repos/acme/relay/commits': () => json(many) });
    const { result, records } = await run(fetchFn, { limits: { commits: 2 } });

    assert.equal(records.filter((r) => r.recordType === 'commit').length, 2);
    assert.equal(result.resources.commits.fetchedCount, 5);
    assert.equal(result.resources.commits.skippedCount, 3);
    assert.equal(result.resources.commits.hasMore, true);
    assertCountInvariant(result);
  });

  it('caps limits at MAX_ITEMS_PER_RESOURCE and bounds pages', async () => {
    const { fetchFn, calls } = mockGitHub();
    await run(fetchFn, { limits: { issues: 100000 } });
    const issueCall = calls.find((c) => c.path.endsWith('/issues'));
    assert.equal(issueCall.query.per_page, '100');
    assert.ok(MAX_ITEMS_PER_RESOURCE <= 2000);
  });

  it('a limit of 0 disables a category without requesting it', async () => {
    const { fetchFn, calls } = mockGitHub();
    const { result } = await run(fetchFn, { limits: { commits: 0 } });
    assert.ok(!calls.some((c) => c.path.endsWith('/commits')));
    assert.equal(result.resources.commits.status, 'skipped');
    assert.equal(result.resources.commits.skippedReason, 'disabled');
    assert.equal(result.status, 'succeeded');
  });

  it('drops duplicate records caused by shifting pagination', async () => {
    const { fetchFn } = mockGitHub({
      '/repos/acme/relay/pulls': (url) => {
        const p = Number(url.searchParams.get('page') || 1);
        const headers = p === 1 ? { link: '<https://api.github.com/repos/acme/relay/pulls?page=2>; rel="next"' } : {};
        return json(PULLS, 200, headers);
      },
    });
    const { records, result } = await run(fetchFn, { limits: { pullRequests: 101 } });
    assert.equal(records.filter((r) => r.recordType === 'pull_request').length, 1);
    assert.equal(result.resources.pullRequests.skippedCount, 1);
    assertCountInvariant(result);
  });
});

describe('fetchGitHubRepositoryData: partial and total failures', () => {
  it('keeps successful records when pull requests are rate limited', async () => {
    const { fetchFn } = mockGitHub({
      '/repos/acme/relay/pulls': () => json(
        { message: 'API rate limit exceeded for installation.' },
        403,
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791800000' },
      ),
    });
    const { records, result } = await run(fetchFn);

    assert.equal(result.status, 'partial');
    assert.deepEqual(records.map((r) => r.recordType), ['repository', 'issue', 'commit']);
    assert.equal(result.resources.pullRequests.status, 'failed');
    assert.equal(result.resources.pullRequests.fetchedCount, 0);
    assert.equal(result.resources.commits.status, 'succeeded');

    assert.equal(result.errors.length, 1);
    const [error] = result.errors;
    assert.equal(error.resource, 'pullRequests');
    assert.equal(error.code, GITHUB_ERROR_CODES.RATE_LIMITED);
    assert.equal(error.status, 403);
    assert.equal(error.retryAt, new Date(1791800000 * 1000).toISOString());
  });

  it('reports authentication failure on the repository and skips remaining requests', async () => {
    const { fetchFn, calls } = mockGitHub({
      '/repos/acme/relay': () => json({ message: 'Bad credentials' }, 401),
    });
    const { records, result } = await run(fetchFn);

    assert.equal(calls.length, 1);
    assert.equal(records.length, 0);
    assert.equal(result.status, 'failed');
    assert.equal(result.errors[0].code, GITHUB_ERROR_CODES.AUTH_FAILED);
    assert.equal(result.resources.issues.status, 'skipped');
    assert.equal(result.resources.issues.skippedReason, 'repository_unavailable');
  });

  it('reports a clear NOT_FOUND for a missing repository', async () => {
    const { fetchFn } = mockGitHub({ '/repos/acme/relay': () => json({ message: 'Not Found' }, 404) });
    const { result } = await run(fetchFn);
    assert.equal(result.status, 'failed');
    assert.equal(result.errors[0].code, GITHUB_ERROR_CODES.NOT_FOUND);
    assert.equal(result.errors[0].resource, 'repository');
  });

  it('continues after a non-fatal repository failure (server error)', async () => {
    const { fetchFn } = mockGitHub({ '/repos/acme/relay': () => json({ message: 'boom' }, 502) });
    const { records, result } = await run(fetchFn);
    assert.equal(result.status, 'partial');
    assert.equal(result.resources.repository.status, 'failed');
    assert.equal(records.length, 3);
  });

  it('classifies an unexpected (non-array) list response without crashing', async () => {
    const { fetchFn } = mockGitHub({ '/repos/acme/relay/issues': () => json({ unexpected: true }) });
    const { result, records } = await run(fetchFn);
    assert.equal(result.status, 'partial');
    assert.equal(result.resources.issues.status, 'failed');
    assert.equal(result.errors[0].code, GITHUB_ERROR_CODES.UNEXPECTED_RESPONSE);
    assert.equal(records.filter((r) => r.recordType === 'issue').length, 0);
  });

  it('records per-item normalization failures without dropping the batch', async () => {
    const { fetchFn } = mockGitHub({
      '/repos/acme/relay/commits': () => json([COMMITS[0], { commit: { message: 'no sha' } }]),
    });
    const { result, records } = await run(fetchFn);
    assert.equal(records.filter((r) => r.recordType === 'commit').length, 1);
    assert.equal(result.resources.commits.failedCount, 1);
    assert.equal(result.errors[0].code, GITHUB_ERROR_CODES.NORMALIZATION_FAILED);
    assert.equal(result.status, 'partial');
    assertCountInvariant(result);
  });

  it('classifies timeouts per resource', async () => {
    const hang = (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const { fetchFn } = mockGitHub();
    const wrapped = (url, opts) => (new URL(url).pathname.endsWith('/commits') ? hang(url, opts) : fetchFn(url, opts));
    const client = new GitHubClient({ token: SECRET_TOKEN, fetchFn: wrapped, timeoutMs: 20 });
    const { result } = await fetchGitHubRepositoryData({ owner: 'acme', repo: 'relay', projectId: PROJECT_ID, client });
    assert.equal(result.resources.commits.status, 'failed');
    assert.equal(result.errors[0].code, GITHUB_ERROR_CODES.TIMEOUT);
  });

  it('never leaks the token into results or errors', async () => {
    const { fetchFn } = mockGitHub({
      '/repos/acme/relay/pulls': () => json({ message: `Bad credentials token ${SECRET_TOKEN}` }, 401),
    });
    const output = await run(fetchFn);
    assert.ok(!JSON.stringify(output).includes(SECRET_TOKEN));
    assert.ok(JSON.stringify(output.result.errors).includes('[REDACTED]'));
  });
});

describe('fetchGitHubRepositoryData: input validation', () => {
  it('rejects invalid owner/repo before any request', async () => {
    const { fetchFn, calls } = mockGitHub();
    const client = new GitHubClient({ token: SECRET_TOKEN, fetchFn });
    const bad = [
      { owner: '../etc', repo: 'relay' },
      { owner: 'acme', repo: 'relay/../../x' },
      { owner: '', repo: 'relay' },
      { owner: 'acme', repo: 'a'.repeat(101) },
      { owner: 'acme?x=1', repo: 'relay' },
    ];
    for (const input of bad) {
      await assert.rejects(
        () => fetchGitHubRepositoryData({ ...input, projectId: PROJECT_ID, client }),
        { code: GITHUB_ERROR_CODES.INVALID_INPUT },
      );
    }
    assert.equal(calls.length, 0);
  });

  it('rejects missing projectId, bad limits, bad since and missing client', async () => {
    const client = new GitHubClient({ token: SECRET_TOKEN, fetchFn: async () => json({}) });
    const base = { owner: 'acme', repo: 'relay', projectId: PROJECT_ID, client };
    for (const override of [{ projectId: '' }, { limits: { issues: -1 } }, { limits: { commits: 1.5 } }, { since: 'yesterday' }, { client: null }]) {
      await assert.rejects(() => fetchGitHubRepositoryData({ ...base, ...override }), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
    }
  });

  it('passes since through as ISO 8601 to issues and commits', async () => {
    const { fetchFn, calls } = mockGitHub();
    await run(fetchFn, { since: new Date('2026-09-01T00:00:00Z') });
    assert.equal(calls.find((c) => c.path.endsWith('/issues')).query.since, '2026-09-01T00:00:00.000Z');
    assert.equal(calls.find((c) => c.path.endsWith('/commits')).query.since, '2026-09-01T00:00:00.000Z');
  });
});

describe('fetchGitHubRepositoryDataForInstallation', () => {
  it('builds the client from the installation auth service', async () => {
    const { fetchFn, calls } = mockGitHub();
    const authService = {
      createInstallationClient: async (installationId) => {
        assert.equal(installationId, 170530734);
        return { client: new GitHubClient({ token: SECRET_TOKEN, fetchFn }) };
      },
    };
    const { result } = await fetchGitHubRepositoryDataForInstallation({
      authService, installationId: 170530734, owner: 'acme', repo: 'relay', projectId: PROJECT_ID,
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(calls.length, 4);
  });

  it('validates inputs before exchanging a token', async () => {
    let exchanged = false;
    const authService = { createInstallationClient: async () => { exchanged = true; } };
    await assert.rejects(
      () => fetchGitHubRepositoryDataForInstallation({ authService, installationId: 1, owner: '..', repo: 'x', projectId: PROJECT_ID }),
      { code: GITHUB_ERROR_CODES.INVALID_INPUT },
    );
    assert.equal(exchanged, false);
  });
});
