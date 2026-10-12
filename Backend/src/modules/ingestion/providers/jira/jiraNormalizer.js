/**
 * @file jiraNormalizer.js
 * @description Pure normalization functions mapping raw Jira REST API entities
 * into canonical SourceRecordCandidate and SourceRecord contracts.
 *
 * Implements strict data normalization rules:
 * - Pure functions: never mutates input objects
 * - Preserves provenance: original issue IDs, keys (e.g. PROJ-101), project identity, and browse URLs
 * - Safe extraction: handles ADF rich-text and markdown descriptions
 * - Honest deadlines: preserves existing duedates; never invents missing deadlines
 * - Validated against both validateSourceRecordCandidate and validateSourceRecord
 */

import {
  SOURCE_PROVIDERS,
  SOURCE_RECORD_TYPES,
  SOURCE_CONTENT_TYPES,
  validateSourceRecordCandidate,
} from '../../contracts/sourceRecord.js';
import {
  RECORD_TYPES,
  SOURCE_PROVIDERS as COMMON_SOURCE_PROVIDERS,
  validateSourceRecord,
} from '../../../../integrations/common/types.js';
import { extractDescription, extractIssueProperties } from './jiraExtractor.js';
import { JiraValidationError } from './jiraErrors.js';

/**
 * Safely parses timestamp input into a valid Date object.
 * 
 * @param {unknown} val
 * @returns {Date|undefined}
 */
export function parseDate(val) {
  if (!val) return undefined;
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? undefined : val;
  }
  if (typeof val === 'string' || typeof val === 'number') {
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/**
 * Constructs the canonical web browser URL for a Jira issue.
 * 
 * @param {object} issue - Raw Jira issue.
 * @param {string} [baseUrl] - Configured Jira host URL.
 * @returns {string|undefined}
 */
export function constructIssueUrl(issue, baseUrl) {
  if (!issue || typeof issue !== 'object') return undefined;

  const key = issue.key;
  if (key && baseUrl) {
    const cleanHost = baseUrl.replace(/\/+$/, '').replace(/\/rest\/api\/.*$/, '');
    return `${cleanHost}/browse/${key}`;
  }

  // If issue.self is present (e.g., https://my-domain.atlassian.net/rest/api/3/issue/10001)
  if (typeof issue.self === 'string' && key) {
    const hostMatch = issue.self.match(/^(https?:\/\/[^/]+)/);
    if (hostMatch) {
      return `${hostMatch[1]}/browse/${key}`;
    }
  }

  return undefined;
}

/**
 * Normalizes a raw Jira issue into an agreed SourceRecordCandidate.
 * 
 * @param {object} issue - Raw Jira issue object.
 * @param {object} [context={}] - Ingestion context options.
 * @param {string} [context.projectId='default-project'] - Relay project ID.
 * @param {string} [context.baseUrl] - Configured Jira host endpoint.
 * @param {Date} [context.fetchedAt] - Ingestion batch timestamp.
 * @returns {import('../../contracts/sourceRecord.js').SourceRecordCandidate}
 */
export function normalizeJiraIssueCandidate(issue, context = {}) {
  if (!issue || typeof issue !== 'object') {
    throw new JiraValidationError('Issue entity must be a non-null object.');
  }

  const rawKey = issue.key ? String(issue.key).trim() : '';
  const rawId = issue.id ? String(issue.id).trim() : '';
  const externalId = rawKey || rawId;

  if (!externalId) {
    throw new JiraValidationError('Issue is missing a valid external identifier (key or id).');
  }

  const fields = issue.fields || {};
  const projectId = (context.projectId && String(context.projectId).trim()) || 'default-project';

  // Extract human-readable title
  const rawSummary = typeof fields.summary === 'string' ? fields.summary.trim() : '';
  const title = rawSummary || (rawKey ? `[${rawKey}] Untitled Issue` : 'Untitled Jira Issue');

  // Safely extract and format description content
  const content = extractDescription(fields.description);

  // Timestamps
  const createdAt = parseDate(fields.created);
  const updatedAt = parseDate(fields.updated);
  const fetchedAt = context.fetchedAt instanceof Date && !Number.isNaN(context.fetchedAt.getTime())
    ? context.fetchedAt
    : new Date();

  // Author provenance
  const reporter = fields.reporter;
  const creator = fields.creator;
  const authorObj = reporter || creator;
  const author = authorObj?.displayName || authorObj?.name || undefined;
  const authorId = authorObj?.accountId || authorObj?.name || undefined;

  // Issue URL
  const url = constructIssueUrl(issue, context.baseUrl);

  // Status & Resolution determination
  const statusCategory = fields.status?.statusCategory?.key;
  const isResolved = Boolean(fields.resolution || statusCategory === 'done');
  const isActive = !isResolved;

  // Supplementary metadata
  const propDetails = extractIssueProperties(fields);
  const metadata = {
    key: rawKey || null,
    issueId: rawId || null,
    project: propDetails.project,
    status: propDetails.status,
    statusCategory: propDetails.statusCategory,
    priority: propDetails.priority,
    assignee: propDetails.assignee,
    assigneeAccountId: propDetails.assigneeAccountId,
    reporter: propDetails.reporter,
    reporterAccountId: propDetails.reporterAccountId,
    labels: propDetails.labels,
    components: propDetails.components,
    dueDate: propDetails.dueDate, // Strictly no invented deadlines
    issueType: propDetails.issueType,
    resolution: propDetails.resolution,
    resolutionDate: propDetails.resolutionDate,
    sourceUrl: url || null,
  };

  /** @type {import('../../contracts/sourceRecord.js').SourceRecordCandidate} */
  const candidate = {
    projectId,
    provider: SOURCE_PROVIDERS.JIRA,
    recordType: SOURCE_RECORD_TYPES.ISSUE,
    externalId,
    title,
    content,
    contentType: SOURCE_CONTENT_TYPES.MARKDOWN,
    url,
    author,
    authorId,
    createdAt,
    updatedAt,
    fetchedAt,
    version: 1,
    isActive,
    isDeleted: false,
    metadata,
  };

  const validation = validateSourceRecordCandidate(candidate);
  if (!validation.valid) {
    throw new JiraValidationError(
      `Normalized Jira issue failed SourceRecordCandidate validation: ${validation.errors.join('; ')}`,
      { data: validation.errors }
    );
  }

  return candidate;
}

/**
 * Normalizes a Jira issue into a canonical SourceRecord adhering to validateSourceRecord.
 * 
 * @param {object} issue - Raw Jira issue object.
 * @param {object} [context={}]
 * @returns {import('../../../integrations/common/types.js').SourceRecord}
 */
export function normalizeJiraIssue(issue, context = {}) {
  const candidate = normalizeJiraIssueCandidate(issue, context);
  const id = `src_jira_${candidate.externalId}`;
  const nowIso = candidate.fetchedAt.toISOString();

  /** @type {import('../../../integrations/common/types.js').SourceRecord} */
  const record = {
    id,
    projectId: candidate.projectId,
    provider: COMMON_SOURCE_PROVIDERS.JIRA,
    externalId: candidate.externalId,
    type: RECORD_TYPES.ISSUE,
    recordType: RECORD_TYPES.ISSUE,
    title: candidate.title,
    content: candidate.content,
    url: candidate.url,
    author: candidate.author,
    authorId: candidate.authorId,
    observedAt: candidate.updatedAt ? candidate.updatedAt.toISOString() : (candidate.createdAt ? candidate.createdAt.toISOString() : undefined),
    createdAt: candidate.createdAt ? candidate.createdAt.toISOString() : undefined,
    updatedAt: candidate.updatedAt ? candidate.updatedAt.toISOString() : undefined,
    fetchedAt: nowIso,
    metadata: candidate.metadata,
  };

  const validation = validateSourceRecord(record);
  if (!validation.valid) {
    throw new JiraValidationError(
      `Normalized Jira issue failed SourceRecord validation: ${validation.errors.join('; ')}`,
      { data: validation.errors }
    );
  }

  return record;
}
