/**
 * @file jiraErrors.js
 * @description Error classifications and domain exceptions for Jira REST API interactions.
 */

export class JiraClientError extends Error {
  constructor(message, { statusCode, status, code, retryAfter, data } = {}) {
    super(message);
    this.name = 'JiraClientError';
    this.statusCode = statusCode || status;
    this.status = this.statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
    this.retryAfterSeconds = retryAfter;
    this.data = data;
  }
}

export const JiraError = JiraClientError;

export class JiraAuthenticationError extends JiraClientError {
  constructor(message = 'Invalid or missing Jira credentials.', { code = 'unauthorized', statusCode = 401 } = {}) {
    super(message, { statusCode, code });
    this.name = 'JiraAuthenticationError';
  }
}

export class JiraPermissionError extends JiraClientError {
  constructor(message = 'Insufficient permissions to access the requested Jira resource.', { statusCode = 403, code = 'forbidden' } = {}) {
    super(message, { statusCode, code });
    this.name = 'JiraPermissionError';
  }
}

export class JiraRateLimitError extends JiraClientError {
  constructor(message = 'Jira API rate limit exceeded.', retryAfter = 1) {
    super(message, { statusCode: 429, code: 'rate_limited', retryAfter });
    this.name = 'JiraRateLimitError';
    this.isTransient = true;
  }
}

export class JiraNotFoundError extends JiraClientError {
  constructor(message = 'Jira resource not found.', { statusCode = 404, code = 'not_found' } = {}) {
    super(message, { statusCode, code });
    this.name = 'JiraNotFoundError';
  }
}

export class JiraValidationError extends JiraClientError {
  constructor(message = 'Invalid parameters provided to Jira API.', { statusCode = 400, code = 'validation_error', data } = {}) {
    super(message, { statusCode, code, data });
    this.name = 'JiraValidationError';
  }
}
