/**
 * @file errors.js
 * @description Standardized error taxonomy and secret-safe sanitization for external integrations.
 */

const SECRET_PATTERNS = [
  // Bearer tokens
  /(Bearer\s+)[A-Za-z0-9_\-.~+/=]+/gi,
  // Basic auth
  /(Basic\s+)[A-Za-z0-9_\-.~+/=]+/gi,
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)
  /xox[baprs]-[A-Za-z0-9\-]+/gi,
  // Notion integration tokens (secret_ or ntn_)
  /(?:secret_|ntn_)[A-Za-z0-9_\-]+/gi,
  // Jira API tokens (ATATT...)
  /ATATT[A-Za-z0-9_\-]+/gi,
  // URL query parameter secrets (?token=..., &api_key=..., etc.)
  /([?&](?:token|key|api_key|apiKey|secret|password)=)[^&\s]+/gi,
  // Key-value pairs in logs or messages
  /((?:api_?key|token|secret|password)\s*[:=]\s*["']?)[^"',\s]+/gi,
];

/**
 * Strips credentials, tokens, and authorization headers from error messages and logs.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeErrorMessage(text) {
  if (typeof text !== 'string') {
    return String(text ?? '');
  }
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match, prefix) => {
      if (prefix) {
        return `${prefix}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return sanitized;
}

/**
 * Base domain exception for all external provider integration errors.
 */
export class IntegrationError extends Error {
  /**
   * @param {string} message - Descriptive error message (will be redacted)
   * @param {object} [options={}]
   * @param {string} [options.provider] - Provider identifier ('notion', 'jira', 'slack', etc.)
   * @param {number} [options.statusCode] - HTTP status code
   * @param {number} [options.status] - Alias for statusCode
   * @param {string} [options.code] - Machine-readable error code
   * @param {number} [options.retryAfter] - Retry-After duration in seconds
   * @param {boolean} [options.isTransient=false] - Whether error is safe for bounded retry
   * @param {any} [options.data] - Additional sanitized context
   * @param {Error} [options.cause] - Underlying source cause
   */
  constructor(message, { provider, statusCode, status, code, retryAfter, isTransient = false, data, cause } = {}) {
    const cleanMessage = sanitizeErrorMessage(message || 'An integration error occurred.');
    super(cleanMessage);
    this.name = 'IntegrationError';
    this.provider = provider || 'unknown';
    this.statusCode = statusCode || status;
    this.status = this.statusCode;
    this.code = code || 'INTEGRATION_ERROR';
    this.retryAfter = retryAfter;
    this.retryAfterSeconds = retryAfter;
    this.isTransient = Boolean(isTransient);
    this.data = data;
    if (cause) {
      this.cause = cause;
    }
  }

  /**
   * Returns a clean, safe JSON representation suitable for logging and API responses.
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      provider: this.provider,
      code: this.code,
      statusCode: this.statusCode,
      retryAfter: this.retryAfter,
      isTransient: this.isTransient,
    };
  }
}

/**
 * Authentication failures: invalid, expired, or missing credentials.
 */
export class IntegrationAuthenticationError extends IntegrationError {
  constructor(message = 'Invalid or missing integration credentials.', options = {}) {
    super(message, {
      code: 'UNAUTHORIZED',
      statusCode: 401,
      isTransient: false,
      ...options,
    });
    this.name = 'IntegrationAuthenticationError';
  }

  static [Symbol.hasInstance](instance) {
    if (!instance || typeof instance !== 'object') return false;
    return (
      instance.name === 'IntegrationAuthenticationError' ||
      instance.name === 'NotionAuthenticationError' ||
      instance.name === 'JiraAuthenticationError' ||
      instance.name === 'SlackAuthenticationError' ||
      (instance instanceof IntegrationError &&
        (instance.statusCode === 401 ||
          instance.code === 'UNAUTHORIZED' ||
          instance.code === 'unauthorized' ||
          instance.code === 'invalid_auth' ||
          instance.code === 'NOTION_API_KEY_MISSING' ||
          instance.code === 'JIRA_API_TOKEN_MISSING' ||
          instance.code === 'SLACK_TOKEN_MISSING'))
    );
  }
}

/**
 * Authorization or permission failures: insufficient scopes or inaccessible resources.
 */
export class IntegrationPermissionError extends IntegrationError {
  constructor(message = 'Insufficient permissions or resource not accessible.', options = {}) {
    super(message, {
      code: 'FORBIDDEN',
      statusCode: 403,
      isTransient: false,
      ...options,
    });
    this.name = 'IntegrationPermissionError';
  }

  static [Symbol.hasInstance](instance) {
    if (!instance || typeof instance !== 'object') return false;
    return (
      instance.name === 'IntegrationPermissionError' ||
      instance.name === 'NotionPermissionError' ||
      instance.name === 'JiraPermissionError' ||
      instance.name === 'SlackPermissionError' ||
      (instance instanceof IntegrationError &&
        (instance.statusCode === 403 ||
          instance.code === 'FORBIDDEN' ||
          instance.code === 'forbidden' ||
          instance.code === 'restricted_resource'))
    );
  }
}

/**
 * Rate limit errors: provider throttled the request.
 */
export class IntegrationRateLimitError extends IntegrationError {
  constructor(message = 'Integration rate limit exceeded.', retryAfter = 1, options = {}) {
    const resolvedRetryAfter = typeof retryAfter === 'number' ? retryAfter : (options.retryAfter || 1);
    super(message, {
      code: 'RATE_LIMITED',
      statusCode: 429,
      retryAfter: resolvedRetryAfter,
      isTransient: true,
      ...options,
    });
    this.name = 'IntegrationRateLimitError';
  }

  static [Symbol.hasInstance](instance) {
    if (!instance || typeof instance !== 'object') return false;
    return (
      instance.name === 'IntegrationRateLimitError' ||
      instance.name === 'NotionRateLimitError' ||
      instance.name === 'JiraRateLimitError' ||
      instance.name === 'SlackRateLimitError' ||
      (instance instanceof IntegrationError &&
        (instance.statusCode === 429 ||
          instance.code === 'RATE_LIMITED' ||
          instance.code === 'rate_limited' ||
          instance.code === 'ratelimited'))
    );
  }
}

/**
 * Resource not found errors: requested page, project, issue, or channel does not exist.
 */
export class IntegrationNotFoundError extends IntegrationError {
  constructor(message = 'Requested integration resource not found.', options = {}) {
    super(message, {
      code: 'NOT_FOUND',
      statusCode: 404,
      isTransient: false,
      ...options,
    });
    this.name = 'IntegrationNotFoundError';
  }

  static [Symbol.hasInstance](instance) {
    if (!instance || typeof instance !== 'object') return false;
    return (
      instance.name === 'IntegrationNotFoundError' ||
      instance.name === 'NotionNotFoundError' ||
      instance.name === 'JiraNotFoundError' ||
      instance.name === 'SlackNotFoundError' ||
      (instance instanceof IntegrationError &&
        (instance.statusCode === 404 ||
          instance.code === 'NOT_FOUND' ||
          instance.code === 'not_found'))
    );
  }
}

/**
 * Network or transient connection errors: timeouts, DNS failure, ECONNREFUSED.
 */
export class IntegrationNetworkError extends IntegrationError {
  constructor(message = 'Transient network failure connecting to provider API.', options = {}) {
    super(message, {
      code: 'NETWORK_ERROR',
      statusCode: 503,
      isTransient: true,
      ...options,
    });
    this.name = 'IntegrationNetworkError';
  }

  static [Symbol.hasInstance](instance) {
    if (!instance || typeof instance !== 'object') return false;
    return (
      instance.name === 'IntegrationNetworkError' ||
      (instance instanceof IntegrationError &&
        (instance.statusCode === 503 || instance.code === 'NETWORK_ERROR' || instance.isTransient === true))
    );
  }
}

/**
 * Malformed, invalid, or unparseable response from provider API.
 */
export class IntegrationResponseError extends IntegrationError {
  constructor(message = 'Provider returned an invalid or unparseable response.', options = {}) {
    super(message, {
      code: 'INVALID_PROVIDER_RESPONSE',
      statusCode: 502,
      isTransient: false,
      ...options,
    });
    this.name = 'IntegrationResponseError';
  }

  static [Symbol.hasInstance](instance) {
    if (!instance || typeof instance !== 'object') return false;
    return (
      instance.name === 'IntegrationResponseError' ||
      (instance instanceof IntegrationError &&
        (instance.statusCode === 502 || instance.code === 'INVALID_PROVIDER_RESPONSE'))
    );
  }
}

/**
 * Request validation errors: missing parameters, invalid format, illegal range.
 */
export class IntegrationValidationError extends IntegrationError {
  constructor(message = 'Invalid parameters provided for integration operation.', options = {}) {
    super(message, {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      isTransient: false,
      ...options,
    });
    this.name = 'IntegrationValidationError';
  }

  static [Symbol.hasInstance](instance) {
    if (!instance || typeof instance !== 'object') return false;
    return (
      instance.name === 'IntegrationValidationError' ||
      instance.name === 'NotionValidationError' ||
      instance.name === 'JiraValidationError' ||
      instance.name === 'SlackValidationError' ||
      (instance instanceof IntegrationError &&
        (instance.statusCode === 400 ||
          instance.code === 'VALIDATION_ERROR' ||
          instance.code === 'validation_error' ||
          instance.code === 'JIRA_HOST_MISSING'))
    );
  }
}

/**
 * Unsupported operation on the target provider.
 */
export class IntegrationUnsupportedError extends IntegrationError {
  constructor(message = 'Operation is not supported by this provider.', options = {}) {
    super(message, {
      code: 'UNSUPPORTED_OPERATION',
      statusCode: 501,
      isTransient: false,
      ...options,
    });
    this.name = 'IntegrationUnsupportedError';
  }
}

/**
 * Maps arbitrary provider or runtime errors into a standardized IntegrationError.
 * Ensures all tokens are redacted and error classification is uniform.
 *
 * @param {unknown} err
 * @param {string} [provider='unknown']
 * @returns {IntegrationError}
 */
export function normalizeProviderError(err, provider = 'unknown') {
  if (err instanceof IntegrationError) {
    if (!err.provider || err.provider === 'unknown') {
      err.provider = provider;
    }
    return err;
  }

  const rawMessage = err?.message || String(err || 'Unknown error');
  const cleanMessage = sanitizeErrorMessage(rawMessage);
  const status = err?.status || err?.statusCode;
  const code = err?.code;
  const retryAfter = err?.retryAfter || err?.retryAfterSeconds;

  // Rate limiting (429 or ratelimited codes)
  if (status === 429 || code === 'rate_limited' || code === 'ratelimited') {
    return new IntegrationRateLimitError(cleanMessage, retryAfter || 1, { provider, cause: err });
  }

  // Authentication (401 or auth error codes)
  if (status === 401 || code === 'unauthorized' || code === 'invalid_auth' || /unauthorized|api[_\s]?token|api[_\s]?key|invalid[_\s]?auth/i.test(cleanMessage)) {
    return new IntegrationAuthenticationError(cleanMessage, { provider, code: code || 'UNAUTHORIZED', cause: err });
  }

  // Permissions / Forbidden (403)
  if (status === 403 || code === 'forbidden' || code === 'restricted_resource' || /forbidden|permission|scope|restricted/i.test(cleanMessage)) {
    return new IntegrationPermissionError(cleanMessage, { provider, code: code || 'FORBIDDEN', cause: err });
  }

  // Not Found (404)
  if (status === 404 || code === 'not_found' || /not[_\s]?found/i.test(cleanMessage)) {
    return new IntegrationNotFoundError(cleanMessage, { provider, code: code || 'NOT_FOUND', cause: err });
  }

  // Network / Transient (fetch failed, ECONNREFUSED, ENOTFOUND, TimeoutError)
  const isNetwork =
    (err?.name === 'TypeError' && /fetch failed/i.test(rawMessage)) ||
    err?.name === 'TimeoutError' ||
    /econnrefused|enotfound|etimedout|econnreset|network/i.test(rawMessage) ||
    /timeout/i.test(cleanMessage);

  if (isNetwork) {
    return new IntegrationNetworkError(cleanMessage, { provider, cause: err });
  }

  // Response syntax / JSON parsing errors
  if (err instanceof SyntaxError || /json|unexpected token|unparseable/i.test(rawMessage)) {
    return new IntegrationResponseError(cleanMessage, { provider, cause: err });
  }

  // Validation errors (400)
  if (status === 400 || code === 'validation_error' || /validation|invalid parameter/i.test(cleanMessage)) {
    return new IntegrationValidationError(cleanMessage, { provider, code: code || 'VALIDATION_ERROR', cause: err });
  }

  return new IntegrationError(cleanMessage, {
    provider,
    statusCode: status,
    code: typeof code === 'string' ? code : 'INTEGRATION_ERROR',
    cause: err,
  });
}
