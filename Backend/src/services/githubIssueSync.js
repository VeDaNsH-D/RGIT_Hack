import { config } from '../config.js';
import { Task } from '../models/Task.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { installationClientFor, SyncError } from './githubSyncEngine.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from '../modules/ingestion/providers/github/githubErrors.js';
import { validateIdentifier } from '../modules/ingestion/providers/github/githubClient.js';

/**
 * Creates (and, on retry, safely re-creates) the GitHub issue for a Relay task.
 *
 * Source of truth for the target: `task.github` pins the project's SourceConnection and the stable GitHub
 * repository id chosen at creation. Nothing here ever falls back to another repository; if the pinned
 * connection, installation or repository is gone the sync fails with an actionable code.
 *
 * Duplicate prevention: GitHub has no idempotency keys, so every issue body carries a hidden marker with the
 * task id. Before any attempt after the first, the repository's recent issues are scanned for that marker and
 * an existing issue is adopted instead of creating a second one. If the scan cannot be completed, the sync
 * fails rather than guessing.
 *
 * Concurrency: a sync atomically claims `github.lockedAt`; a stale lock (crashed request) can be re-claimed.
 */

export const LOCK_TTL_MS = 2 * 60 * 1000;
const TITLE_MAX = 256;
const RECONCILE_MAX_PAGES = 5;

export class TaskSyncError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const issueMarker = (taskId) => `<!-- relay-task-id: ${String(taskId)} -->`;

const SAFE_MESSAGES = {
  repository_disconnected: 'This repository is no longer linked to the project. Reconnect it from the project page, then create the issue again.',
  installation_unavailable: 'The GitHub installation was removed or suspended. Reconnect GitHub from Connections.',
  repository_unavailable: 'Relay can no longer access this repository. Check that it is still shared with the Relay GitHub App.',
  issues_disabled: 'Issues are disabled for this repository.',
  issue_rejected: 'GitHub rejected the issue. Check the repository’s issue settings.',
  rate_limited: 'GitHub rate limit reached. Try again later.',
  github_unavailable: 'GitHub could not be reached. Try again.',
  reconcile_incomplete: 'Could not confirm whether an issue was already created. Try again.',
  sync_failed: 'The GitHub issue could not be created. Try again.',
};
const safeMessage = (code) => SAFE_MESSAGES[code] || SAFE_MESSAGES.sync_failed;

function classify(err) {
  if (err instanceof TaskSyncError) return err.code;
  if (err instanceof SyncError) return err.code === 'INSTALLATION_UNAVAILABLE' ? 'installation_unavailable' : 'sync_failed';
  if (!(err instanceof GitHubApiError)) return 'sync_failed';
  switch (err.code) {
    case GITHUB_ERROR_CODES.NOT_FOUND:
    case GITHUB_ERROR_CODES.FORBIDDEN:
    case GITHUB_ERROR_CODES.AUTH_FAILED:
      return 'repository_unavailable';
    case GITHUB_ERROR_CODES.RATE_LIMITED:
      return 'rate_limited';
    case GITHUB_ERROR_CODES.TIMEOUT:
    case GITHUB_ERROR_CODES.NETWORK_ERROR:
    case GITHUB_ERROR_CODES.SERVER_ERROR:
      return 'github_unavailable';
    default:
      if (err.status === 410) return 'issues_disabled';
      if (err.status === 422) return 'issue_rejected';
      return 'sync_failed';
  }
}

// Only labels that already exist are used; Relay never creates labels.
const priorityLabelCandidates = (p) => [`priority: ${p}`, `priority:${p}`, `priority-${p}`, `priority/${p}`, `${p} priority`, `p-${p}`, p];

export function pickPriorityLabel(priority, existingNames) {
  const byLower = new Map(existingNames.map((n) => [String(n).toLowerCase(), n]));
  for (const candidate of priorityLabelCandidates(priority)) {
    const hit = byLower.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

export function buildIssueBody(task) {
  const lines = [];
  if (task.description) lines.push(task.description, '');
  lines.push('---', '**Relay task**', `- Priority: ${task.priority}`);
  if (task.deadline) lines.push(`- Due: ${new Date(task.deadline).toISOString().slice(0, 10)}`);
  lines.push(`- Task ID: \`${task._id}\``);
  if (config.frontendUrl) lines.push(`- Link: ${config.frontendUrl.replace(/\/$/, '')}/projects/${task.projectId}`);
  lines.push('', issueMarker(task._id));
  return lines.join('\n');
}

export function serializeTaskGithub(github) {
  if (!github?.status) return null;
  return {
    status: github.status,
    repository: github.repositoryId ? { id: github.repositoryId, fullName: github.fullName, htmlUrl: github.htmlUrl } : null,
    issueNumber: github.issueNumber ?? null,
    issueUrl: github.status === 'synced' ? github.issueUrl ?? null : null,
    error: github.status === 'failed' && github.error ? { code: github.error.code, message: github.error.message } : null,
    warnings: github.warnings || [],
    // failed, or 'pending' with an abandoned lock (crashed request)
    retryable: github.status === 'failed' || (github.status === 'pending' && (!github.lockedAt || Date.now() - new Date(github.lockedAt).getTime() > LOCK_TTL_MS)),
    syncedAt: github.syncedAt ?? null,
  };
}

async function findExistingIssue(client, owner, repo, task) {
  const marker = issueMarker(task._id);
  const { items, hasMore } = await client.paginate(
    `/repos/${owner}/${repo}/issues`,
    { state: 'all', sort: 'created', direction: 'desc', since: new Date(task.createdAt).toISOString() },
    { perPage: 100, maxPages: RECONCILE_MAX_PAGES, requireArray: true }
  );
  const found = items.find((i) => i && !i.pull_request && typeof i.body === 'string' && i.body.includes(marker));
  if (found) return found;
  if (hasMore) throw new TaskSyncError(502, 'reconcile_incomplete', safeMessage('reconcile_incomplete'));
  return null;
}

async function existingLabelNames(client, owner, repo) {
  try {
    const { items } = await client.paginate(`/repos/${owner}/${repo}/labels`, {}, { perPage: 100, maxPages: 3, requireArray: true });
    return items.map((l) => l?.name).filter((n) => typeof n === 'string');
  } catch {
    return null; // labels are best-effort; never block the issue
  }
}

const confirmedIssue = (issue) =>
  issue && Number.isSafeInteger(issue.number) && typeof issue.html_url === 'string' && issue.html_url.startsWith('https://');

async function createOrAdoptIssue(task, attempts) {
  const link = task.github;
  const connection = await SourceConnection.findOne({
    _id: link.connectionId,
    projectId: task.projectId,
    provider: 'github',
    'config.repositoryId': link.repositoryId,
  }).lean();
  if (!connection) throw new TaskSyncError(409, 'repository_disconnected', safeMessage('repository_disconnected'));

  const client = await installationClientFor(connection);

  // Resolve the CURRENT owner/name from the stable repository id (renames/transfers) and prove access.
  const { data: repoInfo } = await client.get(`/repositories/${link.repositoryId}`);
  if (repoInfo?.id !== link.repositoryId) throw new TaskSyncError(409, 'repository_unavailable', safeMessage('repository_unavailable'));
  const owner = validateIdentifier(repoInfo.owner?.login, 'owner');
  const repo = validateIdentifier(repoInfo.name, 'repository');
  if (repoInfo.has_issues === false) throw new TaskSyncError(409, 'issues_disabled', safeMessage('issues_disabled'));

  const warnings = [];
  let issue = attempts > 1 ? await findExistingIssue(client, owner, repo, task) : null;

  if (!issue) {
    const labelNames = await existingLabelNames(client, owner, repo);
    const label = labelNames ? pickPriorityLabel(task.priority, labelNames) : null;
    if (!label) warnings.push('priority_label_missing');
    // Relay has no verified Relay-user -> GitHub-login mapping, so the issue is never assigned.
    if (task.assignee) warnings.push('assignee_not_mapped');
    const { data } = await client.post(`/repos/${owner}/${repo}/issues`, {
      title: task.title.length > TITLE_MAX ? `${task.title.slice(0, TITLE_MAX - 1)}…` : task.title,
      body: buildIssueBody(task),
      ...(label ? { labels: [label] } : {}),
    });
    issue = data;
  }
  if (!confirmedIssue(issue)) throw new TaskSyncError(502, 'github_unavailable', safeMessage('github_unavailable'));
  return { issue, warnings, fullName: `${owner}/${repo}`, htmlUrl: typeof repoInfo.html_url === 'string' ? repoInfo.html_url : link.htmlUrl };
}

/**
 * Runs one synchronization for a task that already carries a `github` link.
 * Resolves to the up-to-date Task document; never throws for GitHub-side failures (they are recorded).
 * Throws TaskSyncError(409) only when another sync holds the lock.
 */
export async function syncTaskIssue(taskId, { now = () => new Date() } = {}) {
  const startedAt = now();
  const cutoff = new Date(startedAt.getTime() - LOCK_TTL_MS);
  const claimed = await Task.findOneAndUpdate(
    {
      _id: taskId,
      'github.connectionId': { $ne: null },
      'github.status': { $in: ['pending', 'failed'] },
      $or: [{ 'github.lockedAt': null }, { 'github.lockedAt': { $lt: cutoff } }],
    },
    { $set: { 'github.status': 'pending', 'github.lockedAt': startedAt, 'github.lastAttemptAt': startedAt, 'github.error': null }, $inc: { 'github.attempts': 1 } },
    { new: true }
  );
  if (!claimed) {
    const current = await Task.findById(taskId);
    if (!current?.github?.connectionId) throw new TaskSyncError(409, 'no_github_link', 'This task has no GitHub repository.');
    if (current.github.status === 'synced') return current;
    throw new TaskSyncError(409, 'sync_in_progress', 'A GitHub synchronization is already running for this task.');
  }

  try {
    const { issue, warnings, fullName, htmlUrl } = await createOrAdoptIssue(claimed, claimed.github.attempts);
    return await Task.findOneAndUpdate(
      { _id: taskId },
      {
        $set: {
          'github.status': 'synced', 'github.issueNumber': issue.number, 'github.issueId': Number.isSafeInteger(issue.id) ? issue.id : null,
          'github.issueUrl': issue.html_url, 'github.fullName': fullName, 'github.htmlUrl': htmlUrl,
          'github.warnings': warnings, 'github.error': null, 'github.syncedAt': now(),
        },
        $unset: { 'github.lockedAt': '' },
      },
      { new: true }
    );
  } catch (err) {
    const code = classify(err);
    console.warn(`[github-issue-sync] task ${taskId} failed: ${code}`); // codes only; never tokens or payloads
    try {
      return await Task.findOneAndUpdate(
        { _id: taskId },
        { $set: { 'github.status': 'failed', 'github.error': { code, message: safeMessage(code) } }, $unset: { 'github.lockedAt': '' } },
        { new: true }
      );
    } catch {
      // The lock goes stale and a retry reconciles by marker; the DB being down is not recoverable here.
      return Task.findById(taskId).catch(() => claimed);
    }
  }
}
