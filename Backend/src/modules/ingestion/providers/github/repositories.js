/**
 * @file repositories.js
 * @description Resource fetcher for GitHub repository metadata.
 */

import { validateIdentifier } from './githubClient.js';

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

  return {
    repository: response.data,
    rateLimit: response.rateLimit,
  };
}
