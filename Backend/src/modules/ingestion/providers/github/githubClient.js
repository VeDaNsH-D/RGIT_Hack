/**
 * @file githubClient.js
 * @description Reusable, secure HTTP transport client for the GitHub REST API.
 *
 * Implements:
 * - Native Node.js fetch transport
 * - SSRF mitigation via strict parameter validation and base-URL pinning
 * - Categorized error handling (Auth, Forbidden, Rate Limit, Not Found, Server Error)
 * - Sanitized logging/error instances (no token exposure)
 * - Reusable pagination with Link header parsing
 * - Configurable request timeouts via AbortSignal
 */

import { GITHUB_ERROR_CODES, GitHubApiError } from './githubErrors.js';

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 10000;
const GITHUB_API_VERSION = '2022-11-28';
const IDENTIFIER_REGEX = /^[a-zA-Z0-9_.-]+$/;
// GitHub limits: logins are <= 39 chars, repository names <= 100 chars.
const IDENTIFIER_MAX_LENGTH = 100;
// Hard ceiling on pages per paginate() call, regardless of caller options.
export const MAX_PAGES_LIMIT = 20;

/**
 * Validates a GitHub owner (user/org) or repository name.
 * Prevents path traversal and SSRF vectors.
 *
 * @param {string} value - The owner or repository name.
 * @param {string} fieldName - Descriptive name for error messages.
 * @returns {string} Sanitized string.
 * @throws {GitHubApiError} If value contains illegal characters or is empty.
 */
export function validateIdentifier(value, fieldName = 'identifier') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GitHubApiError(`Invalid ${fieldName}: must be a non-empty string.`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const trimmed = value.trim();
  if (trimmed.length > IDENTIFIER_MAX_LENGTH) {
    throw new GitHubApiError(`Invalid ${fieldName}: exceeds ${IDENTIFIER_MAX_LENGTH} characters.`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }
  if (!IDENTIFIER_REGEX.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new GitHubApiError(`Invalid ${fieldName} "${trimmed}": contains unsupported characters.`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  return trimmed;
}

/**
 * Parses the GitHub `Link` HTTP response header into a lookup map.
 * E.g., `<https://api.github.com/...?page=2>; rel="next"` -> { next: 'https://...' }
 *
 * @param {string|null} linkHeader - Raw Link header value.
 * @returns {Record<string, string>} Map of rel -> URL.
 */
export function parseLinkHeader(linkHeader) {
  if (!linkHeader || typeof linkHeader !== 'string') {
    return {};
  }

  const links = {};
  const parts = linkHeader.split(',');

  for (const part of parts) {
    const section = part.split(';');
    if (section.length < 2) continue;

    const urlMatch = section[0].trim().match(/^<([^>]+)>$/);
    const relMatch = section[1].trim().match(/rel=["']?([^"']+)["']?/);

    if (urlMatch && relMatch) {
      links[relMatch[1]] = urlMatch[1];
    }
  }

  return links;
}

/**
 * Reusable HTTP client for communicating with GitHub REST API.
 */
export class GitHubClient {
  // Private so the credential never appears in console.log/util.inspect/JSON output.
  #token;

  /**
   * @param {Object} [config]
   * @param {string} [config.token] - Explicit access token (e.g., installation access token or PAT).
   * @param {string} [config.baseUrl] - Base API URL (defaults to https://api.github.com).
   * @param {number} [config.timeoutMs] - Request timeout in milliseconds (defaults to 10000).
   * @param {typeof fetch} [config.fetchFn] - Custom fetch implementation (primarily for unit tests).
   */
  constructor(config = {}) {
    // When an explicit token is provided (such as an installation token), use it strictly.
    // Fall back to process.env.GITHUB_TOKEN only if config.token is not explicitly defined.
    // GitHub App flows must use createInstallationClient() (githubAppAuth.js), which always
    // passes an explicit installation token and therefore never reaches this fallback.
    this.#token = config.token !== undefined ? (config.token || null) : (process.env.GITHUB_TOKEN || null);
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchFn = config.fetchFn || globalThis.fetch;

    if (typeof this.fetchFn !== 'function') {
      throw new TypeError('A valid fetch implementation must be available.');
    }
  }

  /**
   * Builds sanitized standard headers for GitHub REST requests.
   * Authorization token is strictly scoped to this internal method.
   *
   * @private
   * @returns {Record<string, string>}
   */
  /**
   * Whether an Authorization credential is configured (never exposes the value).
   * @returns {boolean}
   */
  get isAuthenticated() {
    return typeof this.#token === 'string' && Boolean(this.#token.trim());
  }

  #buildHeaders() {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'Relay-Ingestion-Client',
    };

    if (this.isAuthenticated) {
      headers.Authorization = `Bearer ${this.#token.trim()}`;
    }

    return headers;
  }

  /**
   * Extracts rate limit telemetry from GitHub response headers.
   *
   * @private
   * @param {Headers} headers
   * @returns {Object}
   */
  #extractRateLimit(headers) {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    const used = headers.get('x-ratelimit-used');
    const retryAfter = headers.get('retry-after');

    return {
      limit: limit !== null ? parseInt(limit, 10) : null,
      remaining: remaining !== null ? parseInt(remaining, 10) : null,
      reset: reset !== null ? new Date(parseInt(reset, 10) * 1000) : null,
      used: used !== null ? parseInt(used, 10) : null,
      retryAfterSeconds: retryAfter !== null && /^\d+$/.test(retryAfter) ? parseInt(retryAfter, 10) : null,
    };
  }

  /**
   * Safely constructs an absolute URL on the configured base URL.
   * Prevents SSRF attacks by rejecting host tampering.
   *
   * @private
   * @param {string} path - Endpoint path (e.g., `/repos/owner/repo`).
   * @param {Record<string, unknown>} [params] - Optional query parameters.
   * @returns {URL}
   */
  #buildUrl(path, params = {}) {
    if (typeof path !== 'string' || !path.trim()) {
      throw new GitHubApiError('Invalid path: must be a non-empty string.', {
        code: GITHUB_ERROR_CODES.INVALID_INPUT,
      });
    }

    if (path.startsWith('//')) {
      throw new GitHubApiError(`SSRF Warning: Blocked attempt to query protocol-relative path "${path}".`, {
        code: GITHUB_ERROR_CODES.INVALID_INPUT,
      });
    }

    // If path is already a full URL (e.g. from pagination link header)
    if (path.startsWith('http://') || path.startsWith('https://')) {
      const parsed = new URL(path);
      const expectedBase = new URL(this.baseUrl);

      if (parsed.origin !== expectedBase.origin) {
        throw new GitHubApiError(`SSRF Warning: Blocked attempt to query unexpected origin "${parsed.origin}".`, {
          code: GITHUB_ERROR_CODES.INVALID_INPUT,
        });
      }
      return parsed;
    }

    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${cleanPath}`);

    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== null) {
        url.searchParams.set(key, String(val));
      }
    }

    return url;
  }

  /**
   * Executes a single HTTP GET request against the GitHub REST API.
   *
   * @param {string} endpoint - API path or pagination URL.
   * @param {Record<string, unknown>} [queryParams] - Query string parameters.
   * @returns {Promise<{ data: any, headers: Headers, rateLimit: Object, links: Record<string, string> }>}
   */
  async get(endpoint, queryParams = {}) {
    const targetUrl = this.#buildUrl(endpoint, queryParams);
    const headers = this.#buildHeaders();
    const sanitizedEndpoint = targetUrl.pathname;

    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      response = await this.fetchFn(targetUrl.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new GitHubApiError(`GitHub request timed out after ${this.timeoutMs}ms.`, {
          code: GITHUB_ERROR_CODES.TIMEOUT,
          endpoint: sanitizedEndpoint,
        });
      }

      throw new GitHubApiError(`Network error communicating with GitHub: ${err.message}`, {
        code: GITHUB_ERROR_CODES.NETWORK_ERROR,
        endpoint: sanitizedEndpoint,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const rateLimit = this.#extractRateLimit(response.headers);
    const linkHeader = response.headers.get('link');
    const links = parseLinkHeader(linkHeader);

    let parsedData = null;
    const contentType = response.headers.get('content-type') || '';

    try {
      if (contentType.includes('application/json')) {
        parsedData = await response.json();
      } else {
        parsedData = await response.text();
      }
    } catch {
      // Empty or non-parseable body
      parsedData = null;
    }

    if (!response.ok) {
      const status = response.status;
      const apiMessage = parsedData && typeof parsedData === 'object' && parsedData.message
        ? parsedData.message
        : response.statusText;

      let code = GITHUB_ERROR_CODES.HTTP_ERROR;

      if (status === 401) {
        code = GITHUB_ERROR_CODES.AUTH_FAILED;
      } else if (status === 403) {
        if (
          rateLimit.remaining === 0
          || rateLimit.retryAfterSeconds !== null
          || (typeof apiMessage === 'string' && apiMessage.toLowerCase().includes('rate limit'))
        ) {
          code = GITHUB_ERROR_CODES.RATE_LIMITED;
        } else {
          code = GITHUB_ERROR_CODES.FORBIDDEN;
        }
      } else if (status === 404) {
        code = GITHUB_ERROR_CODES.NOT_FOUND;
      } else if (status === 429) {
        code = GITHUB_ERROR_CODES.RATE_LIMITED;
      } else if (status >= 500) {
        code = GITHUB_ERROR_CODES.SERVER_ERROR;
      }

      throw new GitHubApiError(`GitHub API Error [${status}]: ${apiMessage}`, {
        code,
        status,
        endpoint: sanitizedEndpoint,
        rateLimit,
        data: parsedData,
      });
    }

    return {
      data: parsedData,
      headers: response.headers,
      rateLimit,
      links,
    };
  }

  /**
   * Fetches multiple pages of a paginated resource using GitHub's Link header and page parameters.
   *
   * @param {string} endpoint - Initial resource endpoint (e.g., `/repos/owner/repo/issues`).
   * @param {Record<string, unknown>} [params] - Initial query parameters.
   * @param {Object} [options]
   * @param {number} [options.perPage=30] - Number of items per page (max 100 per GitHub spec).
   * @param {number} [options.maxPages=5] - Safeguard limit on maximum pages fetched in a single session
   *   (clamped to MAX_PAGES_LIMIT).
   * @param {boolean} [options.requireArray=false] - Throw UNEXPECTED_RESPONSE when a page is not a JSON
   *   array instead of treating it as a single entity. List endpoints should set this.
   * @returns {Promise<{ items: any[], pagesFetched: number, rateLimit: Object, hasMore: boolean }>}
   */
  async paginate(endpoint, params = {}, options = {}) {
    const perPage = Math.min(Math.max(Number(options.perPage) || 30, 1), 100);
    const maxPages = Math.min(Math.max(Number(options.maxPages) || 5, 1), MAX_PAGES_LIMIT);

    const initialParams = {
      ...params,
      per_page: perPage,
    };

    const allItems = [];
    let currentEndpoint = endpoint;
    let currentParams = initialParams;
    let pagesFetched = 0;
    let lastRateLimit = null;
    let hasMore = false;

    while (pagesFetched < maxPages) {
      const response = await this.get(currentEndpoint, currentParams);
      pagesFetched += 1;
      lastRateLimit = response.rateLimit;

      if (Array.isArray(response.data)) {
        allItems.push(...response.data);
      } else if (options.requireArray) {
        throw new GitHubApiError('GitHub returned an unexpected response format (expected a JSON array).', {
          code: GITHUB_ERROR_CODES.UNEXPECTED_RESPONSE,
          endpoint: new URL(currentEndpoint, this.baseUrl).pathname,
          rateLimit: response.rateLimit,
        });
      } else {
        // If not an array, treat single response as single entity and terminate
        allItems.push(response.data);
        break;
      }

      if (response.links && response.links.next) {
        currentEndpoint = response.links.next;
        currentParams = {}; // Query params are already encoded in link header
        hasMore = true;
      } else {
        hasMore = false;
        break;
      }
    }

    return {
      items: allItems,
      pagesFetched,
      rateLimit: lastRateLimit,
      hasMore,
    };
  }
}
