/**
 * @file jiraConnector.js
 * @description High-level Jira Ingestion Connector.
 *
 * Orchestrates fetching authorized Jira projects, searching issues with JQL,
 * handling offset-based pagination safely, and mapping issues into validated
 * canonical SourceRecord / SourceRecordCandidate objects.
 */

import { JiraClient } from './jiraClient.js';
import { normalizeJiraIssue, normalizeJiraIssueCandidate } from './jiraNormalizer.js';
import { JiraAuthenticationError, JiraValidationError } from './jiraErrors.js';
import { validateSourceRecord } from '../../../../integrations/common/types.js';

export class JiraConnector {
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
      total = typeof response?.total === 'number' ? response.total : issues.length;

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
