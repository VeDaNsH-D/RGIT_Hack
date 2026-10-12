/**
 * @file jiraConnector.js
 * @description High-level Jira Ingestion Connector conforming to the shared BaseConnector contract.
 *
 * Orchestrates fetching authorized Jira projects, searching issues with JQL,
 * handling offset-based pagination safely, and mapping issues into validated
 * canonical SourceRecord / SourceRecordCandidate objects.
 */

import { BaseConnector } from '../../../../integrations/common/connector.js';
import { createSyncResult, SYNC_STATUS } from '../../../../integrations/common/results.js';
import { normalizeProviderError } from '../../../../integrations/common/errors.js';
import { JiraClient } from './jiraClient.js';
import { normalizeJiraIssue, normalizeJiraIssueCandidate } from './jiraNormalizer.js';
import { JiraAuthenticationError, JiraValidationError } from './jiraErrors.js';
import { validateSourceRecord } from '../../../../integrations/common/types.js';

export class JiraConnector extends BaseConnector {
  /**
   * @param {object} [config={}]
   * @param {JiraClient} [config.client] Custom or preconfigured Jira client
   * @param {string} [config.host] Jira base domain (e.g., https://myorg.atlassian.net)
   * @param {string} [config.baseUrl] Alias for host
   * @param {string} [config.email] Atlassian account email
   * @param {string} [config.apiToken] Atlassian API token or PAT
   * @param {typeof fetch} [config.fetchFn] Injected fetch implementation
   */
  constructor({ client, host, baseUrl, email, apiToken, fetchFn, ...clientOptions } = {}) {
    super();
    if (!client) {
      const resolvedHost = host || baseUrl || process.env.JIRA_HOST || process.env.JIRA_BASE_URL;
      const resolvedToken = apiToken !== undefined
        ? apiToken
        : (process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN);

      if (!resolvedToken || typeof resolvedToken !== 'string' || !resolvedToken.trim()) {
        throw new JiraAuthenticationError(
          'JIRA_API_TOKEN is required. Please provide it in options or set JIRA_API_TOKEN in environment.',
          { code: 'JIRA_API_TOKEN_MISSING' }
        );
      }

      if (!resolvedHost || typeof resolvedHost !== 'string' || !resolvedHost.trim()) {
        throw new JiraValidationError(
          'JIRA_HOST is required. Please provide it in options or set JIRA_HOST in environment.',
          { code: 'JIRA_HOST_MISSING' }
        );
      }
    }

    this.client = client || new JiraClient({
      host,
      baseUrl,
      email,
      apiToken,
      fetchFn,
      ...clientOptions,
    });
  }

  /**
   * Identifies the external provider.
   * @returns {string}
   */
  get provider() {
    return 'jira';
  }

  /**
   * Validates configuration credentials and required settings.
   *
   * @param {object} [config={}]
   * @returns {{ valid: boolean, errors: string[] }}
   */
  static validateConfig(config = {}) {
    const host = config.host || config.baseUrl || process.env.JIRA_HOST || process.env.JIRA_BASE_URL;
    const token = config.apiToken !== undefined
      ? config.apiToken
      : (process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN);

    const errors = [];
    if (!token || typeof token !== 'string' || !token.trim()) {
      errors.push('JIRA_API_TOKEN is required.');
    }
    if (!host || typeof host !== 'string' || !host.trim()) {
      errors.push('JIRA_HOST (or JIRA_BASE_URL) is required.');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Instance method validating configuration.
   *
   * @param {object} [config={}]
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateConfig(config = {}) {
    return JiraConnector.validateConfig(config);
  }

  /**
   * Verifies credentials and connectivity by contacting the Jira API.
   *
   * @returns {Promise<{ ok: boolean, error?: string, details?: object }>}
   */
  async verifyConnection() {
    try {
      let myself = null;
      try {
        myself = await this.client.myself();
      } catch {
        // Fall back to getProjects if myself endpoint requires different permission
        const projects = await this.client.getProjects();
        return {
          ok: true,
          details: {
            endpoint: 'projects',
            projectCount: Array.isArray(projects) ? projects.length : 0,
          },
        };
      }

      return {
        ok: true,
        details: {
          accountId: myself?.accountId,
          displayName: myself?.displayName,
          emailAddress: myself?.emailAddress,
        },
      };
    } catch (err) {
      const normalized = normalizeProviderError(err, 'jira');
      return {
        ok: false,
        error: normalized.message,
        details: {
          code: normalized.code,
          statusCode: normalized.statusCode,
        },
      };
    }
  }

  /**
   * Performs an authorized sync of Jira issues returning a standardized SyncResult.
   *
   * @param {object} [options={}]
   * @param {string} [options.projectKey] - Optional target Jira project key filter
   * @param {string} [options.jql] - Custom JQL search string
   * @param {string} [options.projectId='default-project'] - Relay project ID
   * @param {string[]} [options.issueKeys=[]] - Explicit issue keys to fetch
   * @param {number} [options.maxPages=5] - Maximum pagination pages to retrieve
   * @param {number} [options.perPage=50] - Number of items per page
   * @param {boolean} [options.fetchAll=false] - Whether to paginate until all results are fetched
   * @param {boolean} [options.asCandidate=true] - Return SourceRecordCandidate objects by default
   * @returns {Promise<import('../../../../integrations/common/results.js').SyncResult>}
   */
  async sync({
    projectKey,
    jql = '',
    projectId = 'default-project',
    issueKeys = [],
    maxPages = 5,
    perPage = 50,
    fetchAll = false,
    asCandidate = true,
  } = {}) {
    const records = [];
    const errors = [];
    let nextOffset = null;
    let hasMore = false;

    try {
      if (Array.isArray(issueKeys) && issueKeys.length > 0) {
        for (const key of issueKeys) {
          try {
            const issueRecord = await this.fetchIssue(key, { projectId, asCandidate });
            records.push(issueRecord);
          } catch (itemErr) {
            errors.push(normalizeProviderError(itemErr, 'jira'));
          }
        }
      } else {
        // Search issues with pagination
        const clauses = [];
        if (projectKey && typeof projectKey === 'string' && projectKey.trim()) {
          clauses.push(`project = "${projectKey.trim()}"`);
        }
        if (jql && typeof jql === 'string' && jql.trim()) {
          clauses.push(`(${jql.trim()})`);
        }

        let finalJql = clauses.join(' AND ');
        if (!finalJql.toLowerCase().includes('order by')) {
          finalJql = finalJql ? `${finalJql} ORDER BY updated DESC` : 'ORDER BY updated DESC';
        }

        let startAt = 0;
        let pagesFetched = 0;
        let total = Infinity;

        while (startAt < total) {
          if (!fetchAll && pagesFetched >= maxPages) {
            hasMore = startAt < total;
            nextOffset = startAt;
            break;
          }

          let response;
          try {
            response = await this.client.searchIssues(finalJql, {
              startAt,
              maxResults: perPage,
            });
          } catch (pageErr) {
            errors.push(normalizeProviderError(pageErr, 'jira'));
            break;
          }

          const issues = Array.isArray(response?.issues) ? response.issues : [];
          const isLast = response?.isLast === true;
          total = typeof response?.total === 'number'
            ? response.total
            : (isLast ? startAt + issues.length : (issues.length < perPage ? startAt + issues.length : Infinity));

          for (const issue of issues) {
            const context = {
              projectId,
              baseUrl: this.client.host,
              fetchedAt: new Date(),
            };

            const record = asCandidate
              ? normalizeJiraIssueCandidate(issue, context)
              : normalizeJiraIssue(issue, context);

            records.push(record);
          }

          pagesFetched += 1;
          startAt += issues.length;

          if (issues.length === 0 || startAt >= total || isLast) {
            hasMore = false;
            nextOffset = null;
            break;
          }
          nextOffset = startAt;
          hasMore = startAt < total;
        }
      }
    } catch (fatalErr) {
      errors.push(normalizeProviderError(fatalErr, 'jira'));
    }

    return createSyncResult({
      provider: 'jira',
      records,
      recordsProcessed: records.length,
      errors,
      cursor: nextOffset,
      hasMore,
      metadata: {
        projectId,
        projectKey: projectKey || null,
        jql: jql || null,
      },
    });
  }

  /**
   * Fetches an individual authorized Jira issue and normalizes it into a SourceRecord.
   * 
   * @param {string} issueIdOrKey - Issue Key (e.g. 'PROJ-101') or ID
   * @param {object} [options={}]
   * @param {string} [options.projectId='default-project'] - Target Relay project identifier
   * @param {boolean} [options.asCandidate=false] - Return SourceRecordCandidate instead of SourceRecord
   * @returns {Promise<import('../../../integrations/common/types.js').SourceRecord|import('../../contracts/sourceRecord.js').SourceRecordCandidate>}
   */
  async fetchIssue(issueIdOrKey, { projectId = 'default-project', asCandidate = false } = {}) {
    if (!issueIdOrKey || typeof issueIdOrKey !== 'string') {
      throw new TypeError("Parameter 'issueIdOrKey' must be a non-empty string.");
    }

    const rawIssue = await this.client.getIssue(issueIdOrKey.trim());
    const context = {
      projectId,
      baseUrl: this.client.host,
      fetchedAt: new Date(),
    };

    if (asCandidate) {
      return normalizeJiraIssueCandidate(rawIssue, context);
    }

    const record = normalizeJiraIssue(rawIssue, context);
    const validation = validateSourceRecord(record);
    if (!validation.valid) {
      throw new Error(`Failed to validate Jira issue SourceRecord: ${validation.errors.join('; ')}`);
    }

    return record;
  }

  /**
   * Fetches issues matching a project or custom JQL filter with safe pagination.
   * 
   * @param {object} [options={}]
   * @param {string} [options.projectKey] - Optional target Jira project key filter
   * @param {string} [options.jql] - Custom JQL search string
   * @param {string} [options.projectId='default-project'] - Relay project ID
   * @param {number} [options.maxPages=5] - Maximum pagination pages to retrieve
   * @param {number} [options.perPage=50] - Number of items per page (max 100)
   * @param {boolean} [options.fetchAll=false] - If true, paginate until all results are fetched
   * @param {boolean} [options.asCandidate=false] - Return SourceRecordCandidate objects
   * @returns {Promise<Array<import('../../../integrations/common/types.js').SourceRecord>>}
   */
  async fetchIssues({
    projectKey,
    jql = '',
    projectId = 'default-project',
    maxPages = 5,
    perPage = 50,
    fetchAll = false,
    asCandidate = false,
  } = {}) {
    // Construct JQL
    const clauses = [];
    if (projectKey && typeof projectKey === 'string' && projectKey.trim()) {
      clauses.push(`project = "${projectKey.trim()}"`);
    }
    if (jql && typeof jql === 'string' && jql.trim()) {
      clauses.push(`(${jql.trim()})`);
    }

    let finalJql = clauses.join(' AND ');
    if (!finalJql.toLowerCase().includes('order by')) {
      finalJql = finalJql ? `${finalJql} ORDER BY updated DESC` : 'ORDER BY updated DESC';
    }

    const allRecords = [];
    let startAt = 0;
    let pagesFetched = 0;
    let total = Infinity;

    while (startAt < total) {
      if (!fetchAll && pagesFetched >= maxPages) {
        break;
      }

      const response = await this.client.searchIssues(finalJql, {
        startAt,
        maxResults: perPage,
      });

      const issues = Array.isArray(response?.issues) ? response.issues : [];
      const isLast = response?.isLast === true;
      total = typeof response?.total === 'number'
        ? response.total
        : (isLast ? startAt + issues.length : (issues.length < perPage ? startAt + issues.length : Infinity));

      for (const issue of issues) {
        const context = {
          projectId,
          baseUrl: this.client.host,
          fetchedAt: new Date(),
        };

        const record = asCandidate
          ? normalizeJiraIssueCandidate(issue, context)
          : normalizeJiraIssue(issue, context);

        allRecords.push(record);
      }

      pagesFetched += 1;
      startAt += issues.length;

      // Prevent infinite loop if no items returned
      if (issues.length === 0) {
        break;
      }
    }

    return allRecords;
  }

  /**
   * Retrieves all Jira projects authorized for the connected account.
   * 
   * @returns {Promise<Array<{ id: string, key: string, name: string, projectTypeKey?: string }>>}
   */
  async getProjects() {
    const rawProjects = await this.client.getProjects();
    if (!Array.isArray(rawProjects)) {
      return [];
    }

    return rawProjects.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      projectTypeKey: p.projectTypeKey,
    }));
  }
}
