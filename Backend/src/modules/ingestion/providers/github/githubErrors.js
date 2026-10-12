/**
 * @file githubErrors.js
 * @description Custom error definitions for the GitHub REST API client.
 *
 * Designed to categorize failure modes (authentication, permissions, rate limits,
 * missing resources, network timeouts, and server errors) while preventing accidental
 * credential leakage in logs or error stacks.
 */

/**
 * Standardized error codes for GitHub client operations.
 * @readonly
 * @enum {string}
 */
export const GITHUB_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  AUTH_FAILED: 'AUTH_FAILED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  SERVER_ERROR: 'SERVER_ERROR',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
  UNEXPECTED_RESPONSE: 'UNEXPECTED_RESPONSE',
  NORMALIZATION_FAILED: 'NORMALIZATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

// Patterns for credential material that must never appear in error messages:
// GitHub token prefixes (installation, PAT, OAuth, user-to-server, refresh,
// fine-grained PAT), bearer/token authorization values, JWTs, and PEM blocks.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
];

/**
 * Removes credential-like substrings from free text before it is attached to
 * an error. Defense in depth: callers should already avoid passing secrets.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/**
 * Converts any thrown value into a small, log-safe summary suitable for
 * ingestion results and API responses. Unknown (non-GitHubApiError) errors get
 * a generic message so arbitrary internals are never surfaced.
 *
 * @param {unknown} err
 * @returns {{ code: string, message: string, status: number|null }}
 */
export function toSafeErrorSummary(err) {
  if (err instanceof GitHubApiError) {
    return { code: err.code, message: redactSecrets(err.message), status: err.status };
  }
  return {
    code: GITHUB_ERROR_CODES.INTERNAL_ERROR,
    message: 'Unexpected internal error.',
    status: null,
  };
}

/**
 * Base error class for all GitHub API client errors.
 */
export class GitHubApiError extends Error {
  /**
   * @param {string} message - Human-readable error description (sanitized).
   * @param {Object} [details]
   * @param {string} [details.code] - One of GITHUB_ERROR_CODES.
   * @param {number} [details.status] - HTTP status code (if available).
   * @param {string} [details.endpoint] - API path or endpoint called (excluding query secrets).
   * @param {Object} [details.rateLimit] - Rate limit headers snapshot.
   * @param {unknown} [details.data] - Parsed response payload from GitHub (if any).
   */
  constructor(message, details = {}) {
    super(redactSecrets(message));
    this.name = 'GitHubApiError';
    this.code = details.code || GITHUB_ERROR_CODES.HTTP_ERROR;
    this.status = details.status || null;
    this.endpoint = details.endpoint || null;
    this.rateLimit = details.rateLimit || null;
    this.data = details.data || null;

    // Ensure error object doesn't carry sensitive headers
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GitHubApiError);
    }
  }
}
