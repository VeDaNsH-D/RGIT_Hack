/**
 * @file notionErrors.js
 * @description Error classifications for Notion API interactions.
 */

export class NotionClientError extends Error {
  constructor(message, { statusCode, code, retryAfter } = {}) {
    super(message);
    this.name = 'NotionClientError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
    this.retryAfterSeconds = retryAfter;
  }
}

export const NotionError = NotionClientError;

export class NotionAuthenticationError extends NotionClientError {
  constructor(message = 'Invalid or missing Notion API token.', { code = 'unauthorized', statusCode = 401 } = {}) {
    super(message, { statusCode, code });
    this.name = 'NotionAuthenticationError';
  }
}

export class NotionPermissionError extends NotionClientError {
  constructor(message = 'Insufficient permissions or resource not shared with the integration.', { statusCode = 403, code = 'restricted_resource' } = {}) {
    super(message, { statusCode, code });
    this.name = 'NotionPermissionError';
  }
}

export class NotionRateLimitError extends NotionClientError {
  constructor(message = 'Notion API rate limit exceeded.', retryAfter = 1) {
    super(message, { statusCode: 429, code: 'rate_limited', retryAfter });
    this.name = 'NotionRateLimitError';
  }
}

export class NotionNotFoundError extends NotionClientError {
  constructor(message = 'Notion resource not found.') {
    super(message, { statusCode: 404, code: 'not_found' });
    this.name = 'NotionNotFoundError';
  }
}

export class NotionValidationError extends NotionClientError {
  constructor(message = 'Invalid parameters provided to Notion API.') {
    super(message, { statusCode: 400, code: 'validation_error' });
    this.name = 'NotionValidationError';
  }
}
