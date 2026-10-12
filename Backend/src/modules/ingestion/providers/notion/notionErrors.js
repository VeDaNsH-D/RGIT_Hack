/**
 * @file notionErrors.js
 * @description Error classifications for Notion API interactions, extending the common IntegrationError taxonomy.
 */

import { IntegrationError } from '../../../../integrations/common/errors.js';

export class NotionClientError extends IntegrationError {
  constructor(message, { statusCode, code, retryAfter } = {}) {
    super(message, { provider: 'notion', statusCode, code, retryAfter });
    this.name = 'NotionClientError';
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
    this.isTransient = true;
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
