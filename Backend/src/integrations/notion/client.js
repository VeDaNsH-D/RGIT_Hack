/**
 * Official Notion REST API Client
 * 
 * Provides an authenticated HTTP interface for querying Notion pages,
 * block trees, databases, and workspace search with transient retry support.
 */

import { withRetry } from '../../notifications/reliability/retry.js';

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

const DEFAULT_BASE_URL = 'https://api.notion.com/v1';
const DEFAULT_NOTION_VERSION = '2022-06-28';

export class NotionClient {
  /**
   * @param {object} config
   * @param {string} [config.apiKey] Notion integration secret (falls back to process.env.NOTION_API_KEY)
   * @param {string} [config.baseUrl] Base Notion API endpoint
   * @param {string} [config.notionVersion] Notion API version header
   * @param {typeof fetch} [config.fetchFn] Custom fetch implementation for testing
   * @param {object} [config.retryOptions] Retry options for transient errors
   */
  constructor({
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    notionVersion = DEFAULT_NOTION_VERSION,
    fetchFn = globalThis.fetch,
    retryOptions = {},
  } = {}) {
    this.apiKey = apiKey !== undefined ? apiKey : (process.env.NOTION_API_KEY || process.env.NOTION_TOKEN);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.notionVersion = notionVersion;
    this.fetchFn = fetchFn;
    this.retryOptions = retryOptions;
  }

  /**
   * Validates presence of credentials before making API requests.
   * @private
   */
  _ensureAuth() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || !this.apiKey.trim()) {
      throw new NotionAuthenticationError(
        'NOTION_API_KEY is required. Please provide it in options or set NOTION_API_KEY in environment.',
        { code: 'NOTION_API_KEY_MISSING' }
      );
    }
  }

  /**
   * Executes an authenticated HTTP request against Notion API with error mapping.
   * @private
   */
  async _request(path, { method = 'GET', body, query } = {}) {
    this._ensureAuth();

    let url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (query) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) {
          searchParams.append(k, String(v));
        }
      }
      const qs = searchParams.toString();
      if (qs) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey.trim()}`,
      'Notion-Version': this.notionVersion,
      'Content-Type': 'application/json',
    };

    const makeCall = async () => {
      let res;
      try {
        res = await this.fetchFn(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (networkErr) {
        // Classify network errors as transient
        networkErr.isTransient = true;
        throw networkErr;
      }

      if (!res.ok) {
        let errJson = null;
        let rawBody = '';
        try {
          rawBody = await res.text();
          errJson = JSON.parse(rawBody);
        } catch {
          // If response isn't JSON
        }

        const statusCode = res.status;
        const code = errJson?.code || `HTTP_${statusCode}`;
        const message = errJson?.message || (rawBody ? `Notion API returned HTTP ${statusCode}: ${rawBody}` : `Notion API request failed with status ${statusCode}`);

        if (statusCode === 401) {
          throw new NotionAuthenticationError(message, { code, statusCode });
        }

        if (statusCode === 403 || statusCode === 404) {
          // 404 in Notion API commonly indicates resource exists but integration was not invited/shared
          throw new NotionPermissionError(message, { statusCode, code });
        }

        if (statusCode === 429) {
          const retryAfterHeader = res.headers?.get?.('Retry-After');
          const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 1;
          const rateLimitErr = new NotionRateLimitError(message, retryAfter);
          rateLimitErr.isTransient = true;
          throw rateLimitErr;
        }

        const apiErr = new NotionClientError(message, { statusCode, code });
        if (statusCode >= 500) {
          apiErr.isTransient = true;
        }
        throw apiErr;
      }

      return res.json();
    };

    try {
      return await withRetry(makeCall, this.retryOptions);
    } catch (err) {
      if (err?.name === 'RetryExhaustedError' && err?.lastError) {
        throw err.lastError;
      }
      throw err;
    }
  }

  /**
   * Retrieves page metadata by page ID.
   * 
   * @param {string} pageId
   * @returns {Promise<object>} Notion page object
   */
  async getPage(pageId) {
    if (!pageId || typeof pageId !== 'string') {
      throw new TypeError("Parameter 'pageId' must be a non-empty string.");
    }
    return this._request(`/pages/${pageId.trim()}`);
  }

  /**
   * Retrieves children blocks for a specified block or page ID.
   * 
   * @param {string} blockId
   * @param {object} [options={}]
   * @param {string} [options.startCursor] Pagination cursor
   * @param {number} [options.pageSize=100] Results per page (max 100)
   * @returns {Promise<{ results: object[], has_more: boolean, next_cursor: string | null }>}
   */
  async getBlockChildren(blockId, { startCursor, pageSize = 100 } = {}) {
    if (!blockId || typeof blockId !== 'string') {
      throw new TypeError("Parameter 'blockId' must be a non-empty string.");
    }

    const query = { page_size: pageSize };
    if (startCursor) {
      query.start_cursor = startCursor;
    }

    return this._request(`/blocks/${blockId.trim()}/children`, { query });
  }

  /**
   * Queries a Notion database for pages/records with filtering, sorting, and pagination.
   * 
   * @param {string} databaseId
   * @param {object} [options={}]
   * @param {string} [options.startCursor]
   * @param {number} [options.pageSize=100]
   * @param {object} [options.filter]
   * @param {object[]} [options.sorts]
   * @returns {Promise<{ results: object[], has_more: boolean, next_cursor: string | null }>}
   */
  async queryDatabase(databaseId, { startCursor, pageSize = 100, filter, sorts } = {}) {
    if (!databaseId || typeof databaseId !== 'string') {
      throw new TypeError("Parameter 'databaseId' must be a non-empty string.");
    }

    const body = { page_size: pageSize };
    if (startCursor) body.start_cursor = startCursor;
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;

    return this._request(`/databases/${databaseId.trim()}/query`, {
      method: 'POST',
      body,
    });
  }

  /**
   * Searches pages and databases shared with the integration.
   * 
   * @param {object} [options={}]
   * @param {string} [options.query] Search text query
   * @param {object} [options.filter] Filter by object type ({ value: 'page' | 'database', property: 'object' })
   * @param {string} [options.startCursor]
   * @param {number} [options.pageSize=100]
   * @returns {Promise<{ results: object[], has_more: boolean, next_cursor: string | null }>}
   */
  async search({ query, filter, startCursor, pageSize = 100 } = {}) {
    const body = { page_size: pageSize };
    if (query) body.query = query;
    if (filter) body.filter = filter;
    if (startCursor) body.start_cursor = startCursor;

    return this._request('/search', {
      method: 'POST',
      body,
    });
  }
}
