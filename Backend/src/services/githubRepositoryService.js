import { config } from '../config.js';
import { GitHubInstallation } from '../models/GitHubInstallation.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { GitHubAppAuthService } from '../modules/ingestion/providers/github/githubAppAuth.js';
import { listInstallationRepositories } from '../modules/ingestion/providers/github/installationDiscovery.js';
import { serializeSync } from './githubSyncEngine.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from '../modules/ingestion/providers/github/githubErrors.js';

/**
 * Repository access and project association.
 *
 * Association storage: one SourceConnection per (project, repository):
 *   { projectId, provider: 'github', connectedBy, config: { installationId, repositoryId, owner, repo, fullName, htmlUrl, isPrivate } }
 * `owner`/`repo`/`installationId` match what syncGitHubSourceConnection already reads.
 * Multiple repositories per project and one repository in several projects are both allowed;
 * the same repository twice in one project is rejected.
 */

export class RepositoryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let authService = null;
export function resetGitHubAppAuth() { authService = null; }
function auth() {
  authService ??= new GitHubAppAuthService({
    appId: config.githubApp.appId,
    privateKey: config.githubApp.privateKey,
    fetchFn: (...args) => globalThis.fetch(...args),
  });
  return authService;
}

const UNAVAILABLE = new Set([GITHUB_ERROR_CODES.FORBIDDEN, GITHUB_ERROR_CODES.NOT_FOUND, GITHUB_ERROR_CODES.AUTH_FAILED]);

/**
 * All repositories reachable through the user's OWN verified installations.
 * Returned items carry an internal installationId that routes must not expose.
 */
export async function listAccessibleRepositories(userId) {
  const installs = await GitHubInstallation.find({ userId, status: 'active' }).lean();
  if (!installs.length) return { connected: false, repositories: [], truncated: false };
  const byId = new Map();
  let reachable = 0;
  let truncated = false;
  for (const install of installs) {
    try {
      const { client } = await auth().createInstallationClient(install.installationId);
      const result = await listInstallationRepositories(client, { perPage: 100, maxPages: 3, maxRepos: 300 });
      reachable += 1;
      truncated ||= result.hasMore;
      for (const repo of result.repositories) {
        if (Number.isSafeInteger(repo.id) && !byId.has(repo.id)) byId.set(repo.id, { ...repo, installationId: install.installationId });
      }
    } catch (err) {
      if (err instanceof GitHubApiError && UNAVAILABLE.has(err.code)) continue; // suspended/removed installation
      throw new RepositoryError(502, 'github_unavailable', 'GitHub could not be reached. Please try again.');
    }
  }
  if (!reachable) throw new RepositoryError(409, 'installation_unavailable', 'Your GitHub installation is suspended or was removed. Reconnect GitHub from Connections.');
  return { connected: true, repositories: [...byId.values()], truncated };
}

export const publicRepository = ({ id, owner, name, fullName, htmlUrl, isPrivate, defaultBranch, description }) =>
  ({ id, owner, name, fullName, htmlUrl, isPrivate, defaultBranch, description });

/** Server-side proof that the user's installation can access this repository id. */
export async function resolveAccessibleRepository(userId, repositoryId) {
  const { connected, repositories } = await listAccessibleRepositories(userId);
  if (!connected) throw new RepositoryError(409, 'github_not_connected', 'Connect GitHub before linking a repository.');
  const repo = repositories.find((r) => r.id === repositoryId);
  if (!repo) throw new RepositoryError(403, 'repository_not_accessible', 'That repository isn’t accessible to your GitHub connection.');
  return repo;
}

/**
 * Counts are only reported from data that was actually synchronized. A genuine zero (state 'ready')
 * differs from never-synced ('not_synced'), a failed first sync ('failed'), and counts that predate a
 * failed/partial latest run ('stale').
 */
export function buildStats(sync, raw) {
  const hasData = Boolean(sync.lastSuccessAt) || sync.status === 'partial';
  if (!hasData || !raw) return { state: sync.status === 'failed' ? 'failed' : 'not_synced', openIssues: null, openPullRequests: null, latestCommitAt: null };
  const state = sync.status === 'completed' ? 'ready' : sync.status === 'syncing' ? 'ready' : 'stale';
  return { state, openIssues: raw.openIssues, openPullRequests: raw.openPullRequests, latestCommitAt: raw.latestCommitAt ? new Date(raw.latestCommitAt).toISOString() : null, truncated: sync.truncated };
}

export const serializeConnection = (doc, rawStats) => {
  const sync = serializeSync(doc.config?.sync);
  return {
    id: String(doc._id),
    provider: doc.provider,
    connectedAt: doc.createdAt,
    sync,
    stats: buildStats(sync, rawStats),
    repository: {
      id: doc.config?.repositoryId,
      owner: doc.config?.owner,
      name: doc.config?.repo,
      fullName: doc.config?.fullName,
      htmlUrl: doc.config?.htmlUrl,
      isPrivate: Boolean(doc.config?.isPrivate),
    },
  };
};

/** Persists the association for an already-authorized project (caller applies attachProject/requireRole). */
export async function linkRepository({ projectId, userId, repository }) {
  const existing = await SourceConnection.findOne({ projectId, provider: 'github', 'config.repositoryId': repository.id }).lean();
  if (existing) throw new RepositoryError(409, 'already_connected', 'That repository is already linked to this project.');
  const doc = await SourceConnection.create({
    projectId,
    provider: 'github',
    connectedBy: userId,
    config: { sync: { status: 'pending' }, installationId: repository.installationId, repositoryId: repository.id, owner: repository.owner, repo: repository.name, fullName: repository.fullName, htmlUrl: repository.htmlUrl, isPrivate: repository.isPrivate },
  });
  return serializeConnection(doc);
}
