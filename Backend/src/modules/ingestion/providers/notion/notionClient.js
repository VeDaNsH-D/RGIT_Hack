/**
 * @file notionClient.js
 * @description Official Notion REST API client with bounded retry handling and rate limiting.
 */

import { withRetry } from '../../../../notifications/reliability/retry.js';
import {
  NotionClientError,
  NotionAuthenticationError,
  NotionPermissionError,
  NotionRateLimitError,
} from './notionErrors.js';

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

  async getPage(pageId) {
    if (!pageId || typeof pageId !== 'string') {
      throw new TypeError("Parameter 'pageId' must be a non-empty string.");
    }
    return this._request(`/pages/${pageId.trim()}`);
  }

  async getBlockChildren(blockId, { startCursor, pageSize = 100 } = {}) {
    if (!blockId || typeof blockId !== 'string') {
      throw new TypeError("Parameter 'blockId' must be a non-empty string.");
    }
    const query = { page_size: Math.min(100, Math.max(1, pageSize)) };
    if (startCursor) query.start_cursor = startCursor;
    return this._request(`/blocks/${blockId.trim()}/children`, { query });
  }

  async queryDatabase(databaseId, { startCursor, pageSize = 100, filter, sorts } = {}) {
    if (!databaseId || typeof databaseId !== 'string') {
      throw new TypeError("Parameter 'databaseId' must be a non-empty string.");
    }
    const body = { page_size: Math.min(100, Math.max(1, pageSize)) };
    if (startCursor) body.start_cursor = startCursor;
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    return this._request(`/databases/${databaseId.trim()}/query`, {
      method: 'POST',
      body,
    });
  }

  async search({ query, filter, sort, startCursor, pageSize = 100 } = {}) {
    const body = { page_size: Math.min(100, Math.max(1, pageSize)) };
    if (query) body.query = query;
    if (filter) body.filter = filter;
    if (sort) body.sort = sort;
    if (startCursor) body.start_cursor = startCursor;
    return this._request('/search', {
      method: 'POST',
      body,
    });
  }
}
