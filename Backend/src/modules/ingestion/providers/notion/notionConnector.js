/**
 * @file notionConnector.js
 * @description Ingestion connector for Notion pages, databases, and workspace hierarchies,
 * conforming to the shared BaseConnector contract.
 */

import { BaseConnector } from '../../../../integrations/common/connector.js';
import { createSyncResult, SYNC_STATUS } from '../../../../integrations/common/results.js';
import { normalizeProviderError } from '../../../../integrations/common/errors.js';
import { NotionClient } from './notionClient.js';
import { extractBlockHierarchy } from './notionExtractor.js';
import {
  normalizeNotionPageCandidate,
  normalizeDatabaseRowCandidate,
  parseNotionId,
} from './notionNormalizer.js';
import { NotionAuthenticationError } from './notionErrors.js';
import { validateSourceRecordCandidate } from '../../contracts/sourceRecord.js';

export class NotionConnector extends BaseConnector {
  /**
   * @param {object} [config={}]
   * @param {NotionClient} [config.client] Custom or preconfigured Notion client
   * @param {string} [config.apiKey] API key for default client instantiation
   * @param {typeof fetch} [config.fetchFn] Injected fetch implementation
   */
  constructor({ client, apiKey, fetchFn, ...clientOptions } = {}) {
    super();
    if (!client) {
      const resolvedKey = apiKey !== undefined ? apiKey : (process.env.NOTION_API_KEY || process.env.NOTION_TOKEN);
      if (!resolvedKey || typeof resolvedKey !== 'string' || !resolvedKey.trim()) {
        throw new NotionAuthenticationError(
          'NOTION_API_KEY is required. Please provide it in options or set NOTION_API_KEY in environment.',
          { code: 'NOTION_API_KEY_MISSING' }
        );
      }
    }
    this.client = client || new NotionClient({ apiKey, fetchFn, ...clientOptions });
  }

  /**
   * Identifies the external provider.
   * @returns {string}
   */
  get provider() {
    return 'notion';
  }

  /**
   * Validates configuration credentials and required settings.
   *
   * @param {object} [config={}]
   * @returns {{ valid: boolean, errors: string[] }}
   */
  static validateConfig(config = {}) {
    const key = config.apiKey !== undefined
      ? config.apiKey
      : (process.env.NOTION_API_KEY || process.env.NOTION_TOKEN);
    const errors = [];
    if (!key || typeof key !== 'string' || !key.trim()) {
      errors.push('NOTION_API_KEY (or NOTION_TOKEN) is required.');
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
    return NotionConnector.validateConfig(config);
  }

  /**
   * Verifies credentials and connectivity by executing a lightweight search against Notion API.
   *
   * @returns {Promise<{ ok: boolean, error?: string, details?: object }>}
   */
  async verifyConnection() {
    try {
      const searchResult = await this.client.search({ pageSize: 1 });
      return {
        ok: true,
        details: {
          object: searchResult?.object || 'list',
          resultCount: searchResult?.results?.length ?? 0,
        },
      };
    } catch (err) {
      const normalized = normalizeProviderError(err, 'notion');
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
   * Performs an authorized sync returning a standardized SyncResult.
   * Supports synchronizing specific pageIds, databaseIds, or discovered workspace pages.
   *
   * @param {object} [options={}]
   * @param {string} [options.projectId='default-project']
   * @param {boolean} [options.fetchContent=true]
   * @param {string[]} [options.pageIds=[]]
   * @param {string[]} [options.databaseIds=[]]
   * @param {number} [options.maxPages=5]
   * @param {string} [options.cursor]
   * @returns {Promise<import('../../../../integrations/common/results.js').SyncResult>}
   */
  async sync({
    projectId = 'default-project',
    fetchContent = true,
    pageIds = [],
    databaseIds = [],
    maxPages = 5,
    cursor,
    ...rest
  } = {}) {
    const records = [];
    const errors = [];
    let nextCursor = null;
    let hasMore = false;

    try {
      // 1. If explicit pageIds provided, fetch each page
      if (Array.isArray(pageIds) && pageIds.length > 0) {
        for (const pid of pageIds) {
          try {
            const pageCandidate = await this.fetchPage(pid, { projectId, fetchContent, ...rest });
            records.push(pageCandidate);
          } catch (itemErr) {
            errors.push(normalizeProviderError(itemErr, 'notion'));
          }
        }
      }

      // 2. If explicit databaseIds provided, fetch rows
      if (Array.isArray(databaseIds) && databaseIds.length > 0) {
        for (const dbId of databaseIds) {
          try {
            const dbRecords = await this.fetchDatabase(dbId, { projectId, fetchPageContent: fetchContent, ...rest });
            records.push(...dbRecords);
          } catch (itemErr) {
            errors.push(normalizeProviderError(itemErr, 'notion'));
          }
        }
      }

      // 3. Otherwise, search workspace
      if ((!pageIds || pageIds.length === 0) && (!databaseIds || databaseIds.length === 0)) {
        let currentCursor = cursor;
        let pagesFetched = 0;
        let moreAvailable = true;

        while (moreAvailable && pagesFetched < maxPages) {
          const searchResult = await this.client.search({
            startCursor: currentCursor,
            pageSize: 100,
          });

          const items = searchResult?.results || [];
          for (const item of items) {
            if (item.object === 'page') {
              try {
                let contentLines = [];
                if (fetchContent) {
                  contentLines = await extractBlockHierarchy(this.client, item.id, { maxDepth: 4 });
                }
                const candidate = normalizeNotionPageCandidate(item, contentLines, { projectId });
                const validation = validateSourceRecordCandidate(candidate);
                if (validation.valid) {
                  records.push(candidate);
                }
              } catch (itemErr) {
                errors.push(normalizeProviderError(itemErr, 'notion'));
              }
            }
          }

          pagesFetched += 1;
          moreAvailable = Boolean(searchResult?.has_more);
          currentCursor = searchResult?.next_cursor || undefined;
          nextCursor = currentCursor || null;
          hasMore = moreAvailable;
        }
      }
    } catch (fatalErr) {
      errors.push(normalizeProviderError(fatalErr, 'notion'));
    }

    return createSyncResult({
      provider: 'notion',
      records,
      recordsProcessed: records.length,
      errors,
      cursor: nextCursor,
      hasMore,
      metadata: {
        projectId,
        fetchContent,
      },
    });
  }

  /**
   * Fetches an individual authorized Notion page, extracts its block content,
   * and normalizes it into a SourceRecordCandidate.
   * 
   * @param {string} pageId Notion Page UUID or Notion URL
   * @param {object} [options={}]
   * @param {string} [options.projectId='default-project'] Target project ID
   * @param {boolean} [options.fetchContent=true] Whether to fetch and extract page blocks
   * @param {number} [options.maxDepth=5] Max nested block recursion depth
   * @param {string} [options.recordType] Override recordType category
   * @returns {Promise<import('../../contracts/sourceRecord.js').SourceRecordCandidate>}
   */
  async fetchPage(
    pageId,
    { projectId = 'default-project', fetchContent = true, maxDepth = 5, recordType } = {}
  ) {
    if (!pageId || typeof pageId !== 'string') {
      throw new TypeError("Parameter 'pageId' must be a non-empty string.");
    }

    const normalizedId = parseNotionId(pageId) || pageId;
    const page = await this.client.getPage(normalizedId);

    let contentLines = [];
    if (fetchContent) {
      contentLines = await extractBlockHierarchy(this.client, normalizedId, { maxDepth });
    }

    const candidate = normalizeNotionPageCandidate(page, contentLines, {
      projectId,
      recordType,
      childCount: contentLines.totalBlocks ?? contentLines.length,
    });

    const validation = validateSourceRecordCandidate(candidate);
    if (!validation.valid) {
      throw new Error(`Generated SourceRecordCandidate failed validation: ${validation.errors.join('; ')}`);
    }

    return candidate;
  }

  /**
   * Queries a Notion database and normalizes all rows/pages into SourceRecordCandidates.
   * 
   * @param {string} databaseId Notion Database UUID or URL
   * @param {object} [options={}]
   * @param {string} [options.projectId='default-project'] Target project ID
   * @param {boolean} [options.fetchPageContent=false] Whether to fetch block trees for each row
   * @param {number} [options.maxDepth=3] Max nested block recursion depth
   * @param {object} [options.filter] Notion database query filter
   * @param {object[]} [options.sorts] Notion database query sorts
   * @returns {Promise<Array<import('../../contracts/sourceRecord.js').SourceRecordCandidate>>}
   */
  async fetchDatabase(
    databaseId,
    { projectId = 'default-project', fetchPageContent = false, maxDepth = 3, filter, sorts } = {}
  ) {
    if (!databaseId || typeof databaseId !== 'string') {
      throw new TypeError("Parameter 'databaseId' must be a non-empty string.");
    }

    const normalizedDbId = parseNotionId(databaseId) || databaseId;
    const records = [];
    let cursor = undefined;
    let hasMore = true;

    while (hasMore) {
      const result = await this.client.queryDatabase(normalizedDbId, {
        startCursor: cursor,
        pageSize: 100,
        filter,
        sorts,
      });

      const pages = result?.results || [];
      for (const rowPage of pages) {
        let contentLines = [];
        if (fetchPageContent) {
          contentLines = await extractBlockHierarchy(this.client, rowPage.id, { maxDepth });
        }

        const candidate = normalizeDatabaseRowCandidate(rowPage, contentLines, {
          projectId,
          databaseId: normalizedDbId,
        });
        const validation = validateSourceRecordCandidate(candidate);
        if (validation.valid) {
          records.push(candidate);
        }
      }

      hasMore = Boolean(result?.has_more);
      cursor = result?.next_cursor || undefined;
    }

    return records;
  }

  /**
   * Discovers and ingests pages explicitly shared with the integration in workspace search.
   * 
   * @param {object} [options={}]
   * @param {string} [options.projectId='default-project'] Target project ID
   * @param {boolean} [options.fetchContent=true]
   * @returns {Promise<Array<import('../../contracts/sourceRecord.js').SourceRecordCandidate>>}
   */
  async syncAuthorizedWorkspace({ projectId = 'default-project', fetchContent = true } = {}) {
    const records = [];
    let cursor = undefined;
    let hasMore = true;

    while (hasMore) {
      const searchResult = await this.client.search({
        startCursor: cursor,
        pageSize: 100,
      });

      const items = searchResult?.results || [];
      for (const item of items) {
        if (item.object === 'page') {
          let contentLines = [];
          if (fetchContent) {
            contentLines = await extractBlockHierarchy(this.client, item.id, { maxDepth: 4 });
          }
          const candidate = normalizeNotionPageCandidate(item, contentLines, { projectId });
          const validation = validateSourceRecordCandidate(candidate);
          if (validation.valid) {
            records.push(candidate);
          }
        }
      }

      hasMore = Boolean(searchResult?.has_more);
      cursor = searchResult?.next_cursor || undefined;
    }

    return records;
  }
}
