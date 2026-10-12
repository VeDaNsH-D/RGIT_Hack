/**
 * @file pullRequests.js
 * @description Resource fetcher for GitHub repository pull requests.
 */

import { validateIdentifier } from './githubClient.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from './githubErrors.js';

const VALID_STATES = Object.freeze(['open', 'closed', 'all']);

/**
 * Fetches pull requests for a given repository.
 *
 * @param {import('./githubClient.js').GitHubClient} client - Configured GitHub client.
 * @param {string} owner - Repository owner.
 * @param {string} repo - Repository name.
 * @param {Object} [options]
 * @param {'open'|'closed'|'all'} [options.state='all'] - Pull request state filter.
 * @param {'created'|'updated'|'popularity'|'long-running'} [options.sort='updated'] - Sort field.
 * @param {'asc'|'desc'} [options.direction='desc'] - Sort direction.
 * @param {string} [options.base] - Filter by base branch name.
 * @param {string} [options.head] - Filter by head user/branch name.
 * @param {number} [options.perPage=30] - Results per page (max 100).
 * @param {number} [options.maxPages=5] - Maximum pages to retrieve.
 * @returns {Promise<{ pullRequests: any[], totalFetched: number, pagesFetched: number, rateLimit: Object, hasMore: boolean }>}
 */
export async function fetchPullRequests(client, owner, repo, options = {}) {
  if (!client || typeof client.paginate !== 'function') {
    throw new TypeError('A valid GitHubClient instance is required.');
  }

  const safeOwner = validateIdentifier(owner, 'owner');
  const safeRepo = validateIdentifier(repo, 'repo');

  const state = options.state || 'all';
  if (!VALID_STATES.includes(state)) {
    throw new GitHubApiError(`Invalid pull request state "${state}". Must be one of: ${VALID_STATES.join(', ')}.`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const queryParams = {
    state,
    sort: options.sort || 'updated',
    direction: options.direction || 'desc',
  };

  if (options.base) queryParams.base = options.base;
  if (options.head) queryParams.head = options.head;

  const result = await client.paginate(`/repos/${safeOwner}/${safeRepo}/pulls`, queryParams, {
    perPage: options.perPage || 30,
    maxPages: options.maxPages || 5,
  });

  return {
    pullRequests: result.items,
    totalFetched: result.items.length,
    pagesFetched: result.pagesFetched,
    rateLimit: result.rateLimit,
    hasMore: result.hasMore,
  };
}
