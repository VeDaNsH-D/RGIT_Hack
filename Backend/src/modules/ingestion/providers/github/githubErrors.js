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
});

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
    super(message);
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
