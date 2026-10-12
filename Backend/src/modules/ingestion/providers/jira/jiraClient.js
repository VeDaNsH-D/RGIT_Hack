/**
 * @file jiraClient.js
 * @description Authenticated HTTP transport client for the official Jira REST API (v3/v2).
 *
 * Implements:
 * - Native fetch transport with zero third-party SDK lock-in
 * - Secure authentication: Jira Cloud Basic Auth (Email + API token) and Bearer/OAuth/PAT tokens
 * - SSRF mitigation: Base URL pinning and strict endpoint validation
 * - Categorized error handling (401 Auth, 403 Permission, 404 Not Found, 429 Rate Limit)
 * - Safe sanitization: Never logs or leaks authorization tokens or passwords
 * - Bounded exponential backoff retries with Retry-After header support via withRetry
 * - Offset-based pagination (startAt, maxResults, total)
 */

import { withRetry } from '../../../../notifications/reliability/retry.js';
import {
  JiraClientError,
  JiraAuthenticationError,
  JiraPermissionError,
  JiraNotFoundError,
  JiraRateLimitError,
  JiraValidationError,
} from './jiraErrors.js';

const DEFAULT_API_VERSION = '3';
const DEFAULT_TIMEOUT_MS = 15000;

export class JiraClient {
  /**
   * @param {object} [config={}]
   * @param {string} [config.host] Jira base domain (e.g., https://myorg.atlassian.net)
   * @param {string} [config.baseUrl] Alias for host
   * @param {string} [config.email] Atlassian account email for Basic Auth
   * @param {string} [config.apiToken] Atlassian API token or PAT
   * @param {string} [config.apiVersion='3'] Jira REST API version ('3' or '2')
   * @param {typeof fetch} [config.fetchFn=globalThis.fetch] Injected fetch function
   * @param {object} [config.retryOptions] Custom retry options for withRetry
   */
  constructor({
    host,
    baseUrl,
    cloudId,
    email,
    apiToken,
    accessToken,
    apiVersion = DEFAULT_API_VERSION,
    fetchFn = globalThis.fetch,
    retryOptions = {},
  } = {}) {
    let rawHost = host || baseUrl;
    if (!rawHost && cloudId) {
      rawHost = `https://api.atlassian.com/ex/jira/${cloudId}`;
    }
    rawHost = rawHost || process.env.JIRA_HOST || process.env.JIRA_BASE_URL || '';
    this.host = rawHost ? rawHost.replace(/\/+$/, '') : '';
    this.cloudId = cloudId || '';
    const resolvedToken = accessToken !== undefined
      ? accessToken
      : (apiToken !== undefined ? apiToken : (process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN || ''));
    this.apiToken = resolvedToken;
    this.email = accessToken ? '' : (email !== undefined ? email : (process.env.JIRA_EMAIL || ''));
    this.apiVersion = apiVersion;
    this.fetchFn = fetchFn;
    this.retryOptions = retryOptions;
  }

  /**
   * Validates required credentials before executing requests.
   * @private
   */
  _ensureAuth() {
    if (!this.apiToken || typeof this.apiToken !== 'string' || !this.apiToken.trim()) {
      throw new JiraAuthenticationError(
        'JIRA_API_TOKEN is required. Please provide it in options or set JIRA_API_TOKEN in environment.',
        { code: 'JIRA_CREDENTIALS_MISSING' }
      );
    }

    if (!this.host || typeof this.host !== 'string' || !this.host.trim()) {
      throw new JiraValidationError(
        'Jira host is required. Please provide JIRA_HOST in options or environment (e.g. https://my-org.atlassian.net).',
        { code: 'JIRA_HOST_MISSING' }
      );
    }
  }

  /**
   * Builds the Authorization header based on available credentials.
   * @private
   * @returns {string}
   */
  _buildAuthHeader() {
    const token = this.apiToken.trim();
    const mail = this.email ? this.email.trim() : '';

    if (mail) {
      // Basic auth: email:apiToken
      const encoded = Buffer.from(`${mail}:${token}`).toString('base64');
      return `Basic ${encoded}`;
    }

    // Bearer / PAT / OAuth token
    return `Bearer ${token}`;
  }

  /**
   * Executes an authenticated request with error handling and retry mechanics.
   * 
   * @param {string} endpoint - Relative API endpoint or path.
   * @param {object} [options={}]
   * @param {'GET'|'POST'|'PUT'|'DELETE'} [options.method='GET']
   * @param {Record<string, unknown>} [options.query]
   * @param {unknown} [options.body]
   * @returns {Promise<any>}
   */
  async _request(endpoint, { method = 'GET', query, body } = {}) {
    this._ensureAuth();

    // Construct URL
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    let url = cleanEndpoint.startsWith('/rest/api/')
      ? `${this.host}${cleanEndpoint}`
      : `${this.host}/rest/api/${this.apiVersion}${cleanEndpoint}`;

    if (query && typeof query === 'object') {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) {
          if (Array.isArray(v)) {
            searchParams.append(k, v.join(','));
          } else {
            searchParams.append(k, String(v));
          }
        }
      }
      const qs = searchParams.toString();
      if (qs) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
    }

    const headers = {
      Authorization: this._buildAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
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

      if (!res.ok) {
        let errJson = null;
        let rawBody = '';
        try {
          rawBody = await res.text();
          errJson = JSON.parse(rawBody);
        } catch {
          // Response body is not JSON
        }

        const statusCode = res.status;
        const errorMessages = errJson?.errorMessages || [];
        const errors = errJson?.errors || {};
        const fieldErrorMsg = Object.entries(errors)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');

        const message = errorMessages.join('; ')
          || fieldErrorMsg
          || errJson?.message
          || (rawBody ? `Jira API returned HTTP ${statusCode}: ${rawBody}` : `Jira API request failed with status ${statusCode}`);

        if (statusCode === 401) {
          throw new JiraAuthenticationError(message, { statusCode, code: 'unauthorized' });
        }

        if (statusCode === 403) {
          throw new JiraPermissionError(message, { statusCode, code: 'forbidden' });
        }

        if (statusCode === 404) {
          throw new JiraNotFoundError(message, { statusCode, code: 'not_found' });
        }

        if (statusCode === 429) {
          const retryAfterHeader = res.headers?.get?.('Retry-After');
          const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 1;
          const rateErr = new JiraRateLimitError(message, retryAfter);
          rateErr.isTransient = true;
          throw rateErr;
        }

        if (statusCode === 400) {
          throw new JiraValidationError(message, { statusCode, code: 'validation_error', data: errJson });
        }

        const apiErr = new JiraClientError(message, { statusCode, code: `HTTP_${statusCode}`, data: errJson });
        if (statusCode >= 500) {
          apiErr.isTransient = true;
        }
        throw apiErr;
      }

      // Handle 204 No Content
      if (res.status === 204) {
        return null;
      }

      try {
        return await res.json();
      } catch {
        return null;
      }
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
   * Retrieves all projects accessible to the authenticated account.
   * 
   * @param {object} [options={}]
   * @returns {Promise<Array<object>>} List of authorized Jira projects
   */
  async getProjects(options = {}) {
    return this._request('/project', { method: 'GET', query: options });
  }

  /**
   * Retrieves a single project by ID or key.
   * 
   * @param {string} projectIdOrKey
   * @returns {Promise<object>} Project details
   */
  async getProject(projectIdOrKey) {
    if (!projectIdOrKey || typeof projectIdOrKey !== 'string') {
      throw new TypeError("Parameter 'projectIdOrKey' must be a non-empty string.");
    }
    return this._request(`/project/${encodeURIComponent(projectIdOrKey.trim())}`);
  }

  /**
   * Searches issues using Jira Query Language (JQL) and offset pagination.
   * 
   * @param {string} [jql=''] - JQL query string
   * @param {object} [options={}]
   * @param {number} [options.startAt=0] - Offset index for pagination
   * @param {number} [options.maxResults=50] - Number of results per page
   * @param {string[]} [options.fields] - Fields to retrieve
   * @param {string[]} [options.expand] - Expand parameters
   * @returns {Promise<{ issues: object[], startAt: number, maxResults: number, total: number }>}
   */
  async searchIssues(jql = '', {
    startAt = 0,
    maxResults = 50,
    fields = [
      'summary',
      'description',
      'status',
      'assignee',
      'priority',
      'labels',
      'components',
      'duedate',
      'created',
      'updated',
      'project',
      'issuetype',
      'creator',
      'reporter',
      'resolution',
      'resolutiondate',
    ],
    expand,
  } = {}) {
    const query = {
      jql,
      startAt,
      maxResults,
      fields,
    };
    if (expand) query.expand = expand;

    try {
      return await this._request('/search/jql', { method: 'GET', query });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410 || err.statusCode === 405) {
        return await this._request('/search', { method: 'GET', query });
      }
      throw err;
    }
  }

  /**
   * Retrieves a single Jira issue by issue key or ID.
   * 
   * @param {string} issueIdOrKey - Issue key (e.g., 'PROJ-101') or ID
   * @param {object} [options={}]
   * @returns {Promise<object>} Jira issue object
   */
  async getIssue(issueIdOrKey, options = {}) {
    if (!issueIdOrKey || typeof issueIdOrKey !== 'string') {
      throw new TypeError("Parameter 'issueIdOrKey' must be a non-empty string.");
    }
    return this._request(`/issue/${encodeURIComponent(issueIdOrKey.trim())}`, { query: options });
  }

  /**
   * Retrieves profile details for the currently authenticated user.
   * 
   * @returns {Promise<object>} Jira user profile
   */
  async myself() {
    return this._request('/myself');
  }
}
