/**
 * @file sourceRecord.js
 * @description Shared SourceRecord and SourceRecordCandidate contracts for Relay's ingestion pipeline.
 *
 * STATUS: AGREED APPLICATION CONTRACT (Persistence ownership assigned to Person 2).
 *
 * ARCHITECTURAL BOUNDARIES & PERSISTENCE LIFECYCLE:
 * 1. SourceRecordCandidate (Produced by Person 1 - Integrations & Data Ingestion):
 *    - Normalized, pre-persistence representation of data from external providers (GitHub, uploaded documents).
 *    - MUST NOT contain database internal IDs (e.g. MongoDB `_id` or system UUID).
 *    - Contains canonical metadata, external identifiers, timestamps, content, and provenance.
 * 2. SourceRecord (Persisted by Person 2 - Core Backend & Persistence):
 *    - Persisted entity stored in MongoDB by Person 2's persistence layer.
 *    - Carries an assigned, stable database internal identifier (`id` / `_id`).
 * 3. AI Consumption (Person 3 - AI Pipeline):
 *    - Relies on provenance (`url`, `author`, `authorId`, `createdAt`, `updatedAt`) for evidence citation,
 *      conflict detection, and project timeline summarization.
 *
 * TIMESTAMP RULES:
 * - `createdAt`: Original source creation timestamp (e.g. issue created, commit authored).
 * - `updatedAt`: Original source modification timestamp (e.g. issue updated, commit committed).
 * - `fetchedAt`: Ingestion batch timestamp (when Relay fetched/extracted the record).
 * - `observedAt` is DEPRECATED and removed; separate creation and update timestamps must be used.
 */

/**
 * Supported data source providers.
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
 * Validates whether an object conforms to the agreed SourceRecordCandidate contract.
 * Ensures candidates do not prematurely assign internal database IDs and use separate
 * createdAt/updatedAt timestamps instead of deprecated observedAt.
 *
 * @param {unknown} record - The candidate record to validate.
 * @returns {{ valid: boolean, errors: string[] }} Validation result and list of error descriptions.
 */
export function validateSourceRecordCandidate(record) {
  const errors = [];

  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['Candidate record must be a non-null object.'] };
  }

  // Ensure candidate does not contain internal database ID (owned by Person 2 upon persistence)
  if ('_id' in record || ('id' in record && record.recordType !== undefined)) {
    errors.push('Candidate records must not include internal database IDs ("id" or "_id"); IDs are assigned by persistence layer.');
  }

  // Reject deprecated observedAt field
  if ('observedAt' in record) {
    errors.push('Field "observedAt" is deprecated; use "createdAt" and "updatedAt" instead.');
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
  if (typeof record.version !== 'number' || record.version < 1) {
    errors.push('Field "version" is required and must be a positive integer.');
  }

  if (typeof record.isActive !== 'boolean') {
    errors.push('Field "isActive" is required and must be a boolean.');
  }

  if (typeof record.isDeleted !== 'boolean') {
    errors.push('Field "isDeleted" is required and must be a boolean.');
  }

  // Date validations
  if (!record.fetchedAt || !(record.fetchedAt instanceof Date) || isNaN(record.fetchedAt.getTime())) {
    errors.push('Field "fetchedAt" is required and must be a valid Date object.');
  }

  if (record.createdAt !== undefined && record.createdAt !== null) {
    if (!(record.createdAt instanceof Date) || isNaN(record.createdAt.getTime())) {
      errors.push('Field "createdAt", if provided, must be a valid Date object.');
    }
  }

  if (record.updatedAt !== undefined && record.updatedAt !== null) {
    if (!(record.updatedAt instanceof Date) || isNaN(record.updatedAt.getTime())) {
      errors.push('Field "updatedAt", if provided, must be a valid Date object.');
    }
  }

  // Optional string fields
  if (record.url !== undefined && record.url !== null && typeof record.url !== 'string') {
    errors.push('Field "url", if provided, must be a string.');
  }

  if (record.author !== undefined && record.author !== null && typeof record.author !== 'string') {
    errors.push('Field "author", if provided, must be a string.');
  }

  if (record.authorId !== undefined && record.authorId !== null && typeof record.authorId !== 'string') {
    errors.push('Field "authorId", if provided, must be a string.');
  }

  // Optional document chunk fields
  if (record.pageNumber !== undefined && record.pageNumber !== null && typeof record.pageNumber !== 'number') {
    errors.push('Field "pageNumber", if provided, must be a number.');
  }

  if (record.passageReference !== undefined && record.passageReference !== null && typeof record.passageReference !== 'string') {
    errors.push('Field "passageReference", if provided, must be a string.');
  }

  if (record.extractionStatus !== undefined && record.extractionStatus !== null && typeof record.extractionStatus !== 'string') {
    errors.push('Field "extractionStatus", if provided, must be a string.');
  }

  // Metadata validation
  if (record.metadata !== undefined && record.metadata !== null && typeof record.metadata !== 'object') {
    errors.push('Field "metadata", if provided, must be an object.');
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
