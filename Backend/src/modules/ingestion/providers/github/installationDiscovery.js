/**
 * @file installationDiscovery.js
 * @description Repository discovery service for GitHub App installations.
 *
 * Responsibilities:
 * 1. Discover all repositories accessible to an authenticated GitHub App installation
 *    via `GET /installation/repositories`.
 * 2. Support pagination with reasonable limits (maxPages / perPage).
 * 3. Extract and return strictly sanitized, safe repository metadata needed by Relay:
 *    - id (GitHub repo id)
 *    - name (repo name, e.g. "relay")
 *    - fullName (full repo name, e.g. "acme/relay")
 *    - owner (login of the repo owner)
 *    - isPrivate (boolean)
 *    - defaultBranch (string, e.g. "main")
 *    - htmlUrl (string, e.g. "https://github.com/acme/relay")
 *    - description (string or null)
 * 4. Never expose tokens or sensitive headers.
 */

import { GitHubClient } from './githubClient.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from './githubErrors.js';

const DEFAULT_MAX_REPOS = 300;
const MAX_PER_PAGE = 100;

/**
 * Maps raw GitHub repository payload to safe Relay repository metadata.
 *
 * @param {Object} raw - Raw GitHub repo item from `/installation/repositories`.
 * @returns {Object} Safe repository metadata.
 */
export function mapDiscoveredRepository(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new GitHubApiError('Invalid repository data received from GitHub.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const ownerLogin = raw.owner && typeof raw.owner === 'object' && raw.owner.login
    ? raw.owner.login
    : '';

  return {
    id: raw.id,
    name: raw.name || '',
    fullName: raw.full_name || '',
    owner: ownerLogin,
    isPrivate: Boolean(raw.private),
    defaultBranch: raw.default_branch || null,
    htmlUrl: raw.html_url || '',
    description: raw.description || null,
  };
}

/**
 * Lists all repositories accessible to the GitHub App installation.
 *
 * Uses the installation access token against endpoint: `GET /installation/repositories`.
 * GitHub returns `{ total_count: number, repositories: [...] }` with standard Link header pagination.
 *
 * @param {GitHubClient} client - An instance of GitHubClient initialized with the installation access token.
 * @param {Object} [options={}]
 * @param {number} [options.perPage=30] - Number of items per page (1 to 100).
 * @param {number} [options.maxPages=5] - Safeguard maximum number of pages to fetch.
 * @param {number} [options.maxRepos=300] - Hard cap on total repositories returned.
 * @returns {Promise<{ repositories: Array<Object>, totalCount: number, pagesFetched: number, hasMore: boolean }>}
 */
export async function listInstallationRepositories(client, options = {}) {
  if (!client || typeof client.get !== 'function') {
    throw new GitHubApiError('Invalid GitHub client instance provided.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const perPage = Math.min(Math.max(Number(options.perPage) || 30, 1), MAX_PER_PAGE);
  const maxPages = Math.max(Number(options.maxPages) || 5, 1);
  const maxRepos = Math.max(Number(options.maxRepos) || DEFAULT_MAX_REPOS, 1);

  let currentEndpoint = '/installation/repositories';
  let currentParams = { per_page: perPage };
  let pagesFetched = 0;
  let totalCount = 0;
  let hasMore = false;
  const allRepositories = [];

  while (pagesFetched < maxPages) {
    const response = await client.get(currentEndpoint, currentParams);
    pagesFetched += 1;

    const data = response.data;
    if (!data || typeof data !== 'object') {
      break;
    }

    if (typeof data.total_count === 'number') {
      totalCount = data.total_count;
    }

    const reposBatch = Array.isArray(data.repositories) ? data.repositories : [];

    for (const rawRepo of reposBatch) {
      if (allRepositories.length >= maxRepos) {
        hasMore = true;
        return {
          repositories: allRepositories,
          totalCount,
          pagesFetched,
          hasMore,
        };
      }
      allRepositories.push(mapDiscoveredRepository(rawRepo));
    }

    if (response.links && response.links.next) {
      currentEndpoint = response.links.next;
      currentParams = {}; // Query params are already encoded in link header
      hasMore = true;
    } else {
      hasMore = false;
      break;
    }
  }

  return {
    repositories: allRepositories,
    totalCount: totalCount || allRepositories.length,
    pagesFetched,
    hasMore,
  };
}
