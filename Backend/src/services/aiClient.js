/**
 * @file aiClient.js
 * @description HTTP client for communicating with Member 3's AI Context Intelligence service.
 *
 * Implements:
 * - Native Node.js fetch transport
 * - Configurable base URL via AI_SERVICE_URL (default: http://127.0.0.1:8001)
 * - 35-second default timeout via AbortController
 * - Categorized error handling (timeouts, connection failures, HTTP errors, malformed responses)
 * - Secret and credential sanitization (never leaking tokens or API keys)
 * - Separation from Express and MongoDB layers
 */

export const AI_CLIENT_ERROR_CODES = Object.freeze({
  INVALID_PAYLOAD: 'AI_SERVICE_INVALID_PAYLOAD',
  TIMEOUT: 'AI_SERVICE_TIMEOUT',
  CONNECTION_ERROR: 'AI_SERVICE_CONNECTION_ERROR',
  HTTP_ERROR: 'AI_SERVICE_HTTP_ERROR',
  MALFORMED_RESPONSE: 'AI_SERVICE_MALFORMED_RESPONSE',
});

const DEFAULT_BASE_URL = 'http://127.0.0.1:8001';
const DEFAULT_TIMEOUT_MS = 35000;

/**
 * Custom error class for AI Context Intelligence client interactions.
 */
export class AiServiceError extends Error {
  /**
   * @param {string} message - User-safe error description.
   * @param {object} [options]
   * @param {string} [options.code] - Error code from AI_CLIENT_ERROR_CODES.
   * @param {number} [options.status] - Associated HTTP status code.
   * @param {string} [options.endpoint] - Target endpoint.
   * @param {unknown} [options.cause] - Original underlying error.
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'AiServiceError';
    this.code = options.code || AI_CLIENT_ERROR_CODES.HTTP_ERROR;
    this.status = options.status || 502;
    this.endpoint = options.endpoint;
    this.cause = options.cause;
  }
}

/**
 * Redacts potential API keys, auth tokens, and sensitive headers from error messages.
 *
 * @param {string} text
 * @returns {string} Sanitized string.
 */
export function sanitizeMessage(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/gsk_[a-zA-Z0-9_-]+/gi, '[REDACTED_API_KEY]')
    .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED_TOKEN]');
}

/**
 * Validates the raw JSON response returned by the AI service.
 *
 * @param {unknown} data
 * @returns {boolean} True if response satisfies basic contract requirements.
 */
function isValidContextIntelligenceResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  // Must contain case_id and summary
  if (typeof data.case_id !== 'string' || !data.case_id.trim()) {
    return false;
  }
  if (typeof data.summary !== 'string' || !data.summary.trim()) {
    return false;
  }
  return true;
}

/**
 * Client class managing HTTP transport to the AI Context Intelligence service.
 */
export class AiServiceClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] - Base URL of the AI service.
   * @param {number} [options.timeoutMs] - Request timeout in milliseconds.
   * @param {typeof fetch} [options.fetchFn] - Custom fetch implementation for testing.
   */
  constructor(options = {}) {
    const rawBaseUrl = options.baseUrl || process.env.AI_SERVICE_URL || DEFAULT_BASE_URL;
    this.baseUrl = rawBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  /**
   * Dispatches a context pack payload to the AI service to generate context intelligence.
   *
   * @param {object} payload - ContextPackRequest payload.
   * @param {object} [callOptions] - Per-call overrides.
   * @param {number} [callOptions.timeoutMs]
   * @returns {Promise<object>} Parsed and validated ContextIntelligenceResponse.
   * @throws {AiServiceError} On invalid payload, timeout, connection failure, non-2xx response, or invalid JSON.
   */
  async generateContextPack(payload, callOptions = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AiServiceError('Context pack payload must be a non-null object.', {
        code: AI_CLIENT_ERROR_CODES.INVALID_PAYLOAD,
        status: 400,
      });
    }

    const endpoint = `${this.baseUrl}/api/v1/context-packs/generate`;
    const timeout = callOptions.timeoutMs || this.timeoutMs;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new AiServiceError(`AI Context Intelligence service timed out after ${timeout}ms.`, {
          code: AI_CLIENT_ERROR_CODES.TIMEOUT,
          status: 504,
          endpoint,
          cause: err,
        });
      }

      const safeMessage = sanitizeMessage(err.message || 'Unknown network error');
      throw new AiServiceError(`Failed to connect to AI Context Intelligence service: ${safeMessage}`, {
        code: AI_CLIENT_ERROR_CODES.CONNECTION_ERROR,
        status: 502,
        endpoint,
        cause: err,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    let parsedBody;
    const contentType = response.headers.get('content-type') || '';

    try {
      if (contentType.includes('application/json')) {
        parsedBody = await response.json();
      } else {
        const text = await response.text();
        parsedBody = text ? JSON.parse(text) : null;
      }
    } catch {
      parsedBody = null;
    }

    if (!response.ok) {
      const status = response.status;
      let rawDetail = '';

      if (parsedBody && typeof parsedBody === 'object') {
        rawDetail = parsedBody.detail || parsedBody.message || '';
      } else if (typeof parsedBody === 'string') {
        rawDetail = parsedBody;
      }

      const safeDetail = sanitizeMessage(rawDetail || response.statusText || `HTTP ${status}`);
      throw new AiServiceError(`AI service rejected request (${status}): ${safeDetail}`, {
        code: AI_CLIENT_ERROR_CODES.HTTP_ERROR,
        status: status >= 400 && status < 600 ? status : 502,
        endpoint,
      });
    }

    if (!isValidContextIntelligenceResponse(parsedBody)) {
      throw new AiServiceError('AI service returned a malformed response missing required fields.', {
        code: AI_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
        status: 502,
        endpoint,
      });
    }

    return parsedBody;
  }

  /**
   * Dispatches a context pack payload to the AI service to generate a structured project brief.
   *
   * @param {object} payload - ContextPackRequest payload.
   * @param {object} [callOptions]
   * @returns {Promise<object>} ProjectBriefResponse from AI service.
   */
  async generateProjectBrief(payload, callOptions = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AiServiceError('Context pack payload must be a non-null object.', {
        code: AI_CLIENT_ERROR_CODES.INVALID_PAYLOAD,
        status: 400,
      });
    }

    const endpoint = `${this.baseUrl}/api/v1/project-brief/generate`;
    const timeout = callOptions.timeoutMs || this.timeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new AiServiceError(`AI service timed out after ${timeout}ms.`, {
          code: AI_CLIENT_ERROR_CODES.TIMEOUT,
          status: 504,
          endpoint,
          cause: err,
        });
      }
      const safeMessage = sanitizeMessage(err.message || 'Unknown network error');
      throw new AiServiceError(`Failed to connect to AI service: ${safeMessage}`, {
        code: AI_CLIENT_ERROR_CODES.CONNECTION_ERROR,
        status: 502,
        endpoint,
        cause: err,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    let parsedBody;
    try {
      parsedBody = await response.json();
    } catch {
      parsedBody = null;
    }

    if (!response.ok) {
      const status = response.status;
      const safeDetail = sanitizeMessage(parsedBody?.detail || response.statusText || `HTTP ${status}`);
      throw new AiServiceError(`AI service rejected request (${status}): ${safeDetail}`, {
        code: AI_CLIENT_ERROR_CODES.HTTP_ERROR,
        status: status >= 400 && status < 600 ? status : 502,
        endpoint,
      });
    }

    if (!parsedBody || typeof parsedBody !== 'object') {
      throw new AiServiceError('AI service returned an invalid project brief format.', {
        code: AI_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
        status: 502,
        endpoint,
      });
    }

    return parsedBody;
  }

  /**
   * Dispatches a context pack payload to the AI service to run conflict detection.
   *
   * @param {object} payload - ContextPackRequest payload.
   * @param {object} [callOptions]
   * @returns {Promise<object>} ConflictDetectionResponse from AI service.
   */
  async detectConflicts(payload, callOptions = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AiServiceError('Context pack payload must be a non-null object.', {
        code: AI_CLIENT_ERROR_CODES.INVALID_PAYLOAD,
        status: 400,
      });
    }

    const endpoint = `${this.baseUrl}/api/v1/conflicts/detect`;
    const timeout = callOptions.timeoutMs || this.timeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new AiServiceError(`AI service timed out after ${timeout}ms.`, {
          code: AI_CLIENT_ERROR_CODES.TIMEOUT,
          status: 504,
          endpoint,
          cause: err,
        });
      }
      const safeMessage = sanitizeMessage(err.message || 'Unknown network error');
      throw new AiServiceError(`Failed to connect to AI service: ${safeMessage}`, {
        code: AI_CLIENT_ERROR_CODES.CONNECTION_ERROR,
        status: 502,
        endpoint,
        cause: err,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    let parsedBody;
    try {
      parsedBody = await response.json();
    } catch {
      parsedBody = null;
    }

    if (!response.ok) {
      const status = response.status;
      const safeDetail = sanitizeMessage(parsedBody?.detail || response.statusText || `HTTP ${status}`);
      throw new AiServiceError(`AI service rejected request (${status}): ${safeDetail}`, {
        code: AI_CLIENT_ERROR_CODES.HTTP_ERROR,
        status: status >= 400 && status < 600 ? status : 502,
        endpoint,
      });
    }

    return parsedBody;
  }
}

/**
 * Convenience helper to send a context pack using the default client configuration.
 *
 * @param {object} payload - ContextPackRequest payload.
 * @param {object} [options] - Client options (baseUrl, timeoutMs, fetchFn).
 * @returns {Promise<object>} ContextIntelligenceResponse from the AI service.
 */
export async function generateContextPack(payload, options = {}) {
  const client = new AiServiceClient(options);
  return client.generateContextPack(payload, options);
}

/**
 * Convenience helper to generate a project brief using the default client configuration.
 *
 * @param {object} payload - ContextPackRequest payload.
 * @param {object} [options] - Client options (baseUrl, timeoutMs, fetchFn).
 * @returns {Promise<object>} ProjectBriefResponse from the AI service.
 */
export async function generateProjectBrief(payload, options = {}) {
  const client = new AiServiceClient(options);
  return client.generateProjectBrief(payload, options);
}

/**
 * Convenience helper to run microservice conflict detection using the default client configuration.
 *
 * @param {object} payload - ContextPackRequest payload.
 * @param {object} [options] - Client options (baseUrl, timeoutMs, fetchFn).
 * @returns {Promise<object>} ConflictDetectionResponse from the AI service.
 */
export async function detectAiConflicts(payload, options = {}) {
  const client = new AiServiceClient(options);
  return client.detectConflicts(payload, options);
}
