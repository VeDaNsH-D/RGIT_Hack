/**
 * @file githubNormalizer.js
 * @description Pure normalization functions transforming raw GitHub REST API responses
 * into SourceRecordCandidate representations adhering to the agreed application contract.
 *
 * Implements strict data normalization rules:
 * - Pure functions: never mutates input objects
 * - Produces SourceRecordCandidate objects without internal database IDs (IDs owned by Person 2 upon persistence)
 * - Repository-scoped, stable externalId construction (preserving repository identity and full commit SHAs)
 * - Separate source createdAt and updatedAt timestamps (observedAt is deprecated and excluded)
 * - Safe string conversions (handles null/empty bodies)
 * - Consistent population of contentType, version, isActive, isDeleted, and metadata
 * - Validated against validateSourceRecordCandidate
 */

import {
  SOURCE_PROVIDERS,
  SOURCE_RECORD_TYPES,
  SOURCE_CONTENT_TYPES,
  validateSourceRecordCandidate,
} from '../../contracts/sourceRecord.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from './githubErrors.js';

/**
 * Safely parses an input value into a valid Date instance.
 *
 * @param {unknown} val - Input timestamp (Date, string, or number).
 * @returns {Date|undefined} Valid Date instance or undefined.
 */
export function parseDate(val) {
  if (!val) return undefined;
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? undefined : val;
  }
  if (typeof val === 'string' || typeof val === 'number') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/**
 * Extracts a bounded list of logins from an array of GitHub user objects.
 *
 * @param {unknown} users
 * @returns {string[]}
 */
function loginsOf(users) {
  if (!Array.isArray(users)) return [];
  return users
    .map((u) => (u && typeof u === 'object' ? u.login : undefined))
    .filter((login) => typeof login === 'string' && login)
    .slice(0, 50);
}

/**
 * Extracts label names from GitHub label objects or strings.
 *
 * @param {unknown} labels
 * @returns {string[]}
 */
function labelNamesOf(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === 'object' && l ? l.name : typeof l === 'string' ? l : undefined))
    .filter((name) => typeof name === 'string' && name);
}

/**
 * Ensures an explicit, non-empty projectId is provided by the caller.
 *
 * @param {string} projectId
 * @returns {string} Trimmed projectId.
 * @throws {GitHubApiError} If projectId is missing or invalid.
 */
function assertProjectId(projectId) {
  if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
    throw new GitHubApiError('Normalization requires a non-empty string "projectId" supplied by the caller.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }
  return projectId.trim();
}

/**
 * Ensures a valid fetchedAt Date instance is provided or defaults to now.
 *
 * @param {Date|undefined} fetchedAt
 * @returns {Date}
 */
function resolveFetchedAt(fetchedAt) {
  if (fetchedAt instanceof Date && !isNaN(fetchedAt.getTime())) {
    return fetchedAt;
  }
  return new Date();
}

/**
 * Normalizes a GitHub repository entity into a SourceRecordCandidate.
 *
 * @param {Object} repo - Raw GitHub repository object.
 * @param {Object} context
 * @param {string} context.projectId - Relay project identifier.
 * @param {Date} [context.fetchedAt] - Ingestion batch timestamp.
 * @returns {import('../../contracts/sourceRecord.js').SourceRecordCandidate}
 */
export function normalizeRepository(repo, context = {}) {
  if (!repo || typeof repo !== 'object') {
    throw new GitHubApiError('Repository entity must be a non-null object.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const projectId = assertProjectId(context.projectId);
  const fetchedAt = resolveFetchedAt(context.fetchedAt);

  const externalId = repo.node_id || repo.full_name || (repo.id !== undefined ? String(repo.id) : null);
  if (!externalId) {
    throw new GitHubApiError('Repository is missing a valid external identifier (node_id, full_name, or id).', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const title = (repo.full_name || repo.name || 'Repository').trim();

  // Concise textual representation of relevant repository properties
  const contentParts = [];
  if (repo.description) contentParts.push(repo.description.trim());
  if (repo.language) contentParts.push(`Primary language: ${repo.language}`);
  if (repo.default_branch) contentParts.push(`Default branch: ${repo.default_branch}`);
  if (repo.topics && Array.isArray(repo.topics) && repo.topics.length > 0) {
    contentParts.push(`Topics: ${repo.topics.join(', ')}`);
  }
  const content = contentParts.join('\n');

  const createdAt = parseDate(repo.created_at);
  const updatedAt = parseDate(repo.updated_at || repo.pushed_at);

  const author = repo.owner && typeof repo.owner === 'object'
    ? repo.owner.login || repo.owner.name || undefined
    : undefined;

  const authorId = repo.owner && typeof repo.owner === 'object'
    ? (repo.owner.id !== undefined ? String(repo.owner.id) : (repo.owner.node_id || undefined))
    : undefined;

  const metadata = {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: repo.full_name,
    owner: author,
    description: typeof repo.description === 'string' ? repo.description : null,
    html_url: repo.html_url,
    private: repo.private,
    visibility: repo.visibility || (repo.private === true ? 'private' : repo.private === false ? 'public' : undefined),
    archived: repo.archived,
    fork: repo.fork,
    topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 50) : [],
    default_branch: repo.default_branch,
    language: repo.language,
    stargazers_count: repo.stargazers_count,
    forks_count: repo.forks_count,
    open_issues_count: repo.open_issues_count,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    license: repo.license ? repo.license.spdx_id || repo.license.name : undefined,
  };

  /** @type {import('../../contracts/sourceRecord.js').SourceRecordCandidate} */
  const candidate = {
    projectId,
    provider: SOURCE_PROVIDERS.GITHUB,
    recordType: SOURCE_RECORD_TYPES.REPOSITORY,
    externalId,
    title,
    content,
    contentType: SOURCE_CONTENT_TYPES.PLAIN,
    url: typeof repo.html_url === 'string' ? repo.html_url : undefined,
    author,
    authorId,
    createdAt,
    updatedAt,
    fetchedAt,
    version: 1,
    isActive: true,
    isDeleted: false,
    metadata,
  };

  const validation = validateSourceRecordCandidate(candidate);
  if (!validation.valid) {
    throw new GitHubApiError(`Normalized repository failed SourceRecordCandidate validation: ${validation.errors.join('; ')}`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
      data: validation.errors,
    });
  }

  return candidate;
}

/**
 * Normalizes a GitHub issue entity into a SourceRecordCandidate.
 *
 * @param {Object} issue - Raw GitHub issue object.
 * @param {Object} context
 * @param {string} context.projectId - Relay project identifier.
 * @param {string} [context.repoFullName] - Repository full name (e.g., 'owner/repo') for stable scoping.
 * @param {Date} [context.fetchedAt] - Ingestion batch timestamp.
 * @returns {import('../../contracts/sourceRecord.js').SourceRecordCandidate}
 */
export function normalizeIssue(issue, context = {}) {
  if (!issue || typeof issue !== 'object') {
    throw new GitHubApiError('Issue entity must be a non-null object.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  // GitHub's issues endpoint also returns pull requests; those must be ingested
  // only through normalizePullRequest so a PR never appears as both record types.
  if (issue.pull_request) {
    throw new GitHubApiError('Item is a pull request and must not be normalized as an issue.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const projectId = assertProjectId(context.projectId);
  const fetchedAt = resolveFetchedAt(context.fetchedAt);

  // Scoped external identifier: prefer node_id or repository-scoped issue number
  const repoPrefix = context.repoFullName ? `${context.repoFullName}#` : '';
  const externalId = issue.node_id
    || (issue.number !== undefined ? `${repoPrefix}issue-${issue.number}` : null)
    || (issue.id !== undefined ? `issue-${issue.id}` : null);

  if (!externalId) {
    throw new GitHubApiError('Issue is missing a valid external identifier (node_id, number, or id).', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const rawTitle = typeof issue.title === 'string' ? issue.title.trim() : '';
  const title = rawTitle || `Issue #${issue.number || issue.id || 'unknown'}`;

  // Treat missing or null bodies as empty string
  const content = typeof issue.body === 'string' ? issue.body : '';

  const createdAt = parseDate(issue.created_at);
  const updatedAt = parseDate(issue.updated_at);

  const author = issue.user && typeof issue.user === 'object'
    ? issue.user.login || issue.user.name || undefined
    : undefined;

  const authorId = issue.user && typeof issue.user === 'object'
    ? (issue.user.id !== undefined ? String(issue.user.id) : (issue.user.node_id || undefined))
    : undefined;

  const metadata = {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    state: issue.state,
    state_reason: issue.state_reason,
    comments_count: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    labels: labelNamesOf(issue.labels),
    assignee: issue.assignee && typeof issue.assignee === 'object' ? issue.assignee.login : undefined,
    assignees: loginsOf(issue.assignees),
    milestone: issue.milestone && typeof issue.milestone === 'object' ? issue.milestone.title : undefined,
    is_pull_request: Boolean(issue.pull_request),
  };

  /** @type {import('../../contracts/sourceRecord.js').SourceRecordCandidate} */
  const candidate = {
    projectId,
    provider: SOURCE_PROVIDERS.GITHUB,
    recordType: SOURCE_RECORD_TYPES.ISSUE,
    externalId,
    title,
    content,
    contentType: SOURCE_CONTENT_TYPES.MARKDOWN,
    url: typeof issue.html_url === 'string' ? issue.html_url : undefined,
    author,
    authorId,
    createdAt,
    updatedAt,
    fetchedAt,
    version: 1,
    isActive: issue.state !== 'closed',
    isDeleted: false,
    metadata,
  };

  const validation = validateSourceRecordCandidate(candidate);
  if (!validation.valid) {
    throw new GitHubApiError(`Normalized issue failed SourceRecordCandidate validation: ${validation.errors.join('; ')}`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
      data: validation.errors,
    });
  }

  return candidate;
}

/**
 * Normalizes a GitHub pull request entity into a SourceRecordCandidate.
 *
 * @param {Object} pr - Raw GitHub pull request object.
 * @param {Object} context
 * @param {string} context.projectId - Relay project identifier.
 * @param {string} [context.repoFullName] - Repository full name for stable scoping.
 * @param {Date} [context.fetchedAt] - Ingestion batch timestamp.
 * @returns {import('../../contracts/sourceRecord.js').SourceRecordCandidate}
 */
export function normalizePullRequest(pr, context = {}) {
  if (!pr || typeof pr !== 'object') {
    throw new GitHubApiError('Pull request entity must be a non-null object.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const projectId = assertProjectId(context.projectId);
  const fetchedAt = resolveFetchedAt(context.fetchedAt);

  // Scoped external identifier: prefer node_id or repository-scoped PR number
  const repoPrefix = context.repoFullName ? `${context.repoFullName}#` : '';
  const externalId = pr.node_id
    || (pr.number !== undefined ? `${repoPrefix}pr-${pr.number}` : null)
    || (pr.id !== undefined ? `pr-${pr.id}` : null);

  if (!externalId) {
    throw new GitHubApiError('Pull request is missing a valid external identifier (node_id, number, or id).', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const rawTitle = typeof pr.title === 'string' ? pr.title.trim() : '';
  const title = rawTitle || `Pull Request #${pr.number || pr.id || 'unknown'}`;

  // Treat missing or null bodies as empty string
  const content = typeof pr.body === 'string' ? pr.body : '';

  const createdAt = parseDate(pr.created_at);
  const updatedAt = parseDate(pr.updated_at);

  const author = pr.user && typeof pr.user === 'object'
    ? pr.user.login || pr.user.name || undefined
    : undefined;

  const authorId = pr.user && typeof pr.user === 'object'
    ? (pr.user.id !== undefined ? String(pr.user.id) : (pr.user.node_id || undefined))
    : undefined;

  const metadata = {
    id: pr.id,
    node_id: pr.node_id,
    number: pr.number,
    state: pr.state,
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged || pr.merged_at),
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    base_branch: pr.base && typeof pr.base === 'object' ? pr.base.ref : undefined,
    base_sha: pr.base && typeof pr.base === 'object' ? pr.base.sha : undefined,
    head_branch: pr.head && typeof pr.head === 'object' ? pr.head.ref : undefined,
    head_sha: pr.head && typeof pr.head === 'object' ? pr.head.sha : undefined,
    labels: labelNamesOf(pr.labels),
    assignees: loginsOf(pr.assignees),
    requested_reviewers: loginsOf(pr.requested_reviewers),
  };

  /** @type {import('../../contracts/sourceRecord.js').SourceRecordCandidate} */
  const candidate = {
    projectId,
    provider: SOURCE_PROVIDERS.GITHUB,
    recordType: SOURCE_RECORD_TYPES.PULL_REQUEST,
    externalId,
    title,
    content,
    contentType: SOURCE_CONTENT_TYPES.MARKDOWN,
    url: typeof pr.html_url === 'string' ? pr.html_url : undefined,
    author,
    authorId,
    createdAt,
    updatedAt,
    fetchedAt,
    version: 1,
    isActive: pr.state !== 'closed',
    isDeleted: false,
    metadata,
  };

  const validation = validateSourceRecordCandidate(candidate);
  if (!validation.valid) {
    throw new GitHubApiError(`Normalized pull request failed SourceRecordCandidate validation: ${validation.errors.join('; ')}`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
      data: validation.errors,
    });
  }

  return candidate;
}

/**
 * Normalizes a GitHub commit entity into a SourceRecordCandidate.
 *
 * Timestamp mapping:
 * - `createdAt`: authored date (when changes were originally written).
 * - `updatedAt`: committed date (when commit was applied to branch/tree).
 * Note: Git timestamps reflect local client clocks and may exhibit skew.
 *
 * @param {Object} commit - Raw GitHub commit object.
 * @param {Object} context
 * @param {string} context.projectId - Relay project identifier.
 * @param {string} [context.repoFullName] - Repository full name to scope the commit.
 * @param {Date} [context.fetchedAt] - Ingestion batch timestamp.
 * @returns {import('../../contracts/sourceRecord.js').SourceRecordCandidate}
 */
export function normalizeCommit(commit, context = {}) {
  if (!commit || typeof commit !== 'object') {
    throw new GitHubApiError('Commit entity must be a non-null object.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const projectId = assertProjectId(context.projectId);
  const fetchedAt = resolveFetchedAt(context.fetchedAt);

  // Commits preserve full SHA and repository identity
  const fullSha = typeof commit.sha === 'string' ? commit.sha.trim() : '';
  if (!fullSha) {
    throw new GitHubApiError('Commit is missing a valid full SHA identifier.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const repoPrefix = context.repoFullName ? `${context.repoFullName}#` : '';
  const externalId = `${repoPrefix}commit-${fullSha}`;

  const commitMessage = commit.commit && typeof commit.commit === 'object' && typeof commit.commit.message === 'string'
    ? commit.commit.message
    : '';

  // Title uses the first line of the commit message, falling back to full commit reference
  const firstLine = commitMessage.split('\n')[0].trim();
  const title = firstLine || `Commit ${fullSha}`;

  // Content holds the full commit message
  const content = commitMessage;

  const createdAt = parseDate(commit.commit && commit.commit.author ? commit.commit.author.date : undefined);
  const updatedAt = parseDate(
    (commit.commit && commit.commit.committer && commit.commit.committer.date)
    || createdAt
  );

  const author = (commit.author && commit.author.login)
    || (commit.commit && commit.commit.author && commit.commit.author.name)
    || (commit.commit && commit.commit.committer && commit.commit.committer.name)
    || undefined;

  const authorId = commit.author && typeof commit.author === 'object'
    ? (commit.author.id !== undefined ? String(commit.author.id) : (commit.author.node_id || undefined))
    : undefined;

  const metadata = {
    sha: fullSha,
    node_id: commit.node_id,
    author_login: commit.author && typeof commit.author === 'object' ? commit.author.login : undefined,
    author_name: commit.commit && commit.commit.author ? commit.commit.author.name : undefined,
    author_email: commit.commit && commit.commit.author ? commit.commit.author.email : undefined,
    committer_name: commit.commit && commit.commit.committer ? commit.commit.committer.name : undefined,
    committer_date: commit.commit && commit.commit.committer ? commit.commit.committer.date : undefined,
    parents: Array.isArray(commit.parents) ? commit.parents.map((p) => (p && p.sha) || null).filter(Boolean) : [],
  };

  /** @type {import('../../contracts/sourceRecord.js').SourceRecordCandidate} */
  const candidate = {
    projectId,
    provider: SOURCE_PROVIDERS.GITHUB,
    recordType: SOURCE_RECORD_TYPES.COMMIT,
    externalId,
    title,
    content,
    contentType: SOURCE_CONTENT_TYPES.PLAIN,
    url: typeof commit.html_url === 'string' ? commit.html_url : undefined,
    author,
    authorId,
    createdAt,
    updatedAt,
    fetchedAt,
    version: 1,
    isActive: true,
    isDeleted: false,
    metadata,
  };

  const validation = validateSourceRecordCandidate(candidate);
  if (!validation.valid) {
    throw new GitHubApiError(`Normalized commit failed SourceRecordCandidate validation: ${validation.errors.join('; ')}`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
      data: validation.errors,
    });
  }

  return candidate;
}

/**
 * Normalizes an array of GitHub issues into SourceRecordCandidate objects.
 *
 * @param {Object[]} issues
 * @param {Object} context
 * @returns {import('../../contracts/sourceRecord.js').SourceRecordCandidate[]}
 */
export function normalizeIssues(issues, context = {}) {
  if (!Array.isArray(issues)) {
    throw new GitHubApiError('Issues input must be an array.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }
  const batchFetchedAt = resolveFetchedAt(context.fetchedAt);
  return issues.map((issue) => normalizeIssue(issue, { ...context, fetchedAt: batchFetchedAt }));
}

/**
 * Normalizes an array of GitHub pull requests into SourceRecordCandidate objects.
 *
 * @param {Object[]} prs
 * @param {Object} context
 * @returns {import('../../contracts/sourceRecord.js').SourceRecordCandidate[]}
 */
export function normalizePullRequests(prs, context = {}) {
  if (!Array.isArray(prs)) {
    throw new GitHubApiError('Pull requests input must be an array.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }
  const batchFetchedAt = resolveFetchedAt(context.fetchedAt);
  return prs.map((pr) => normalizePullRequest(pr, { ...context, fetchedAt: batchFetchedAt }));
}

/**
 * Normalizes an array of GitHub commits into SourceRecordCandidate objects.
 *
 * @param {Object[]} commits
 * @param {Object} context
 * @returns {import('../../contracts/sourceRecord.js').SourceRecordCandidate[]}
 */
export function normalizeCommits(commits, context = {}) {
  if (!Array.isArray(commits)) {
    throw new GitHubApiError('Commits input must be an array.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }
  const batchFetchedAt = resolveFetchedAt(context.fetchedAt);
  return commits.map((commit) => normalizeCommit(commit, { ...context, fetchedAt: batchFetchedAt }));
}
