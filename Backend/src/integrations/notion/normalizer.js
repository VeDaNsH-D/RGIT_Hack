/**
 * Notion to Normalized SourceRecord Mapper
 * 
 * Maps raw Notion page and database objects into the common SourceRecord contract,
 * preserving provenance IDs, URLs, timestamps, and extracted markdown content.
 */

import { SOURCE_PROVIDERS, RECORD_TYPES } from '../common/types.js';
import { extractPageTitle, extractProperties } from './extractor.js';

/**
 * Normalizes a Notion ID from 32-hex character string or URL to UUID with hyphens.
 * e.g., 4d036e052d4e4b7192b55d9c792167c1 -> 4d036e05-2d4e-4b71-92b5-5d9c792167c1
 * 
 * @param {string} rawIdOrUrl
 * @returns {string}
 */
export function parseNotionId(rawIdOrUrl) {
  if (!rawIdOrUrl || typeof rawIdOrUrl !== 'string') return '';
  const trimmed = rawIdOrUrl.trim();

  // 1. If it's already a standard UUID with hyphens
  const uuidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) {
    return uuidMatch[0].toLowerCase();
  }

  // 2. If it ends with 32 hex characters (e.g. at the end of URL slug /My-Page-4d036e052d4e4b7192b55d9c792167c1)
  const endHexMatch = trimmed.match(/(?:-|\/|^)([0-9a-f]{32})(?:[?#]|$)/i);
  if (endHexMatch) {
    const hex = endHexMatch[1].toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // 3. Fallback: match 32-hex
  const anyHexMatch = trimmed.match(/\b([0-9a-f]{32})\b/i) || trimmed.match(/([0-9a-f]{32})/i);
  if (anyHexMatch) {
    const hex = anyHexMatch[1].toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return trimmed;
}

/**
 * Helper to format database properties into markdown summary lines
 */
function formatPropertySummary(properties = {}) {
  const lines = [];
  for (const [key, val] of Object.entries(properties)) {
    if (val === null || val === undefined || val === '') continue;
    if (Array.isArray(val)) {
      if (val.length > 0) lines.push(`**${key}**: ${val.join(', ')}`);
    } else if (typeof val === 'object') {
      if (val.name) lines.push(`**${key}**: ${val.name}`);
      else lines.push(`**${key}**: ${JSON.stringify(val)}`);
    } else {
      lines.push(`**${key}**: ${val}`);
    }
  }
  return lines;
}

/**
 * Normalizes a Notion page and its extracted block content into a SourceRecord.
 * Supports both (page, contentLines, options) and ({ page, blocks, ... }) signatures.
 * 
 * @param {object} pageOrOptions
 * @param {string[]|object[]} [contentLinesArg=[]]
 * @param {object} [optionsArg={}]
 * @returns {import('../common/types.js').SourceRecord}
 */
export function normalizeNotionPage(pageOrOptions, contentLinesArg = [], optionsArg = {}) {
  let page;
  let rawLines = [];
  let opts = {};

  if (pageOrOptions && typeof pageOrOptions === 'object' && pageOrOptions.page) {
    page = pageOrOptions.page;
    rawLines = pageOrOptions.blocks || pageOrOptions.contentLines || [];
    opts = pageOrOptions;
  } else {
    page = pageOrOptions;
    rawLines = contentLinesArg || [];
    opts = optionsArg || {};
  }

  if (!page || typeof page !== 'object') {
    throw new TypeError('Parameter page must be a non-null object.');
  }

  const projectId = (opts.projectId && String(opts.projectId).trim()) || 'default-project';
  const recordType = opts.recordType;

  const title = extractPageTitle(page);
  const parsedProps = extractProperties(page.properties);

  // Normalize lines to strings
  const stringLines = [];
  if (Array.isArray(rawLines)) {
    for (const item of rawLines) {
      if (typeof item === 'string') {
        if (item.trim()) stringLines.push(item);
      } else if (item && typeof item === 'object') {
        const textVal = item.text || item.content || item.plain_text;
        if (textVal) stringLines.push(textVal);
      }
    }
  }

  // If this is a database item or has properties, prepend property summary to content if needed
  const isDbItem = Boolean(
    opts.isDatabaseItem ||
    opts.databaseId ||
    page.parent?.type === 'database_id'
  );

  if (isDbItem && Object.keys(parsedProps).length > 0) {
    const propLines = formatPropertySummary(parsedProps);
    if (propLines.length > 0) {
      stringLines.unshift(...propLines);
    }
  }

  const content = stringLines.join('\n\n').trim();

  // Infer record type if not provided: decisions if title has decision, otherwise document
  let resolvedType = recordType || RECORD_TYPES.DOCUMENT;
  if (!recordType) {
    const lowerTitle = (title || '').toLowerCase();
    if (lowerTitle.includes('decision') || lowerTitle.includes('adr')) {
      resolvedType = RECORD_TYPES.DECISION;
    } else if (lowerTitle.includes('note') || lowerTitle.includes('meeting')) {
      resolvedType = RECORD_TYPES.NOTE;
    }
  }

  const nowIso = new Date().toISOString();
  const observedAt = page.last_edited_time || page.created_time || undefined;

  const metadata = {
    sourceId: page.id,
    sourceUrl: page.url || null,
    isDatabaseItem: isDbItem,
    blockCount: opts.childCount ?? (Array.isArray(rawLines) ? (rawLines.totalBlocks ?? rawLines.length) : 0),
    parent: page.parent || null,
    icon: page.icon || null,
    cover: page.cover || null,
    archived: Boolean(page.archived),
    properties: parsedProps,
  };

  if (opts.databaseId) {
    metadata.databaseId = opts.databaseId;
  }

  return {
    id: `src_notion_${page.id}`,
    projectId,
    provider: SOURCE_PROVIDERS.NOTION,
    externalId: page.id,
    type: resolvedType,
    recordType: resolvedType,
    title,
    content,
    url: page.url || undefined,
    author: page.last_edited_by?.id || page.created_by?.id || undefined,
    observedAt,
    fetchedAt: nowIso,
    metadata,
  };
}

/**
 * Normalizes a Notion database record/row (which is a page inside a database).
 * 
 * @param {object} rowPage Database item page object
 * @param {string[]} [contentLines=[]]
 * @param {object} options
 * @param {string} [options.projectId]
 * @param {string} [options.databaseId]
 * @returns {import('../common/types.js').SourceRecord}
 */
export function normalizeDatabaseRow(rowPage, contentLines = [], { projectId, databaseId } = {}) {
  const record = normalizeNotionPage(rowPage, contentLines, {
    projectId,
    databaseId,
    isDatabaseItem: true,
  });
  return record;
}
