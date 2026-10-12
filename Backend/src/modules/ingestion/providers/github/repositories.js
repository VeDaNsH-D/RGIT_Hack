/**
 * @file repositories.js
 * @description Resource fetcher for GitHub repository metadata.
 */

import { validateIdentifier } from './githubClient.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from './githubErrors.js';

/**
 * Retrieves repository metadata for a given owner and repository name.
 * Does not paginate as repository metadata is a single-object response.
 *
 * @param {import('./githubClient.js').GitHubClient} client - Configured GitHub client.
 * @param {string} owner - Repository owner (user or organization).
 * @param {string} repo - Repository name.
 * @returns {Promise<{ repository: any, rateLimit: Object }>}
 */
export async function fetchRepositoryMetadata(client, owner, repo) {
  if (!client || typeof client.get !== 'function') {
    throw new TypeError('A valid GitHubClient instance is required.');
  }

  const safeOwner = validateIdentifier(owner, 'owner');
  const safeRepo = validateIdentifier(repo, 'repo');

  const response = await client.get(`/repos/${safeOwner}/${safeRepo}`);

  if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
    throw new GitHubApiError('GitHub returned an unexpected response format for repository metadata.', {
      code: GITHUB_ERROR_CODES.UNEXPECTED_RESPONSE,
      endpoint: `/repos/${safeOwner}/${safeRepo}`,
      rateLimit: response.rateLimit,
    });
  }

  return {
    repository: response.data,
    rateLimit: response.rateLimit,
  };
}

/**
 * Maps a raw `GET /repos/{owner}/{repo}` payload to the bounded, safe set of
 * repository fields Relay needs. Never copies permissions, URLs templates, or
 * other unbounded API payload sections.
 *
 * @param {Object} raw - Raw GitHub repository object.
 * @returns {{ id: number|null, nodeId: string|null, name: string, fullName: string, owner: string|null,
 *   description: string|null, htmlUrl: string|null, defaultBranch: string|null, language: string|null,
 *   isPrivate: boolean, visibility: string|null, createdAt: string|null, updatedAt: string|null,
 *   pushedAt: string|null }}
 */
export function mapRepositoryMetadata(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new GitHubApiError('Repository metadata must be a non-null object.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const str = (v) => (typeof v === 'string' && v ? v : null);

  return {
    id: typeof raw.id === 'number' ? raw.id : null,
    nodeId: str(raw.node_id),
    name: str(raw.name) || '',
    fullName: str(raw.full_name) || '',
    owner: raw.owner && typeof raw.owner === 'object' ? str(raw.owner.login) : null,
    description: str(raw.description),
    htmlUrl: str(raw.html_url),
    defaultBranch: str(raw.default_branch),
    language: str(raw.language),
    isPrivate: raw.private === true,
    visibility: str(raw.visibility) || (raw.private === true ? 'private' : raw.private === false ? 'public' : null),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    pushedAt: str(raw.pushed_at),
  };
}
