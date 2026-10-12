/**
 * Normalized Source Record Contract
 * 
 * Defines the common data ingestion model used across all external providers
 * (GitHub, Notion, Jira, Documents, Manual Notes).
 */

export const SOURCE_PROVIDERS = Object.freeze({
  GITHUB: 'github',
  NOTION: 'notion',
  JIRA: 'jira',
  SLACK: 'slack',
  DOCUMENT: 'document',
  MANUAL: 'manual',
});

export const RECORD_TYPES = Object.freeze({
  ISSUE: 'issue',
  PULL_REQUEST: 'pull_request',
  DOCUMENT: 'document',
  NOTE: 'note',
  DECISION: 'decision',
  MESSAGE: 'message',
});

/**
 * Validates whether an object complies with the normalized SourceRecord contract.
 * 
 * @param {unknown} record
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSourceRecord(record) {
  const errors = [];

  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['SourceRecord must be a non-null object.'] };
  }

  const requiredStringFields = ['id', 'title'];
  for (const field of requiredStringFields) {
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      errors.push(`Field '${field}' is required and must be a non-empty string.`);
    }
  }

  // Validate provider
  if (!Object.values(SOURCE_PROVIDERS).includes(record.provider)) {
    errors.push(
      `Field 'provider' has unsupported value '${record.provider}'. Must be one of: ${Object.values(
        SOURCE_PROVIDERS
      ).join(', ')}.`
    );
  }

  // Validate recordType or type
  const recordTypeVal = record.recordType || record.type;
  if (!Object.values(RECORD_TYPES).includes(recordTypeVal)) {
    errors.push(
      `Field 'type'/'recordType' has unsupported value '${recordTypeVal}'. Must be one of: ${Object.values(
        RECORD_TYPES
      ).join(', ')}.`
    );
  }

  // Content must be a string (can be empty string for empty pages)
  if (typeof record.content !== 'string') {
    errors.push("Field 'content' must be a string.");
  }

  // FetchedAt must be valid ISO 8601 string
  if (typeof record.fetchedAt !== 'string' || Number.isNaN(Date.parse(record.fetchedAt))) {
    errors.push("Field 'fetchedAt' must be a valid ISO 8601 timestamp string.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Asserts that a record complies with the normalized SourceRecord contract.
 * Throws TypeError or Error if invalid.
 * 
 * @param {unknown} record
 */
export function assertValidSourceRecord(record) {
  const result = validateSourceRecord(record);
  if (!result.valid) {
    throw new Error(`Invalid SourceRecord: ${result.errors.join('; ')}`);
  }
}

