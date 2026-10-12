/**
 * @file githubIngestionService.js
 * @description Unified GitHub fetch-and-normalize workflow.
 *
 * Orchestrates the resource fetchers (repository, issues, pull requests,
 * commits) and normalizers into SourceRecordCandidates plus a structured
 * IngestionResult. It performs NO persistence: `result.persisted` is false and
 * `createdCount`/`updatedCount` are null. A later persistence adapter consumes
 * `records` (see contracts/sourceRecord.js#toSourceRecordDocument).
 *
 * Partial failures: each resource category is fetched independently. A failed
 * category is reported in `result.errors` and `result.resources[name].status`
 * while records from successful categories are retained. A failed request is
 * never reported as an empty success; an empty repository is.
 *
 * Count conventions (per category and in total):
 *   fetchedCount    = items returned by GitHub
 *   skippedCount    = items intentionally excluded: pull requests returned by the
 *                     issues endpoint, items beyond the configured limit, and
 *                     duplicate externalIds within the run
 *   failedCount     = items that failed normalization/contract validation
 *   normalizedCount = valid candidates returned in `records`
 *   fetchedCount === normalizedCount + skippedCount + failedCount
 */

import { validateIdentifier } from './githubClient.js';
import { GITHUB_ERROR_CODES, GitHubApiError, toSafeErrorSummary } from './githubErrors.js';
import { fetchRepositoryMetadata, mapRepositoryMetadata } from './repositories.js';
import { fetchIssues } from './issues.js';
import { fetchPullRequests } from './pullRequests.js';
import { fetchCommits } from './commits.js';
import {
  normalizeRepository,
  normalizeIssue,
  normalizePullRequest,
  normalizeCommit,
  parseDate,
} from './githubNormalizer.js';
import {
  SOURCE_PROVIDERS,
  RESOURCE_STATUS,
  createIngestionResult,
  finalizeIngestionResult,
} from '../../contracts/sourceRecord.js';

/** Resource categories, in fetch order. */
export const GITHUB_RESOURCES = Object.freeze(['repository', 'issues', 'pullRequests', 'commits']);

/** Default per-category item limits for a single run. */
export const DEFAULT_INGESTION_LIMITS = Object.freeze({
  issues: 100,
  pullRequests: 100,
  commits: 50,
});

/** Hard ceiling on items per category, regardless of caller-supplied limits. */
export const MAX_ITEMS_PER_RESOURCE = 500;

// Per-record normalization errors kept in result.errors (failedCount still counts all).
const MAX_RECORD_ERRORS = 25;

// Repository-metadata failures that make the remaining requests pointless.
const FATAL_REPOSITORY_CODES = new Set([
  GITHUB_ERROR_CODES.AUTH_FAILED,
  GITHUB_ERROR_CODES.FORBIDDEN,
  GITHUB_ERROR_CODES.NOT_FOUND,
  GITHUB_ERROR_CODES.RATE_LIMITED,
]);

/**
 * Resolves a per-category item limit. 0 disables the category.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
function resolveLimit(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new GitHubApiError(`Invalid limit for "${name}": must be a non-negative integer.`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }
  return Math.min(n, MAX_ITEMS_PER_RESOURCE);
}

/**
 * Converts an item limit into GitHub paging parameters.
 *
 * @param {number} maxItems
 * @returns {{ perPage: number, maxPages: number }}
 */
function pagingFor(maxItems) {
  const perPage = Math.min(100, maxItems);
  return { perPage, maxPages: Math.ceil(maxItems / perPage) };
}

/**
 * Validates every caller-controlled input before any network request is made.
 *
 * @returns {{ owner: string, repo: string, projectId: string, limits: Record<string, number>, since: string|undefined }}
 */
function validateRequest({ owner, repo, projectId, client, limits = {}, since }) {
  if (!client || typeof client.get !== 'function' || typeof client.paginate !== 'function') {
    throw new GitHubApiError('A valid GitHubClient instance is required.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new GitHubApiError('Invalid projectId: must be a non-empty string.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  if (limits === null || typeof limits !== 'object') {
    throw new GitHubApiError('Invalid limits: must be an object.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  let sinceIso;
  if (since !== undefined && since !== null) {
    const parsed = parseDate(since);
    if (!parsed) {
      throw new GitHubApiError('Invalid since: must be a valid date or ISO 8601 string.', {
        code: GITHUB_ERROR_CODES.INVALID_INPUT,
      });
    }
    sinceIso = parsed.toISOString();
  }

  return {
    owner: validateIdentifier(owner, 'owner'),
    repo: validateIdentifier(repo, 'repo'),
    projectId: projectId.trim(),
    limits: {
      issues: resolveLimit(limits.issues, DEFAULT_INGESTION_LIMITS.issues, 'issues'),
      pullRequests: resolveLimit(limits.pullRequests, DEFAULT_INGESTION_LIMITS.pullRequests, 'pullRequests'),
      commits: resolveLimit(limits.commits, DEFAULT_INGESTION_LIMITS.commits, 'commits'),
    },
    since: sinceIso,
  };
}

/**
 * Builds a sanitized error entry for a failed resource category.
 *
 * @param {string} resource
 * @param {unknown} err
 * @returns {import('../../contracts/sourceRecord.js').IngestionError}
 */
function resourceError(resource, err) {
  const summary = toSafeErrorSummary(err);
  const entry = { resource, ...summary };

  if (err instanceof GitHubApiError && summary.code === GITHUB_ERROR_CODES.RATE_LIMITED && err.rateLimit) {
    if (err.rateLimit.reset instanceof Date && !isNaN(err.rateLimit.reset.getTime())) {
      entry.retryAt = err.rateLimit.reset.toISOString();
    }
    if (typeof err.rateLimit.retryAfterSeconds === 'number') {
      entry.retryAfterSeconds = err.rateLimit.retryAfterSeconds;
    }
  }

  return entry;
}

/**
 * Fetches repository metadata, issues, pull requests, and recent commits for a
 * single repository and normalizes them into SourceRecordCandidates.
 *
 * Input errors (bad owner/repo/projectId/limits/client) throw INVALID_INPUT
 * before any request. Provider errors never throw; they are reported in the result.
 *
 * @param {Object} params
 * @param {string} params.owner - Repository owner (validated).
 * @param {string} params.repo - Repository name (validated).
 * @param {string} params.projectId - Relay project ID the candidates belong to.
 * @param {import('./githubClient.js').GitHubClient} params.client - Client authenticated with an installation token.
 * @param {{ issues?: number, pullRequests?: number, commits?: number }} [params.limits] - Max items per
 *   category (default DEFAULT_INGESTION_LIMITS, capped at MAX_ITEMS_PER_RESOURCE, 0 disables).
 * @param {Date|string} [params.since] - Only issues updated / commits made at or after this time.
 * @param {() => Date} [params.now] - Clock override for tests.
 * @returns {Promise<{
 *   records: import('../../contracts/sourceRecord.js').SourceRecordCandidate[],
 *   repository: ReturnType<typeof mapRepositoryMetadata>|null,
 *   result: import('../../contracts/sourceRecord.js').IngestionResult & { source: Object }
 * }>}
 */
export async function fetchGitHubRepositoryData(params = {}) {
  const { client, now = () => new Date() } = params;
  const { owner, repo, projectId, limits, since } = validateRequest(params);

  const fetchedAt = now();
  const result = createIngestionResult({
    provider: SOURCE_PROVIDERS.GITHUB,
    projectId,
    resources: GITHUB_RESOURCES,
    startedAt: fetchedAt,
  });
  result.source = { owner, repo, fullName: `${owner}/${repo}` };

  const records = [];
  const seenExternalIds = new Set();
  let recordErrorCount = 0;
  let repository = null;

  const context = () => ({ projectId, repoFullName: result.source.fullName, fetchedAt });

  /**
   * Normalizes items into `records`, updating the category's counters.
   */
  const collect = (resource, items, normalizeFn) => {
    const stat = result.resources[resource];
    for (const item of items) {
      let candidate;
      try {
        candidate = normalizeFn(item, context());
      } catch (err) {
        stat.failedCount += 1;
        recordErrorCount += 1;
        if (recordErrorCount <= MAX_RECORD_ERRORS) {
          const summary = toSafeErrorSummary(err);
          result.errors.push({
            resource,
            code: GITHUB_ERROR_CODES.NORMALIZATION_FAILED,
            message: summary.message,
            status: null,
          });
        }
        continue;
      }

      if (seenExternalIds.has(candidate.externalId)) {
        // Pagination can shift while sorting by "updated"; never emit a record twice.
        stat.skippedCount += 1;
        continue;
      }
      seenExternalIds.add(candidate.externalId);
      records.push(candidate);
      stat.normalizedCount += 1;
    }
  };

  /**
   * Applies the item limit, recording trimmed items as skipped.
   */
  const applyLimit = (resource, items, maxItems) => {
    const kept = items.slice(0, maxItems);
    const trimmed = items.length - kept.length;
    if (trimmed > 0) {
      result.resources[resource].skippedCount += trimmed;
      result.resources[resource].hasMore = true;
    }
    return kept;
  };

  // 1. Repository metadata ------------------------------------------------
  try {
    const { repository: raw } = await fetchRepositoryMetadata(client, owner, repo);
    const stat = result.resources.repository;
    stat.status = RESOURCE_STATUS.SUCCEEDED;
    stat.fetchedCount = 1;
    repository = mapRepositoryMetadata(raw);
    if (repository.fullName) result.source.fullName = repository.fullName;
    collect('repository', [raw], normalizeRepository);
  } catch (err) {
    result.resources.repository.status = RESOURCE_STATUS.FAILED;
    const entry = resourceError('repository', err);
    result.errors.push(entry);

    if (FATAL_REPOSITORY_CODES.has(entry.code)) {
      for (const name of GITHUB_RESOURCES.slice(1)) {
        result.resources[name].skippedReason = 'repository_unavailable';
      }
      return { records, repository, result: finalizeIngestionResult(result, now()) };
    }
  }

  // 2-4. Issues, pull requests, commits ------------------------------------
  const steps = [
    {
      resource: 'issues',
      run: async (paging) => {
        const res = await fetchIssues(client, owner, repo, { state: 'all', since, ...paging });
        const stat = result.resources.issues;
        stat.fetchedCount = res.rawFetched;
        stat.skippedCount += res.excludedPullRequestCount;
        stat.excludedPullRequestCount = res.excludedPullRequestCount;
        stat.hasMore = res.hasMore;
        return { items: res.issues, normalize: normalizeIssue };
      },
    },
    {
      resource: 'pullRequests',
      run: async (paging) => {
        const res = await fetchPullRequests(client, owner, repo, { state: 'all', ...paging });
        const stat = result.resources.pullRequests;
        stat.fetchedCount = res.pullRequests.length;
        stat.hasMore = res.hasMore;
        return { items: res.pullRequests, normalize: normalizePullRequest };
      },
    },
    {
      resource: 'commits',
      run: async (paging) => {
        const res = await fetchCommits(client, owner, repo, { since, ...paging });
        const stat = result.resources.commits;
        stat.fetchedCount = res.commits.length;
        stat.hasMore = res.hasMore;
        stat.repositoryEmpty = Boolean(res.repositoryEmpty);
        return { items: res.commits, normalize: normalizeCommit };
      },
    },
  ];

  for (const step of steps) {
    const maxItems = limits[step.resource];
    const stat = result.resources[step.resource];

    if (maxItems === 0) {
      stat.skippedReason = 'disabled';
      continue;
    }

    try {
      const { items, normalize } = await step.run(pagingFor(maxItems));
      stat.status = RESOURCE_STATUS.SUCCEEDED;
      collect(step.resource, applyLimit(step.resource, items, maxItems), normalize);
    } catch (err) {
      // Discard any counters a partially-completed step may have set.
      Object.assign(stat, { status: RESOURCE_STATUS.FAILED, fetchedCount: 0, normalizedCount: 0, skippedCount: 0, failedCount: 0, hasMore: false });
      result.errors.push(resourceError(step.resource, err));
    }
  }

  if (recordErrorCount > MAX_RECORD_ERRORS) {
    result.errors.push({
      resource: 'all',
      code: GITHUB_ERROR_CODES.NORMALIZATION_FAILED,
      message: `${recordErrorCount - MAX_RECORD_ERRORS} additional normalization errors omitted.`,
      status: null,
    });
  }

  return { records, repository, result: finalizeIngestionResult(result, now()) };
}

/**
 * Convenience wrapper: authenticates as a GitHub App installation and runs
 * fetchGitHubRepositoryData with an installation-token client. The token is
 * never returned to the caller.
 *
 * @param {Object} params
 * @param {import('./githubAppAuth.js').GitHubAppAuthService} params.authService
 * @param {string|number} params.installationId
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.projectId
 * @param {Object} [params.limits]
 * @param {Date|string} [params.since]
 * @returns {ReturnType<typeof fetchGitHubRepositoryData>}
 */
export async function fetchGitHubRepositoryDataForInstallation({ authService, installationId, ...rest }) {
  if (!authService || typeof authService.createInstallationClient !== 'function') {
    throw new GitHubApiError('A valid GitHubAppAuthService instance is required.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }
  // Validate request inputs before spending a token exchange on them.
  validateRequest({ ...rest, client: { get() {}, paginate() {} } });

  const { client } = await authService.createInstallationClient(installationId);
  return fetchGitHubRepositoryData({ ...rest, client });
}
