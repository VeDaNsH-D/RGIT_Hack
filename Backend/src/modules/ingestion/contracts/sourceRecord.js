/**
 * @file sourceRecord.js
 * @description Shared SourceRecord and SourceRecordCandidate contracts for Relay's ingestion pipeline.
 *
 * STATUS: AGREED APPLICATION CONTRACT (Persistence ownership assigned to Person 2).
 *
 * ARCHITECTURAL BOUNDARIES & PERSISTENCE LIFECYCLE:
 * 1. SourceRecordCandidate (Produced by Person 1 - Integrations & Data Ingestion):
 *    - Normalized, pre-persistence representation of data from external providers (GitHub, uploaded documents).
 *    - MUST NOT contain database internal IDs (e.g. MongoDB `_id` or `id`).
 *    - Contains canonical metadata, external identifiers, timestamps, content, and provenance.
 * 2. SourceRecord (Persisted by Person 2 - Core Backend & Persistence, see src/models/SourceRecord.js):
 *    - Persisted entity stored in MongoDB by Person 2's persistence layer.
 *    - Carries an assigned, stable database internal identifier (`_id`).
 *    - Upserted by the unique key (projectId, provider, externalId).
 *    - `toSourceRecordDocument()` below is the single mapping from candidate to model fields.
 * 3. AI Consumption (Person 3 - AI Pipeline):
 *    - Relies on provenance (`url`, `author`, `authorId`, `createdAt`, `updatedAt`) for evidence citation,
 *      conflict detection, and project timeline summarization.
 *
 * TIMESTAMP RULES:
 * - `createdAt`: Original source creation timestamp (e.g. issue created, commit authored).
 * - `updatedAt`: Original source modification timestamp (e.g. issue updated, commit committed).
 * - `fetchedAt`: Ingestion batch timestamp (when Relay fetched/extracted the record).
 * - Candidates hold JS `Date` objects; they serialize to ISO 8601 strings at API boundaries.
 * - The persisted model's own `createdAt`/`updatedAt` are Mongoose persistence timestamps, NOT source
 *   timestamps, so the mapping stores source timestamps as `metadata.sourceCreatedAt` / `sourceUpdatedAt`.
 * - `observedAt` is DEPRECATED and removed; separate creation and update timestamps must be used.
 */

/**
 * Supported data source providers produced by the ingestion module.
 *
 * Note: Person 2's notes route also persists SourceRecords with provider `manual`
 * (recordType `decision`/`note`). Those are not ingestion candidates and are
 * intentionally not part of this enum.
 * @readonly
 * @enum {string}
 */
export const SOURCE_PROVIDERS = Object.freeze({
  GITHUB: 'github',
  DOCUMENT: 'document',
});

/**
 * Supported record types.
 * @readonly
 * @enum {string}
 */
export const SOURCE_RECORD_TYPES = Object.freeze({
  REPOSITORY: 'repository',
  ISSUE: 'issue',
  PULL_REQUEST: 'pull_request',
  COMMIT: 'commit',
  DOCUMENT: 'document',
});

/**
 * Standard content MIME types produced by ingestion normalizers.
 * @readonly
 * @enum {string}
 */
export const SOURCE_CONTENT_TYPES = Object.freeze({
  MARKDOWN: 'text/markdown',
  PLAIN: 'text/plain',
  HTML: 'text/html',
  JSON: 'application/json',
});

/**
 * Fields that are owned by the persistence layer (or deprecated) and must never
 * appear on an unpersisted candidate.
 * @readonly
 */
export const CANDIDATE_FORBIDDEN_FIELDS = Object.freeze(['_id', 'id', 'observedAt', 'type']);

/**
 * Overall status of a fetch-and-normalize ingestion run.
 * - `succeeded`: every resource category was fetched (an empty result is still a success).
 * - `partial`: at least one category failed, at least one succeeded.
 * - `failed`: no category succeeded.
 * @readonly
 * @enum {string}
 */
export const INGESTION_STATUS = Object.freeze({
  SUCCEEDED: 'succeeded',
  PARTIAL: 'partial',
  FAILED: 'failed',
});

/**
 * Per-resource-category status inside an ingestion result.
 * - `skipped`: not attempted (disabled by caller or aborted after a fatal error).
 * @readonly
 * @enum {string}
 */
export const RESOURCE_STATUS = Object.freeze({
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

/**
 * @typedef {Object} SourceRecordCandidate
 * @property {string} projectId - Relay project identifier that owns this ingested data.
 * @property {'github'|'document'} provider - Originating provider of the data.
 * @property {'repository'|'issue'|'pull_request'|'commit'|'document'} recordType - Specific type of the ingested entity.
 * @property {string} externalId - Unique, stable identifier from the source provider (repository-scoped or globally unique).
 * @property {string} title - Human-readable title or document name.
 * @property {string} content - Extracted text content or markdown representation used for AI analysis.
 * @property {string} contentType - Media type of the content (e.g. 'text/markdown', 'text/plain').
 * @property {string} [url] - Canonical URL linking back to the external source for verification.
 * @property {string} [author] - Name, handle, or identifier of the original creator/committer.
 * @property {string} [authorId] - Provider-specific unique author/user ID.
 * @property {Date} [createdAt] - Timestamp when the entity was created at the source provider.
 * @property {Date} [updatedAt] - Timestamp when the entity was last updated at the source provider.
 * @property {Date} fetchedAt - Timestamp when Relay ingested this record.
 * @property {number} version - Record schema version (default: 1).
 * @property {boolean} isActive - Whether the record is currently active in the project context.
 * @property {boolean} isDeleted - Soft-delete flag at the source or in Relay.
 * @property {Record<string, unknown>} [metadata] - Optional provider-specific supplementary attributes.
 * @property {number} [pageNumber] - Document page number (for document chunks).
 * @property {string} [passageReference] - Document section or passage reference.
 * @property {string} [extractionStatus] - Status of text extraction (e.g. 'completed', 'failed').
 */

/**
 * @typedef {SourceRecordCandidate & { id: string }} SourceRecord
 * Persisted source record with assigned database ID (owned by Person 2).
 */

/**
 * @typedef {Object} IngestionError
 * @property {string} resource - Resource category that failed (e.g. 'pullRequests').
 * @property {string} code - Stable error code (GITHUB_ERROR_CODES).
 * @property {string} message - Sanitized, credential-free message.
 * @property {number|null} [status] - Upstream HTTP status, when applicable.
 * @property {string} [externalId] - Offending record, for per-record normalization failures.
 */

/**
 * @typedef {Object} IngestionResult
 * @property {string} provider
 * @property {string} projectId
 * @property {'succeeded'|'partial'|'failed'} status
 * @property {boolean} persisted - false until a persistence adapter writes the candidates.
 * @property {number} fetchedCount - Items returned by the provider across all categories.
 * @property {number} normalizedCount - Items that became valid SourceRecordCandidates.
 * @property {number} skippedCount - Items intentionally excluded (e.g. PRs on the issues endpoint).
 * @property {number} failedCount - Items fetched but rejected during normalization.
 * @property {number|null} createdCount - null until persisted (never fabricated).
 * @property {number|null} updatedCount - null until persisted (never fabricated).
 * @property {Record<string, Object>} resources - Per-category breakdown.
 * @property {IngestionError[]} errors
 * @property {string} startedAt - ISO 8601.
 * @property {string|null} completedAt - ISO 8601.
 */

function isValidDate(value) {
  return value instanceof Date && !isNaN(value.getTime());
}

function isOptional(value) {
  return value === undefined || value === null;
}

/**
 * Validates whether an object conforms to the agreed SourceRecordCandidate contract.
 * Ensures candidates do not prematurely assign internal database IDs and use separate
 * createdAt/updatedAt timestamps instead of deprecated observedAt.
 *
 * @param {unknown} record - The candidate record to validate.
 * @returns {{ valid: boolean, errors: string[] }} Validation result and list of error descriptions.
 */
export function validateSourceRecordCandidate(record) {
  const errors = [];

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: ['Candidate record must be a non-null object.'] };
  }

  // Ensure candidate does not contain internal database ID (owned by Person 2 upon persistence)
  if ('_id' in record || 'id' in record) {
    errors.push('Candidate records must not include internal database IDs ("id" or "_id"); IDs are assigned by persistence layer.');
  }

  // Reject deprecated observedAt field
  if ('observedAt' in record) {
    errors.push('Field "observedAt" is deprecated; use "createdAt" and "updatedAt" instead.');
  }

  // "type" is the persisted model's field name; candidates must use "recordType"
  if ('type' in record) {
    errors.push('Field "type" belongs to the persisted SourceRecord; candidates must use "recordType".');
  }

  // Required string fields
  if (typeof record.projectId !== 'string' || !record.projectId.trim()) {
    errors.push('Field "projectId" is required and must be a non-empty string.');
  }

  if (typeof record.externalId !== 'string' || !record.externalId.trim()) {
    errors.push('Field "externalId" is required and must be a non-empty string.');
  }

  if (typeof record.title !== 'string' || !record.title.trim()) {
    errors.push('Field "title" is required and must be a non-empty string.');
  }

  if (typeof record.content !== 'string') {
    errors.push('Field "content" is required and must be a string.');
  }

  if (typeof record.contentType !== 'string' || !record.contentType.trim()) {
    errors.push('Field "contentType" is required and must be a non-empty string.');
  }

  // Enum validations
  const validProviders = Object.values(SOURCE_PROVIDERS);
  if (!validProviders.includes(record.provider)) {
    errors.push(`Field "provider" must be one of: ${validProviders.join(', ')}.`);
  }

  const validRecordTypes = Object.values(SOURCE_RECORD_TYPES);
  if (!validRecordTypes.includes(record.recordType)) {
    errors.push(`Field "recordType" must be one of: ${validRecordTypes.join(', ')}.`);
  }

  // Lifecycle & status flags
  if (!Number.isInteger(record.version) || record.version < 1) {
    errors.push('Field "version" is required and must be a positive integer.');
  }

  if (typeof record.isActive !== 'boolean') {
    errors.push('Field "isActive" is required and must be a boolean.');
  }

  if (typeof record.isDeleted !== 'boolean') {
    errors.push('Field "isDeleted" is required and must be a boolean.');
  }

  // Date validations
  if (!isValidDate(record.fetchedAt)) {
    errors.push('Field "fetchedAt" is required and must be a valid Date object.');
  }

  if (!isOptional(record.createdAt) && !isValidDate(record.createdAt)) {
    errors.push('Field "createdAt", if provided, must be a valid Date object.');
  }

  if (!isOptional(record.updatedAt) && !isValidDate(record.updatedAt)) {
    errors.push('Field "updatedAt", if provided, must be a valid Date object.');
  }

  // Optional string fields
  if (!isOptional(record.url)) {
    if (typeof record.url !== 'string') {
      errors.push('Field "url", if provided, must be a string.');
    } else if (record.url && !/^https?:\/\//i.test(record.url)) {
      errors.push('Field "url", if provided, must be an http(s) URL.');
    }
  }

  if (!isOptional(record.author) && typeof record.author !== 'string') {
    errors.push('Field "author", if provided, must be a string.');
  }

  if (!isOptional(record.authorId) && typeof record.authorId !== 'string') {
    errors.push('Field "authorId", if provided, must be a string.');
  }

  // Optional document chunk fields
  if (!isOptional(record.pageNumber) && typeof record.pageNumber !== 'number') {
    errors.push('Field "pageNumber", if provided, must be a number.');
  }

  if (!isOptional(record.passageReference) && typeof record.passageReference !== 'string') {
    errors.push('Field "passageReference", if provided, must be a string.');
  }

  if (!isOptional(record.extractionStatus) && typeof record.extractionStatus !== 'string') {
    errors.push('Field "extractionStatus", if provided, must be a string.');
  }

  // Metadata validation
  if (!isOptional(record.metadata) && (typeof record.metadata !== 'object' || Array.isArray(record.metadata))) {
    errors.push('Field "metadata", if provided, must be a plain object.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Backward compatibility alias for validateSourceRecordCandidate.
 */
export const validateSourceRecord = validateSourceRecordCandidate;

/**
 * Maps a validated SourceRecordCandidate onto the field set of Person 2's
 * persisted SourceRecord model (src/models/SourceRecord.js). Pure function; it
 * performs no database access and does not assign `_id`.
 *
 * Mapping:
 *   candidate.recordType          -> type
 *   candidate.url (undefined)     -> url ''          (model default)
 *   projectId/provider/externalId -> same names      (unique upsert key)
 *   title/content                 -> same names
 *   contentType, author, authorId, fetchedAt, version, isActive, isDeleted,
 *   pageNumber, passageReference, extractionStatus
 *                                 -> metadata.<same name>
 *   createdAt / updatedAt         -> metadata.sourceCreatedAt / metadata.sourceUpdatedAt
 *                                    (the model's own createdAt/updatedAt are Mongoose
 *                                    persistence timestamps and must not be overwritten)
 *   metadata (provider-specific)  -> metadata.providerMetadata
 *
 * `projectId` is passed through as a string; Mongoose casts it to ObjectId.
 *
 * @param {SourceRecordCandidate} candidate
 * @returns {{ projectId: string, provider: string, externalId: string, type: string, title: string, url: string, content: string, metadata: Record<string, unknown> }}
 * @throws {TypeError} If the candidate violates the contract.
 */
export function toSourceRecordDocument(candidate) {
  const validation = validateSourceRecordCandidate(candidate);
  if (!validation.valid) {
    throw new TypeError(`Cannot map invalid SourceRecordCandidate: ${validation.errors.join('; ')}`);
  }

  const metadata = {
    contentType: candidate.contentType,
    author: candidate.author ?? null,
    authorId: candidate.authorId ?? null,
    sourceCreatedAt: candidate.createdAt ?? null,
    sourceUpdatedAt: candidate.updatedAt ?? null,
    fetchedAt: candidate.fetchedAt,
    version: candidate.version,
    isActive: candidate.isActive,
    isDeleted: candidate.isDeleted,
    providerMetadata: candidate.metadata ? { ...candidate.metadata } : {},
  };

  for (const field of ['pageNumber', 'passageReference', 'extractionStatus']) {
    if (!isOptional(candidate[field])) metadata[field] = candidate[field];
  }

  return {
    projectId: candidate.projectId,
    provider: candidate.provider,
    externalId: candidate.externalId,
    type: candidate.recordType,
    title: candidate.title,
    url: candidate.url || '',
    content: candidate.content,
    metadata,
  };
}

/**
 * Creates an empty ingestion result with predictable counters. Persistence
 * counters start as `null` so a fetch-only run can never claim records were
 * created or updated.
 *
 * @param {Object} params
 * @param {string} params.provider
 * @param {string} params.projectId
 * @param {string[]} [params.resources] - Resource category names to pre-register.
 * @param {Date} [params.startedAt]
 * @returns {IngestionResult}
 */
export function createIngestionResult({ provider, projectId, resources = [], startedAt = new Date() }) {
  const result = {
    provider,
    projectId,
    status: INGESTION_STATUS.SUCCEEDED,
    persisted: false,
    fetchedCount: 0,
    normalizedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    createdCount: null,
    updatedCount: null,
    resources: {},
    errors: [],
    startedAt: startedAt.toISOString(),
    completedAt: null,
  };

  for (const name of resources) {
    result.resources[name] = {
      status: RESOURCE_STATUS.SKIPPED,
      fetchedCount: 0,
      normalizedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      hasMore: false,
    };
  }

  return result;
}

/**
 * Recomputes totals and overall status from the per-resource breakdown and
 * stamps completedAt. Mutates and returns the given result.
 *
 * @param {IngestionResult} result
 * @param {Date} [completedAt]
 * @returns {IngestionResult}
 */
export function finalizeIngestionResult(result, completedAt = new Date()) {
  const entries = Object.values(result.resources);

  for (const key of ['fetchedCount', 'normalizedCount', 'skippedCount', 'failedCount']) {
    result[key] = entries.reduce((sum, r) => sum + r[key], 0);
  }

  const succeeded = entries.filter((r) => r.status === RESOURCE_STATUS.SUCCEEDED).length;

  // Any error (failed category or rejected record) downgrades a clean success.
  if (result.errors.length === 0) {
    result.status = INGESTION_STATUS.SUCCEEDED;
  } else if (succeeded > 0) {
    result.status = INGESTION_STATUS.PARTIAL;
  } else {
    result.status = INGESTION_STATUS.FAILED;
  }

  result.completedAt = completedAt.toISOString();
  return result;
}
