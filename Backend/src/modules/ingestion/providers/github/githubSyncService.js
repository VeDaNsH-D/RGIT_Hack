/**
 * @file githubSyncService.js
 * @description Persistence-enabled GitHub ingestion: fetch -> normalize -> persist.
 *
 * `fetchGitHubRepositoryData` (githubIngestionService.js) remains the fetch-only
 * path with `persisted: false`. This module adds the write path on top of it and
 * merges persistence counts into the same ingestion result shape.
 *
 * The Relay projectId must come from an authorized project association (e.g. a
 * SourceConnection loaded for a project the caller is a member of), never from
 * GitHub data or unchecked request input. This module does not perform HTTP
 * authorization; route handlers must apply requireAuth + attachProject + requireRole.
 */

import { GITHUB_ERROR_CODES, GitHubApiError } from './githubErrors.js';
import { validateIdentifier } from './githubClient.js';
import { validateInstallationId } from './githubAppAuth.js';
import { fetchGitHubRepositoryData } from './githubIngestionService.js';
import { persistSourceRecordCandidates } from '../../persistence/sourceRecordStore.js';
import { INGESTION_STATUS, SOURCE_PROVIDERS } from '../../contracts/sourceRecord.js';

const OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i;

function assertObjectIdString(projectId) {
  const value = projectId && typeof projectId === 'object' && typeof projectId.toHexString === 'function'
    ? projectId.toHexString()
    : projectId;
  if (typeof value !== 'string' || !OBJECT_ID_REGEX.test(value.trim())) {
    throw new GitHubApiError('Invalid projectId: a Relay project ObjectId is required for persistence.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }
  return value.trim();
}

/**
 * Fetches, normalizes, and persists one repository's GitHub data.
 *
 * @param {Object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string|import('mongoose').Types.ObjectId} params.projectId - Authorized Relay project ID.
 * @param {import('./githubClient.js').GitHubClient} params.client - Installation-token client.
 * @param {Object} [params.limits]
 * @param {Date|string} [params.since]
 * @param {{ bulkWrite: Function }} [params.model] - SourceRecord model override (tests).
 * @param {() => Date} [params.now]
 * @returns {Promise<{ repository: Object|null, result: Object }>} The ingestion result with
 *   `persisted`, `createdCount`, `updatedCount` filled from the database outcome and the
 *   full persistence report under `result.persistence`.
 */
export async function syncGitHubRepository({ model, ...params } = {}) {
  const projectId = assertObjectIdString(params.projectId);
  const { records, repository, result } = await fetchGitHubRepositoryData({ ...params, projectId });

  const persistence = await persistSourceRecordCandidates({
    projectId,
    records,
    ...(model ? { model } : {}),
    ...(params.now ? { now: params.now } : {}),
  });

  result.persistence = persistence;
  result.persisted = persistence.persisted;
  result.createdCount = persistence.createdCount;
  result.updatedCount = persistence.updatedCount;

  for (const e of persistence.errors) {
    result.errors.push({
      resource: 'persistence',
      code: e.code,
      message: e.message,
      status: null,
      externalId: e.externalId,
    });
  }

  const written = persistence.createdCount + persistence.updatedCount;
  if (result.errors.length === 0) result.status = INGESTION_STATUS.SUCCEEDED;
  else if (written > 0) result.status = INGESTION_STATUS.PARTIAL;
  else result.status = INGESTION_STATUS.FAILED;
  result.completedAt = (params.now ? params.now() : new Date()).toISOString();

  return { repository, result };
}

/**
 * Syncs the repository referenced by a GitHub SourceConnection. The projectId is
 * taken from the connection document, so callers cannot redirect writes to a
 * different project. Expected config shape (proposed; Person 2 to confirm):
 *   { installationId: number, owner: string, repo: string }
 *
 * @param {Object} params
 * @param {{ projectId: unknown, provider: string, config?: Object }} params.connection - SourceConnection document.
 * @param {import('./githubAppAuth.js').GitHubAppAuthService} params.authService
 * @param {Object} [params.limits]
 * @param {Date|string} [params.since]
 * @param {{ bulkWrite: Function }} [params.model]
 * @returns {ReturnType<typeof syncGitHubRepository>}
 */
export async function syncGitHubSourceConnection({ connection, authService, ...rest } = {}) {
  if (!connection || typeof connection !== 'object' || connection.provider !== SOURCE_PROVIDERS.GITHUB) {
    throw new GitHubApiError('A GitHub SourceConnection is required.', { code: GITHUB_ERROR_CODES.INVALID_INPUT });
  }
  if (!authService || typeof authService.createInstallationClient !== 'function') {
    throw new GitHubApiError('A valid GitHubAppAuthService instance is required.', { code: GITHUB_ERROR_CODES.INVALID_INPUT });
  }

  const cfg = connection.config || {};
  const projectId = assertObjectIdString(
    typeof connection.projectId === 'object' && connection.projectId !== null && connection.projectId.toHexString
      ? connection.projectId.toHexString()
      : String(connection.projectId ?? ''),
  );

  // Validate everything before spending a token exchange.
  const installationId = validateInstallationId(cfg.installationId);
  const owner = validateIdentifier(cfg.owner, 'owner');
  const repo = validateIdentifier(cfg.repo, 'repo');

  const { client } = await authService.createInstallationClient(installationId);
  return syncGitHubRepository({ ...rest, owner, repo, projectId, client });
}
