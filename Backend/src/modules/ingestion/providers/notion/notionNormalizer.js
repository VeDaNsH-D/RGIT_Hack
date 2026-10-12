/**
 * @file notionNormalizer.js
 * @description Normalizes raw Notion pages, databases, and blocks into SourceRecordCandidate representations.
 */

import {
  SOURCE_PROVIDERS,
  SOURCE_RECORD_TYPES,
  SOURCE_CONTENT_TYPES,
  validateSourceRecordCandidate,
} from '../../contracts/sourceRecord.js';
import { extractPageTitle, extractProperties } from './notionExtractor.js';
import { NotionClientError } from './notionErrors.js';

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

export function parseDate(val) {
  if (!val) return undefined;
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? undefined : val;
  }
  if (typeof val === 'string' || typeof val === 'number') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

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
 * Normalizes a Notion page into an agreed SourceRecordCandidate.
 *
 * @param {object} pageOrOptions
 * @param {string[]|object[]} [contentLinesArg=[]]
 * @param {object} [optionsArg={}]
 * @returns {import('../../contracts/sourceRecord.js').SourceRecordCandidate}
 */
export function normalizeNotionPageCandidate(pageOrOptions, contentLinesArg = [], optionsArg = {}) {
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
    throw new NotionClientError('Parameter page must be a non-null object.');
  }

  const projectId = (opts.projectId && String(opts.projectId).trim()) || 'default-project';
  const recordType = opts.recordType;

  const title = extractPageTitle(page);
  const parsedProps = extractProperties(page.properties);

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

  let resolvedType = recordType || SOURCE_RECORD_TYPES.DOCUMENT;
  if (!recordType) {
    const lowerTitle = (title || '').toLowerCase();
    if (lowerTitle.includes('decision') || lowerTitle.includes('adr')) {
      resolvedType = SOURCE_RECORD_TYPES.DECISION;
    } else if (lowerTitle.includes('note') || lowerTitle.includes('meeting')) {
      resolvedType = SOURCE_RECORD_TYPES.NOTE;
    }
  }

  const createdAt = parseDate(page.created_time);
  const updatedAt = parseDate(page.last_edited_time);
  const fetchedAt = opts.fetchedAt instanceof Date ? opts.fetchedAt : new Date();

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

  /** @type {import('../../contracts/sourceRecord.js').SourceRecordCandidate} */
  const candidate = {
    projectId,
    provider: SOURCE_PROVIDERS.NOTION,
    recordType: resolvedType,
    externalId: page.id,
    title,
    content,
    contentType: SOURCE_CONTENT_TYPES.MARKDOWN,
    url: page.url || undefined,
    author: page.last_edited_by?.id || page.created_by?.id || undefined,
    authorId: page.last_edited_by?.id || page.created_by?.id || undefined,
    createdAt,
    updatedAt,
    fetchedAt,
    version: 1,
    isActive: true,
    isDeleted: Boolean(page.archived),
    metadata,
  };

  const validation = validateSourceRecordCandidate(candidate);
  if (!validation.valid) {
    throw new Error(`Generated SourceRecordCandidate failed validation: ${validation.errors.join('; ')}`);
  }

  return candidate;
}

/**
 * Normalizes a Notion page into a SourceRecord compatible with legacy or direct consumers.
 */
export function normalizeNotionPage(pageOrOptions, contentLinesArg = [], optionsArg = {}) {
  const candidate = normalizeNotionPageCandidate(pageOrOptions, contentLinesArg, optionsArg);
  return {
    id: `src_notion_${candidate.externalId}`,
    ...candidate,
    type: candidate.recordType,
    observedAt: candidate.updatedAt ? candidate.updatedAt.toISOString() : undefined,
  };
}

export function normalizeDatabaseRowCandidate(rowPage, contentLines = [], options = {}) {
  return normalizeNotionPageCandidate(rowPage, contentLines, {
    ...options,
    isDatabaseItem: true,
  });
}

export function normalizeDatabaseRow(rowPage, contentLines = [], options = {}) {
  return normalizeNotionPage(rowPage, contentLines, {
    ...options,
    isDatabaseItem: true,
  });
}
