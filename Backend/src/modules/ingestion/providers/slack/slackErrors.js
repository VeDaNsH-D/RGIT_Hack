/**
 * @file slackErrors.js
 * @description Error classifications and domain exceptions for Slack Web API interactions.
 */

export class SlackClientError extends Error {
  constructor(message, { statusCode, status, code, retryAfter, data } = {}) {
    super(message);
    this.name = 'SlackClientError';
    this.statusCode = statusCode || status;
    this.status = this.statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
    this.retryAfterSeconds = retryAfter;
    this.data = data;
  }
}

export const SlackError = SlackClientError;

export class SlackAuthenticationError extends SlackClientError {
  constructor(message = 'Invalid, missing, or revoked Slack API token.', { code = 'invalid_auth', statusCode = 401 } = {}) {
    super(message, { statusCode, code });
    this.name = 'SlackAuthenticationError';
  }
}

export class SlackPermissionError extends SlackClientError {
  constructor(message = 'Insufficient scopes or not a member of the requested Slack channel.', { statusCode = 403, code = 'forbidden' } = {}) {
    super(message, { statusCode, code });
    this.name = 'SlackPermissionError';
  }
}

export class SlackRateLimitError extends SlackClientError {
  constructor(message = 'Slack API rate limit exceeded.', retryAfter = 1) {
    super(message, { statusCode: 429, code: 'ratelimited', retryAfter });
    this.name = 'SlackRateLimitError';
    this.isTransient = true;
  }
}

export class SlackNotFoundError extends SlackClientError {
  constructor(message = 'Slack resource (channel or thread) not found.', { statusCode = 404, code = 'not_found' } = {}) {
    super(message, { statusCode, code });
    this.name = 'SlackNotFoundError';
  }
}

export class SlackValidationError extends SlackClientError {
  constructor(message = 'Invalid parameters provided to Slack API.', { statusCode = 400, code = 'validation_error', data } = {}) {
    super(message, { statusCode, code, data });
    this.name = 'SlackValidationError';
  }
}
