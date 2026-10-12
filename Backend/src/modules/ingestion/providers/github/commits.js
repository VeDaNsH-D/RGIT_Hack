/**
 * @file commits.js
 * @description Resource fetcher for GitHub repository commits.
 */

import { validateIdentifier } from './githubClient.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from './githubErrors.js';

// Safe Git branch/tag/SHA regex (letters, numbers, dashes, underscores, dots, and slashes for branches like feature/xyz)
const GIT_REF_REGEX = /^[a-zA-Z0-9/_.-]+$/;

/**
 * Fetches commits for a given repository.
 *
 * @param {import('./githubClient.js').GitHubClient} client - Configured GitHub client.
 * @param {string} owner - Repository owner.
 * @param {string} repo - Repository name.
 * @param {Object} [options]
 * @param {string} [options.sha] - SHA or branch to start listing commits from.
 * @param {string|Date} [options.since] - Only commits after this date.
 * @param {string|Date} [options.until] - Only commits before this date.
 * @param {string} [options.path] - Only commits containing this file path.
 * @param {number} [options.perPage=30] - Results per page (max 100).
 * @param {number} [options.maxPages=5] - Maximum pages to retrieve.
 * @returns {Promise<{ commits: any[], totalFetched: number, pagesFetched: number, rateLimit: Object, hasMore: boolean, repositoryEmpty: boolean }>}
 */
export async function fetchCommits(client, owner, repo, options = {}) {
  if (!client || typeof client.paginate !== 'function') {
    throw new TypeError('A valid GitHubClient instance is required.');
  }

  const safeOwner = validateIdentifier(owner, 'owner');
  const safeRepo = validateIdentifier(repo, 'repo');

  const queryParams = {};

  if (options.sha) {
    const trimmedSha = String(options.sha).trim();
    if (!GIT_REF_REGEX.test(trimmedSha) || trimmedSha.includes('..')) {
      throw new GitHubApiError(`Invalid Git ref or SHA "${options.sha}".`, {
        code: GITHUB_ERROR_CODES.INVALID_INPUT,
      });
    }
    queryParams.sha = trimmedSha;
  }

  if (options.since) {
    queryParams.since = options.since instanceof Date ? options.since.toISOString() : String(options.since);
  }

  if (options.until) {
    queryParams.until = options.until instanceof Date ? options.until.toISOString() : String(options.until);
  }

  if (options.path) {
    queryParams.path = String(options.path);
  }

  let result;
  try {
    result = await client.paginate(`/repos/${safeOwner}/${safeRepo}/commits`, queryParams, {
      perPage: options.perPage || 30,
      maxPages: options.maxPages || 5,
      requireArray: true,
    });
  } catch (err) {
    // GitHub answers 409 "Git Repository is empty" for repositories without commits.
    // That is a valid empty result, not a failed request.
    if (err instanceof GitHubApiError && err.status === 409) {
      return {
        commits: [],
        totalFetched: 0,
        pagesFetched: 1,
        rateLimit: err.rateLimit,
        hasMore: false,
        repositoryEmpty: true,
      };
    }
    throw err;
  }

  return {
    commits: result.items,
    totalFetched: result.items.length,
    pagesFetched: result.pagesFetched,
    rateLimit: result.rateLimit,
    hasMore: result.hasMore,
    repositoryEmpty: false,
  };
}
