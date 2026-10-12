/**
 * @file githubNormalizer.test.js
 * @description Comprehensive unit tests for GitHub data normalizers and SourceRecordCandidate alignment.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRepository,
  normalizeIssue,
  normalizePullRequest,
  normalizeCommit,
  normalizeIssues,
  normalizePullRequests,
  normalizeCommits,
  parseDate,
} from './githubNormalizer.js';
import {
  SOURCE_PROVIDERS,
  SOURCE_RECORD_TYPES,
  SOURCE_CONTENT_TYPES,
  validateSourceRecordCandidate,
} from '../../contracts/sourceRecord.js';
import { GITHUB_ERROR_CODES } from './githubErrors.js';

describe('GitHub Normalizer: Date Parsing Utility', () => {
  it('parses Date instances and ISO strings correctly', () => {
    const now = new Date();
    assert.equal(parseDate(now), now);

    const isoStr = '2026-10-12T10:00:00.000Z';
    const parsed = parseDate(isoStr);
    assert.ok(parsed instanceof Date);
    assert.equal(parsed.toISOString(), isoStr);
  });

  it('returns undefined for invalid dates and non-date values', () => {
    assert.equal(parseDate(null), undefined);
    assert.equal(parseDate(''), undefined);
    assert.equal(parseDate('not-a-date'), undefined);
    assert.equal(parseDate(new Date('invalid')), undefined);
  });
});

describe('Contract Validation: SourceRecordCandidate Guardrails', () => {
  it('rejects candidate records that prematurely include internal database IDs', () => {
    const candidateWithDbId = {
      id: 'internal_mongo_id_123',
      projectId: 'proj_1',
      provider: SOURCE_PROVIDERS.GITHUB,
      recordType: SOURCE_RECORD_TYPES.ISSUE,
      externalId: 'ext_1',
      title: 'Issue 1',
      content: 'body',
      contentType: SOURCE_CONTENT_TYPES.MARKDOWN,
      fetchedAt: new Date(),
      version: 1,
      isActive: true,
      isDeleted: false,
    };

    const result = validateSourceRecordCandidate(candidateWithDbId);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Candidate records must not include internal database IDs')));
  });

  it('rejects candidate records containing deprecated observedAt field', () => {
    const candidateWithObservedAt = {
      projectId: 'proj_1',
      provider: SOURCE_PROVIDERS.GITHUB,
      recordType: SOURCE_RECORD_TYPES.ISSUE,
      externalId: 'ext_1',
      title: 'Issue 1',
      content: 'body',
      contentType: SOURCE_CONTENT_TYPES.MARKDOWN,
      observedAt: new Date(),
      fetchedAt: new Date(),
      version: 1,
      isActive: true,
      isDeleted: false,
    };

    const result = validateSourceRecordCandidate(candidateWithObservedAt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('observedAt')));
  });
});

describe('GitHub Normalizer: Repository Normalization', () => {
  const sampleRepo = {
    id: 998877,
    node_id: 'R_kgDOHsample',
    name: 'relay',
    full_name: 'relay-continuity/relay',
    description: 'Digital handoff & continuity platform',
    html_url: 'https://github.com/relay-continuity/relay',
    owner: { login: 'relay-continuity', id: 554433 },
    default_branch: 'main',
    language: 'JavaScript',
    topics: ['continuity', 'handoff'],
    stargazers_count: 42,
    forks_count: 5,
    open_issues_count: 3,
    updated_at: '2026-10-12T08:00:00Z',
    pushed_at: '2026-10-12T09:00:00Z',
    created_at: '2026-10-01T00:00:00Z',
  };

  it('normalizes a complete repository object into a valid SourceRecordCandidate', () => {
    const fixedFetchedAt = new Date('2026-10-12T12:00:00Z');
    const record = normalizeRepository(sampleRepo, {
      projectId: 'proj_relay_001',
      fetchedAt: fixedFetchedAt,
    });

    assert.equal(record.projectId, 'proj_relay_001');
    assert.equal(record.provider, SOURCE_PROVIDERS.GITHUB);
    assert.equal(record.recordType, SOURCE_RECORD_TYPES.REPOSITORY);
    assert.equal(record.externalId, 'R_kgDOHsample');
    assert.equal(record.title, 'relay-continuity/relay');
    assert.ok(record.content.includes('Digital handoff'));
    assert.ok(record.content.includes('Primary language: JavaScript'));
    assert.equal(record.contentType, SOURCE_CONTENT_TYPES.PLAIN);
    assert.equal(record.url, 'https://github.com/relay-continuity/relay');
    assert.equal(record.author, 'relay-continuity');
    assert.equal(record.authorId, '554433');
    assert.equal(record.createdAt.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(record.updatedAt.toISOString(), '2026-10-12T08:00:00.000Z');
    assert.equal(record.fetchedAt, fixedFetchedAt);
    assert.equal(record.version, 1);
    assert.equal(record.isActive, true);
    assert.equal(record.isDeleted, false);
    assert.equal('observedAt' in record, false);
    assert.equal('id' in record, false);
    assert.equal('_id' in record, false);
  });

  it('handles missing optional repository fields gracefully', () => {
    const sparseRepo = {
      id: 111,
      name: 'sparse-repo',
    };

    const record = normalizeRepository(sparseRepo, { projectId: 'proj_1' });

    assert.equal(record.externalId, '111');
    assert.equal(record.title, 'sparse-repo');
    assert.equal(record.content, '');
    assert.equal(record.url, undefined);
    assert.equal(record.author, undefined);
    assert.equal(record.authorId, undefined);
    assert.equal(record.createdAt, undefined);
    assert.equal(record.updatedAt, undefined);
    assert.equal('observedAt' in record, false);
  });

  it('does not mutate the input repository object', () => {
    const frozenRepo = Object.freeze({ ...sampleRepo, owner: Object.freeze({ ...sampleRepo.owner }) });
    assert.doesNotThrow(() => normalizeRepository(frozenRepo, { projectId: 'proj_1' }));
  });

  it('throws an error if projectId is missing or invalid', () => {
    assert.throws(
      () => normalizeRepository(sampleRepo, {}),
      { code: GITHUB_ERROR_CODES.INVALID_INPUT }
    );
    assert.throws(
      () => normalizeRepository(sampleRepo, { projectId: '   ' }),
      { code: GITHUB_ERROR_CODES.INVALID_INPUT }
    );
  });
});

describe('GitHub Normalizer: Issue Normalization', () => {
  const sampleIssue = {
    id: 101,
    node_id: 'I_kwDOissue101',
    number: 42,
    title: 'Data ingestion rate limit bug',
    body: 'When fetching issues, 403 occurs if tokens are not passed.',
    html_url: 'https://github.com/org/repo/issues/42',
    user: { login: 'engineer-alice', id: 12345 },
    state: 'open',
    state_reason: null,
    comments: 5,
    labels: [{ name: 'bug' }, { name: 'backend' }],
    created_at: '2026-10-10T10:00:00Z',
    updated_at: '2026-10-12T06:30:00Z',
    closed_at: null,
    pull_request: undefined,
  };

  it('normalizes an issue with node_id, separate createdAt/updatedAt, and authorId', () => {
    const record = normalizeIssue(sampleIssue, {
      projectId: 'proj_relay_001',
      repoFullName: 'org/repo',
    });

    assert.equal(record.provider, SOURCE_PROVIDERS.GITHUB);
    assert.equal(record.recordType, SOURCE_RECORD_TYPES.ISSUE);
    assert.equal(record.externalId, 'I_kwDOissue101');
    assert.equal(record.title, 'Data ingestion rate limit bug');
    assert.equal(record.content, sampleIssue.body);
    assert.equal(record.contentType, SOURCE_CONTENT_TYPES.MARKDOWN);
    assert.equal(record.author, 'engineer-alice');
    assert.equal(record.authorId, '12345');
    assert.equal(record.createdAt.toISOString(), '2026-10-10T10:00:00.000Z');
    assert.equal(record.updatedAt.toISOString(), '2026-10-12T06:30:00.000Z');
    assert.equal(record.version, 1);
    assert.equal(record.isActive, true);
    assert.equal(record.isDeleted, false);
    assert.equal('observedAt' in record, false);
    assert.equal('id' in record, false);
    assert.equal('_id' in record, false);
  });

  it('scopes externalId with repository prefix when node_id is absent', () => {
    const issueWithoutNodeId = {
      id: 202,
      number: 15,
      title: 'Scoped issue',
      body: 'Some description',
    };

    const record = normalizeIssue(issueWithoutNodeId, {
      projectId: 'proj_1',
      repoFullName: 'relay/backend',
    });

    assert.equal(record.externalId, 'relay/backend#issue-15');
  });

  it('converts null or missing issue body to an empty string without failing', () => {
    const issueWithNullBody = {
      id: 303,
      number: 9,
      title: 'No description provided',
      body: null,
    };

    const record = normalizeIssue(issueWithNullBody, { projectId: 'proj_1' });
    assert.equal(record.content, '');
    assert.equal(typeof record.content, 'string');
    assert.equal('observedAt' in record, false);
  });

  it('marks closed issues as isActive: false', () => {
    const closedIssue = {
      ...sampleIssue,
      state: 'closed',
    };
    const record = normalizeIssue(closedIssue, { projectId: 'proj_1' });
    assert.equal(record.isActive, false);
  });
});

describe('GitHub Normalizer: Pull Request Normalization', () => {
  const samplePR = {
    id: 501,
    node_id: 'PR_kwDOpr501',
    number: 7,
    title: 'Feature: Ingestion normalization pipeline',
    body: 'Implements pure normalization functions for GitHub entities.',
    html_url: 'https://github.com/org/repo/pull/7',
    user: { login: 'engineer-bob', id: 67890 },
    state: 'open',
    draft: false,
    merged: false,
    merged_at: null,
    base: { ref: 'main' },
    head: { ref: 'feat/normalization' },
    labels: [{ name: 'enhancement' }],
    created_at: '2026-10-11T12:00:00Z',
    updated_at: '2026-10-12T07:15:00Z',
  };

  it('normalizes a pull request with separate timestamps and Markdown contentType', () => {
    const record = normalizePullRequest(samplePR, {
      projectId: 'proj_relay_001',
      repoFullName: 'org/repo',
    });

    assert.equal(record.provider, SOURCE_PROVIDERS.GITHUB);
    assert.equal(record.recordType, SOURCE_RECORD_TYPES.PULL_REQUEST);
    assert.equal(record.externalId, 'PR_kwDOpr501');
    assert.equal(record.title, 'Feature: Ingestion normalization pipeline');
    assert.equal(record.contentType, SOURCE_CONTENT_TYPES.MARKDOWN);
    assert.equal(record.author, 'engineer-bob');
    assert.equal(record.authorId, '67890');
    assert.equal(record.createdAt.toISOString(), '2026-10-11T12:00:00.000Z');
    assert.equal(record.updatedAt.toISOString(), '2026-10-12T07:15:00.000Z');
    assert.equal(record.version, 1);
    assert.equal(record.isActive, true);
    assert.equal(record.isDeleted, false);
    assert.equal('observedAt' in record, false);
  });

  it('converts null PR body to empty string', () => {
    const prNullBody = {
      id: 601,
      number: 12,
      title: 'PR with no description',
      body: null,
    };

    const record = normalizePullRequest(prNullBody, { projectId: 'proj_1' });
    assert.equal(record.content, '');
  });
});

describe('GitHub Normalizer: Commit Normalization', () => {
  const fullSha = '9f8e7d6c5b4a3210fedcba987654321012345678';
  const sampleCommit = {
    sha: fullSha,
    node_id: 'C_kwDOcommit123',
    html_url: `https://github.com/org/repo/commit/${fullSha}`,
    author: { login: 'committer-charlie', id: 445566 },
    commit: {
      message: 'feat: add GitHub client\n\nDetailed message explaining client design and options.',
      author: {
        name: 'Charlie Smith',
        email: 'charlie@example.com',
        date: '2026-10-12T05:00:00Z',
      },
      committer: {
        name: 'Charlie Smith',
        date: '2026-10-12T05:30:00Z',
      },
    },
    parents: [{ sha: '1111111' }, { sha: '2222222' }],
  };

  it('normalizes commit with repository-qualified externalId, full SHA preservation, and distinct author/committer dates', () => {
    const record = normalizeCommit(sampleCommit, {
      projectId: 'proj_relay_001',
      repoFullName: 'org/repo',
    });

    assert.equal(record.provider, SOURCE_PROVIDERS.GITHUB);
    assert.equal(record.recordType, SOURCE_RECORD_TYPES.COMMIT);
    assert.equal(record.externalId, `org/repo#commit-${fullSha}`);
    assert.equal(record.title, 'feat: add GitHub client');
    assert.equal(record.content, sampleCommit.commit.message);
    assert.equal(record.contentType, SOURCE_CONTENT_TYPES.PLAIN);
    assert.equal(record.author, 'committer-charlie');
    assert.equal(record.authorId, '445566');
    assert.equal(record.createdAt.toISOString(), '2026-10-12T05:00:00.000Z');
    assert.equal(record.updatedAt.toISOString(), '2026-10-12T05:30:00.000Z');
    assert.equal(record.metadata.sha, fullSha);
    assert.equal('observedAt' in record, false);
    assert.equal('id' in record, false);
    assert.equal('_id' in record, false);
  });

  it('preserves full SHA in title fallback when commit message is empty', () => {
    const commitEmptyMsg = {
      sha: fullSha,
      commit: { message: '' },
    };

    const record = normalizeCommit(commitEmptyMsg, { projectId: 'proj_1' });
    assert.equal(record.title, `Commit ${fullSha}`);
    assert.ok(!record.title.includes('Commit unknown'));
  });

  it('rejects commit missing full SHA', () => {
    assert.throws(
      () => normalizeCommit({ commit: { message: 'No sha' } }, { projectId: 'proj_1' }),
      { code: GITHUB_ERROR_CODES.INVALID_INPUT }
    );
  });
});

describe('GitHub Normalizer: Batch Operations', () => {
  it('applies a uniform batch fetchedAt timestamp across all items', () => {
    const batchTime = new Date('2026-10-12T15:30:00Z');
    const rawIssues = [
      { id: 1, number: 1, title: 'One', body: 'text 1' },
      { id: 2, number: 2, title: 'Two', body: 'text 2' },
    ];

    const records = normalizeIssues(rawIssues, {
      projectId: 'proj_batch',
      repoFullName: 'org/repo',
      fetchedAt: batchTime,
    });

    assert.equal(records.length, 2);
    assert.equal(records[0].fetchedAt, batchTime);
    assert.equal(records[1].fetchedAt, batchTime);
    assert.equal('observedAt' in records[0], false);
    assert.equal('observedAt' in records[1], false);
  });

  it('rejects non-array inputs for batch normalizers', () => {
    assert.throws(() => normalizeIssues(null, { projectId: 'proj_1' }), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
    assert.throws(() => normalizePullRequests('invalid', { projectId: 'proj_1' }), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
    assert.throws(() => normalizeCommits({}, { projectId: 'proj_1' }), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
  });
});
