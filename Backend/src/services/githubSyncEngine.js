import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { GitHubInstallation } from '../models/GitHubInstallation.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { GitHubAppAuthService } from '../modules/ingestion/providers/github/githubAppAuth.js';
import { fetchGitHubRepositoryData } from '../modules/ingestion/providers/github/githubIngestionService.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from '../modules/ingestion/providers/github/githubErrors.js';
import { persistSourceRecordCandidates } from '../modules/ingestion/persistence/sourceRecordStore.js';
import { INGESTION_STATUS } from '../modules/ingestion/contracts/sourceRecord.js';

/**
 * Synchronization engine for one project <-> repository association (a GitHub SourceConnection).
 *
 * State lives in `connection.config.sync` (config is the free-form field of the canonical model):
 *   { status: pending|syncing|completed|partial|failed, runId, lockedAt, lastAttemptAt, lastSuccessAt,
 *     cursor, truncated, counts: {created, updated}, errors: [{resource, code, message}], staleAt }
 *
 * Concurrency: a run takes an atomic lock (status 'syncing', fresh lockedAt). Locks older than
 * LOCK_TTL_MS are considered abandoned (crashed/serverless-killed run). Every write that ends a run is
 * filtered by its runId, so a slow older run can never overwrite a newer run's state.
 *
 * Sync runs inline within the caller's request (no queue exists, and a detached promise is unreliable on
 * Vercel); limits keep a run to a handful of GitHub requests.
 */

export const LOCK_TTL_MS = 10 * 60 * 1000;
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;

export class SyncError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let authService = null;
export function resetSyncAuth() { authService = null; }
function auth() {
  authService ??= new GitHubAppAuthService({
    appId: config.githubApp.appId,
    privateKey: config.githubApp.privateKey,
    fetchFn: (...args) => globalThis.fetch(...args),
  });
  return authService;
}

const SAFE_MESSAGES = {
  [GITHUB_ERROR_CODES.AUTH_FAILED]: 'GitHub rejected the installation credentials.',
  [GITHUB_ERROR_CODES.FORBIDDEN]: 'Relay no longer has permission to read this repository.',
  [GITHUB_ERROR_CODES.NOT_FOUND]: 'The repository was deleted, renamed, or is no longer shared with Relay.',
  [GITHUB_ERROR_CODES.RATE_LIMITED]: 'GitHub rate limit reached. Try again later.',
  [GITHUB_ERROR_CODES.TIMEOUT]: 'GitHub took too long to respond.',
  [GITHUB_ERROR_CODES.NETWORK_ERROR]: 'GitHub could not be reached.',
  [GITHUB_ERROR_CODES.SERVER_ERROR]: 'GitHub reported a server error.',
};
const safeError = (resource, code) => ({ resource, code: code || 'ERROR', message: SAFE_MESSAGES[code] || 'Some GitHub data could not be synchronized.' });

/** Installation-token client for a connection, after confirming its installation is still active. */
export async function installationClientFor(connection) {
  const cfg = connection.config || {};
  const install = await GitHubInstallation.findOne({ userId: connection.connectedBy, installationId: cfg.installationId, status: 'active' }).lean();
  if (!install) throw new SyncError(409, 'INSTALLATION_UNAVAILABLE', 'The GitHub installation was removed or suspended. Reconnect GitHub from Connections.');
  const { client } = await auth().createInstallationClient(install.installationId);
  return client;
}

export function serializeSync(sync) {
  if (!sync || typeof sync !== 'object') return { status: 'pending', lastAttemptAt: null, lastSuccessAt: null, truncated: false, counts: null, errors: [], stale: false };
  const lockLive = sync.status === 'syncing' && sync.lockedAt && Date.now() - new Date(sync.lockedAt).getTime() < LOCK_TTL_MS;
  return {
    // An abandoned lock is shown as failed rather than syncing forever.
    status: sync.status === 'syncing' && !lockLive ? 'failed' : sync.status || 'pending',
    lastAttemptAt: sync.lastAttemptAt || null,
    lastSuccessAt: sync.lastSuccessAt || null,
    truncated: Boolean(sync.truncated),
    counts: sync.counts || null,
    errors: Array.isArray(sync.errors) ? sync.errors.slice(0, 5) : [],
    stale: Boolean(sync.staleAt),
  };
}

async function acquireLock(connectionId, runId, now) {
  const cutoff = new Date(now.getTime() - LOCK_TTL_MS);
  return SourceConnection.findOneAndUpdate(
    { _id: connectionId, provider: 'github', $or: [{ 'config.sync.status': { $ne: 'syncing' } }, { 'config.sync.lockedAt': { $lt: cutoff } }] },
    { $set: { 'config.sync.status': 'syncing', 'config.sync.runId': runId, 'config.sync.lockedAt': now, 'config.sync.lastAttemptAt': now } },
    { new: false } // the pre-lock document, so the previous run's state (cursor, status) is readable
  );
}

async function finishRun(connectionId, runId, fields) {
  const $set = {};
  for (const [key, value] of Object.entries(fields)) $set[`config.sync.${key}`] = value;
  return SourceConnection.findOneAndUpdate(
    { _id: connectionId, 'config.sync.runId': runId },
    { $set, $unset: { 'config.sync.lockedAt': '', ...(fields.status === 'completed' ? { 'config.sync.staleAt': '' } : {}) } },
    { new: true }
  );
}

/**
 * Runs one sync. Caller must already have authorized the project (attachProject + role).
 * @returns the updated SourceConnection document.
 */
export async function syncConnection(connectionId, { now = () => new Date() } = {}) {
  const startedAt = now();
  const runId = randomUUID();
  const locked = await acquireLock(connectionId, runId, startedAt);
  if (!locked) throw new SyncError(409, 'sync_in_progress', 'A synchronization is already running for this repository.');

  const cfg = locked.config || {};
  const previous = cfg.sync || {};
  const fail = (code, errors) => finishRun(connectionId, runId, { status: 'failed', errors: errors || [safeError('repository', code)], lastAttemptAt: startedAt });

  try {
    const install = await GitHubInstallation.findOne({ userId: locked.connectedBy, installationId: cfg.installationId, status: 'active' }).lean();
    if (!install) return await fail('INSTALLATION_UNAVAILABLE', [{ resource: 'installation', code: 'INSTALLATION_UNAVAILABLE', message: 'The GitHub installation was removed or suspended. Reconnect GitHub from Connections.' }]);

    let client;
    try {
      ({ client } = await auth().createInstallationClient(install.installationId));
    } catch (err) {
      return await fail(err instanceof GitHubApiError ? err.code : 'ERROR');
    }

    // Incremental: only when the previous run fully completed, with an overlap window for clock skew.
    const since = previous.status === 'completed' && previous.cursor ? new Date(new Date(previous.cursor).getTime() - CURSOR_OVERLAP_MS) : undefined;
    const limits = config.githubApp.sync;
    const { records, repository, result } = await fetchGitHubRepositoryData({
      client, owner: cfg.owner, repo: cfg.repo, projectId: String(locked.projectId), limits, since, now,
    });

    // Attribute every record to this repository so it can be queried per repository.
    for (const record of records) {
      record.metadata = { ...(record.metadata || {}), repositoryId: cfg.repositoryId, repositoryFullName: cfg.fullName };
    }
    const persistence = await persistSourceRecordCandidates({ projectId: String(locked.projectId), records, now });

    const errors = [
      ...result.errors.map((e) => safeError(e.resource, e.code)),
      ...persistence.errors.map((e) => safeError('persistence', e.code)),
    ].slice(0, 10);
    const written = persistence.createdCount + persistence.updatedCount;
    let status;
    if (errors.length === 0) status = 'completed';
    else if (written > 0 || records.length > 0) status = 'partial';
    else status = 'failed';
    if (result.status === INGESTION_STATUS.FAILED && written === 0) status = 'failed';

    const truncated = Object.values(result.resources || {}).some((r) => r?.hasMore);
    const fields = {
      status, errors, lastAttemptAt: startedAt, truncated,
      counts: { created: persistence.createdCount, updated: persistence.updatedCount },
    };
    if (status === 'completed') { fields.lastSuccessAt = now(); fields.cursor = startedAt; }
    const updated = await finishRun(connectionId, runId, fields);
    // Keep display metadata fresh (renames, visibility changes); the stable id never changes.
    if (updated && repository?.fullName && repository.fullName.includes('/')) {
      const [owner, repo] = repository.fullName.split('/');
      await SourceConnection.updateOne({ _id: connectionId }, { $set: { 'config.owner': owner, 'config.repo': repo, 'config.fullName': repository.fullName, 'config.isPrivate': Boolean(repository.isPrivate ?? cfg.isPrivate) } });
    }
    return (await SourceConnection.findById(connectionId)) || updated;
  } catch (err) {
    // Never leave the lock held, and never claim success.
    await fail(err instanceof GitHubApiError ? err.code : 'ERROR');
    return SourceConnection.findById(connectionId);
  }
}
