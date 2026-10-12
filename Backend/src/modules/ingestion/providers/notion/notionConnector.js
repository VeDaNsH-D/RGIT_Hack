/**
 * @file notionConnector.js
 * @description Ingestion connector for Notion pages, databases, and workspace hierarchies.
 */

import { NotionClient } from './notionClient.js';
import { extractBlockHierarchy } from './notionExtractor.js';
import {
  normalizeNotionPageCandidate,
  normalizeDatabaseRowCandidate,
  parseNotionId,
} from './notionNormalizer.js';
import { NotionAuthenticationError } from './notionErrors.js';
import { validateSourceRecordCandidate } from '../../contracts/sourceRecord.js';

export class NotionConnector {
  /**
   * @param {object} [config={}]
   * @param {NotionClient} [config.client] Custom or preconfigured Notion client
   * @param {string} [config.apiKey] API key for default client instantiation
   * @param {typeof fetch} [config.fetchFn] Injected fetch implementation
   */
  constructor({ client, apiKey, fetchFn, ...clientOptions } = {}) {
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
