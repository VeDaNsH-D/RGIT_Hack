/**
 * @file results.js
 * @description Standardized sync results and status definitions for external integrations.
 */

import { sanitizeErrorMessage } from './errors.js';

/**
 * Standard sync execution status.
 * @readonly
 * @enum {string}
 */
export const SYNC_STATUS = Object.freeze({
  SUCCESS: 'success',
  PARTIAL: 'partial',
  EMPTY: 'empty',
  FAILED: 'failed',
});

/**
 * Normalizes an error object into a sanitized summary suitable for sync results.
 *
 * @param {unknown} err
 * @param {string} [provider='unknown']
 * @returns {{ code: string, message: string, provider: string, statusCode?: number, isTransient?: boolean }}
 */
export function formatSyncErrorSummary(err, provider = 'unknown') {
  if (!err) {
    return {
      code: 'UNKNOWN_ERROR',
      message: 'Unknown error occurred.',
      provider,
    };
  }

  const rawMessage = err.message || String(err);
  const cleanMessage = sanitizeErrorMessage(rawMessage);
  const code = err.code || 'INTEGRATION_ERROR';
  const statusCode = err.statusCode || err.status;
  const isTransient = Boolean(err.isTransient);
  const errorProvider = err.provider || provider;

  return {
    code: String(code),
    message: cleanMessage,
    provider: errorProvider,
    ...(statusCode !== undefined ? { statusCode: Number(statusCode) } : {}),
    ...(isTransient ? { isTransient: true } : {}),
  };
}

/**
 * Factory function creating a standardized, immutable SyncResult object.
 * Enforces contract rules:
 * - A sync with errors and records CANNOT have status 'success'; it is coerced to 'partial'.
 * - A sync with errors and NO records CANNOT have status 'success'; it is coerced to 'failed'.
 * - A sync with NO records and NO errors defaults to status 'empty' (or 'success' if explicitly specified).
 * - Records processed count reflects the length of returned records unless overridden.
 *
 * @param {object} params
 * @param {string} params.provider - Provider identifier ('notion', 'jira', 'slack')
 * @param {string} [params.status] - One of SYNC_STATUS values
 * @param {Array<object>} [params.records=[]] - Array of normalized records or candidates
 * @param {number} [params.recordsProcessed] - Number of records processed
 * @param {Array<unknown>} [params.errors=[]] - Array of caught errors
 * @param {string|number|null} [params.cursor=null] - Continuation cursor or offset for next page
 * @param {boolean} [params.hasMore=false] - Whether more records exist beyond this batch
 * @param {object} [params.metadata={}] - Additional context (timestamps, duration, query params)
 * @param {string} [params.syncedAt] - ISO 8601 timestamp string
 * @returns {Readonly<{
 *   provider: string,
 *   status: string,
 *   records: Array<object>,
 *   recordsProcessed: number,
 *   errors: Array<object>,
 *   cursor: string|number|null,
 *   hasMore: boolean,
 *   metadata: object,
 *   syncedAt: string
 * }>}
 */
export function createSyncResult({
  provider,
  status,
  records = [],
  recordsProcessed,
  errors = [],
  cursor = null,
  hasMore = false,
  metadata = {},
  syncedAt,
} = {}) {
  if (!provider || typeof provider !== 'string') {
    throw new TypeError("Parameter 'provider' must be a non-empty string.");
  }

  const recordList = Array.isArray(records) ? records : [];
  const rawErrors = Array.isArray(errors) ? errors : (errors ? [errors] : []);
  const sanitizedErrors = rawErrors.map((e) => formatSyncErrorSummary(e, provider));

  let finalStatus = status;

  if (sanitizedErrors.length > 0) {
    if (recordList.length > 0) {
      // Must not report partial failures as complete success
      finalStatus = SYNC_STATUS.PARTIAL;
    } else {
      finalStatus = SYNC_STATUS.FAILED;
    }
  } else if (!finalStatus) {
    if (recordList.length === 0) {
      finalStatus = SYNC_STATUS.EMPTY;
    } else {
      finalStatus = SYNC_STATUS.SUCCESS;
    }
  }

  const processedCount = typeof recordsProcessed === 'number'
    ? recordsProcessed
    : recordList.length;

  const result = {
    provider: provider.toLowerCase().trim(),
    status: finalStatus,
    records: Object.freeze([...recordList]),
    recordsProcessed: processedCount,
    errors: Object.freeze(sanitizedErrors),
    cursor: cursor ?? null,
    hasMore: Boolean(hasMore),
    metadata: Object.freeze({ ...metadata }),
    syncedAt: typeof syncedAt === 'string' ? syncedAt : new Date().toISOString(),
  };

  return Object.freeze(result);
}
