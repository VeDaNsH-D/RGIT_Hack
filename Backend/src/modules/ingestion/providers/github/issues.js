/**
 * @file issues.js
 * @description Resource fetcher for GitHub repository issues.
 *
 * Handles GitHub's specific API behavior where the issue list endpoint returns
 * both issues and pull requests, offering a clean filter to isolate issues.
 */

import { validateIdentifier } from './githubClient.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from './githubErrors.js';

const VALID_STATES = Object.freeze(['open', 'closed', 'all']);

/**
 * Fetches issues for a given repository.
 *
 * @param {import('./githubClient.js').GitHubClient} client - Configured GitHub client.
 * @param {string} owner - Repository owner.
 * @param {string} repo - Repository name.
 * @param {Object} [options]
 * @param {'open'|'closed'|'all'} [options.state='all'] - Issue state filter.
 * @param {boolean} [options.excludePullRequests=true] - Whether to filter out pull requests returned by GitHub's issue endpoint.
 * @param {string|Date} [options.since] - Only issues updated at or after this timestamp.
 * @param {'created'|'updated'|'comments'} [options.sort='updated'] - Sort field.
 * @param {'asc'|'desc'} [options.direction='desc'] - Sort direction.
 * @param {number} [options.perPage=30] - Results per page (max 100).
 * @param {number} [options.maxPages=5] - Maximum pages to retrieve.
 * @returns {Promise<{ issues: any[], totalFetched: number, pagesFetched: number, rateLimit: Object, hasMore: boolean }>}
 */
export async function fetchIssues(client, owner, repo, options = {}) {
  if (!client || typeof client.paginate !== 'function') {
    throw new TypeError('A valid GitHubClient instance is required.');
  }

  const safeOwner = validateIdentifier(owner, 'owner');
  const safeRepo = validateIdentifier(repo, 'repo');

  const state = options.state || 'all';
  if (!VALID_STATES.includes(state)) {
    throw new GitHubApiError(`Invalid issue state "${state}". Must be one of: ${VALID_STATES.join(', ')}.`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const excludePullRequests = options.excludePullRequests !== false; // defaults to true

  const queryParams = {
    state,
    sort: options.sort || 'updated',
    direction: options.direction || 'desc',
  };

  if (options.since) {
    queryParams.since = options.since instanceof Date ? options.since.toISOString() : String(options.since);
  }

  const result = await client.paginate(`/repos/${safeOwner}/${safeRepo}/issues`, queryParams, {
    perPage: options.perPage || 30,
    maxPages: options.maxPages || 5,
  });

  // Filter out pull requests if requested (GitHub issues API includes PRs indicated by the `pull_request` key)
  const filteredIssues = excludePullRequests
    ? result.items.filter((item) => !item.pull_request)
    : result.items;

  return {
    issues: filteredIssues,
    totalFetched: filteredIssues.length,
    pagesFetched: result.pagesFetched,
    rateLimit: result.rateLimit,
    hasMore: result.hasMore,
  };
}
