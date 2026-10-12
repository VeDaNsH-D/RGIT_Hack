/**
 * @file slackClient.js
 * @description Authenticated HTTP transport client for the official Slack Web API.
 *
 * Implements:
 * - Native fetch transport with zero external SDK dependencies
 * - Secure Bearer authentication with SLACK_BOT_TOKEN
 * - Error classification (401 Auth, 403 Scopes/Membership, 404 Not Found, 429 Rate Limit)
 * - Safe sanitization: Never logs or leaks authorization headers or tokens
 * - Bounded exponential backoff retries with Retry-After header parsing via withRetry
 * - Cursor-based pagination (response_metadata.next_cursor)
 */

import { withRetry } from '../../../../notifications/reliability/retry.js';
import {
  SlackClientError,
  SlackAuthenticationError,
  SlackPermissionError,
  SlackRateLimitError,
  SlackNotFoundError,
  SlackValidationError,
} from './slackErrors.js';

const DEFAULT_BASE_URL = 'https://slack.com/api';
const DEFAULT_TIMEOUT_MS = 15000;

export class SlackClient {
  /**
   * @param {object} [config={}]
   * @param {string} [config.token] Slack API token (defaults to SLACK_BOT_TOKEN or SLACK_TOKEN)
   * @param {string} [config.baseUrl=DEFAULT_BASE_URL] Base Slack Web API endpoint
   * @param {typeof fetch} [config.fetchFn=globalThis.fetch] Injected fetch implementation
   * @param {object} [config.retryOptions] Retry options for withRetry
   */
  constructor({
    token,
    baseUrl = DEFAULT_BASE_URL,
    fetchFn = globalThis.fetch,
    retryOptions = {},
  } = {}) {
    this.token = token !== undefined ? token : (process.env.SLACK_BOT_TOKEN || process.env.SLACK_TOKEN || '');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchFn = fetchFn;
    this.retryOptions = retryOptions;
  }

  /**
   * Validates presence of credentials before executing requests.
   * @private
   */
  _ensureAuth() {
    if (!this.token || typeof this.token !== 'string' || !this.token.trim()) {
      throw new SlackAuthenticationError(
        'SLACK_BOT_TOKEN is required. Please provide it in options or set SLACK_BOT_TOKEN in environment.',
        { code: 'SLACK_TOKEN_MISSING' }
      );
    }
  }

  /**
   * Executes an authenticated HTTP request against the Slack Web API.
   * 
   * @param {string} methodPath - Slack API method name (e.g. 'conversations.history')
   * @param {object} [options={}]
   * @param {'GET'|'POST'} [options.method='GET']
   * @param {Record<string, unknown>} [options.query]
   * @param {Record<string, unknown>} [options.body]
   * @returns {Promise<any>}
   */
  async _request(methodPath, { method = 'GET', query, body } = {}) {
    this._ensureAuth();

    const cleanPath = methodPath.startsWith('/') ? methodPath.slice(1) : methodPath;
    let url = `${this.baseUrl}/${cleanPath}`;

    if (query && typeof query === 'object') {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') {
          searchParams.append(k, String(v));
        }
      }
      const qs = searchParams.toString();
      if (qs) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
    }

    const headers = {
      Authorization: `Bearer ${this.token.trim()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
    };

    const makeCall = async () => {
      let res;
      try {
        res = await this.fetchFn(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
      } catch (networkErr) {
        networkErr.isTransient = true;
        throw networkErr;
      }

      const statusCode = res.status;

      // Handle HTTP-level rate limiting (429)
      if (statusCode === 429) {
        const retryAfterHeader = res.headers?.get?.('Retry-After');
        const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 1;
        const rateErr = new SlackRateLimitError('Slack API rate limit exceeded.', retryAfter);
        rateErr.isTransient = true;
        throw rateErr;
      }

      if (!res.ok) {
        let rawBody = '';
        try {
          rawBody = await res.text();
        } catch {
          // ignore
        }
        const apiErr = new SlackClientError(
          rawBody ? `Slack API HTTP error ${statusCode}: ${rawBody}` : `Slack API HTTP request failed with status ${statusCode}`,
          { statusCode, code: `HTTP_${statusCode}` }
        );
        if (statusCode >= 500) {
          apiErr.isTransient = true;
        }
        throw apiErr;
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw new SlackClientError(`Invalid non-JSON response returned by Slack API for ${cleanPath}`, {
          statusCode: 502,
          code: 'MALFORMED_RESPONSE',
        });
      }

      // Handle Slack payload-level errors: { ok: false, error: '...' }
      if (data && data.ok === false) {
        const slackError = data.error || 'unknown_error';
        const needed = data.needed ? ` (Missing scope: ${data.needed})` : '';
        const message = `Slack API error [${slackError}] on ${cleanPath}${needed}`;

        if (['not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'token_expired'].includes(slackError)) {
          throw new SlackAuthenticationError(message, { code: slackError, statusCode: 401 });
        }

        if (['missing_scope', 'not_in_channel', 'access_denied', 'restricted_action'].includes(slackError)) {
          throw new SlackPermissionError(message, { code: slackError, statusCode: 403 });
        }

        if (['channel_not_found', 'thread_not_found'].includes(slackError)) {
          throw new SlackNotFoundError(message, { code: slackError, statusCode: 404 });
        }

        if (slackError === 'ratelimited') {
          const retryAfterHeader = res.headers?.get?.('Retry-After');
          const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 1;
          const rateErr = new SlackRateLimitError(message, retryAfter);
          rateErr.isTransient = true;
          throw rateErr;
        }

        if (['invalid_arguments', 'invalid_cursor', 'invalid_limit'].includes(slackError)) {
          throw new SlackValidationError(message, { code: slackError, statusCode: 400, data });
        }

        throw new SlackClientError(message, { code: slackError, statusCode: 400, data });
      }

      return data;
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
   * Tests authentication and discovers workspace identity.
   * 
   * @returns {Promise<{ ok: boolean, url: string, team: string, team_id: string, user: string, user_id: string }>}
   */
  async testAuth() {
    return this._request('auth.test', { method: 'POST' });
  }

  /**
   * Lists public and private channels the bot is authorized to access.
   * 
   * @param {object} [options={}]
   * @param {string} [options.types='public_channel,private_channel']
   * @param {string} [options.cursor]
   * @param {number} [options.limit=100]
   * @returns {Promise<{ ok: boolean, channels: Array<object>, response_metadata?: { next_cursor?: string } }>}
   */
  async getChannels({ types = 'public_channel,private_channel', cursor, limit = 100 } = {}) {
    return this._request('conversations.list', {
      method: 'GET',
      query: { types, cursor, limit },
    });
  }

  /**
   * Retrieves metadata for a specific channel.
   * 
   * @param {string} channelId
   * @returns {Promise<{ ok: boolean, channel: object }>}
   */
  async getChannelInfo(channelId) {
    if (!channelId || typeof channelId !== 'string') {
      throw new TypeError("Parameter 'channelId' must be a non-empty string.");
    }
    return this._request('conversations.info', {
      method: 'GET',
      query: { channel: channelId.trim() },
    });
  }

  /**
   * Retrieves message history from a channel.
   * 
   * @param {string} channelId
   * @param {object} [options={}]
   * @param {string} [options.cursor]
   * @param {number} [options.limit=100]
   * @param {string} [options.latest]
   * @param {string} [options.oldest]
   * @param {boolean} [options.inclusive=true]
   * @returns {Promise<{ ok: boolean, messages: Array<object>, has_more: boolean, response_metadata?: { next_cursor?: string } }>}
   */
  async getConversationHistory(channelId, { cursor, limit = 100, latest, oldest, inclusive = true } = {}) {
    if (!channelId || typeof channelId !== 'string') {
      throw new TypeError("Parameter 'channelId' must be a non-empty string.");
    }
    return this._request('conversations.history', {
      method: 'GET',
      query: {
        channel: channelId.trim(),
        cursor,
        limit,
        latest,
        oldest,
        inclusive,
      },
    });
  }

  /**
   * Retrieves reply messages in a thread.
   * 
   * @param {string} channelId
   * @param {string} threadTs - Timestamp of the parent message
   * @param {object} [options={}]
   * @param {string} [options.cursor]
   * @param {number} [options.limit=100]
   * @returns {Promise<{ ok: boolean, messages: Array<object>, has_more: boolean, response_metadata?: { next_cursor?: string } }>}
   */
  async getConversationReplies(channelId, threadTs, { cursor, limit = 100 } = {}) {
    if (!channelId || typeof channelId !== 'string') {
      throw new TypeError("Parameter 'channelId' must be a non-empty string.");
    }
    if (!threadTs || typeof threadTs !== 'string') {
      throw new TypeError("Parameter 'threadTs' must be a non-empty string.");
    }
    return this._request('conversations.replies', {
      method: 'GET',
      query: {
        channel: channelId.trim(),
        ts: threadTs.trim(),
        cursor,
        limit,
      },
    });
  }
}
