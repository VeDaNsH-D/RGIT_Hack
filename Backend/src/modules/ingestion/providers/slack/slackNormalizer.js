/**
 * @file slackNormalizer.js
 * @description Pure normalization functions mapping Slack messages and thread replies
 * into canonical SourceRecordCandidate and SourceRecord contracts.
 *
 * Implements strict data normalization rules:
 * - Pure functions: never mutates raw message objects
 * - Preserves provenance: channel identifiers, message ts, thread references, permalinks
 * - Honest attribution: never fabricates missing author identities, timestamps, or URLs
 * - Safe content: extracts text/mrkdwn without treating message bodies as instructions
 * - Validated against both validateSourceRecordCandidate and validateSourceRecord
 */

import {
  SOURCE_PROVIDERS,
  SOURCE_RECORD_TYPES,
  SOURCE_CONTENT_TYPES,
  validateSourceRecordCandidate,
} from '../../contracts/sourceRecord.js';
import {
  RECORD_TYPES,
  SOURCE_PROVIDERS as COMMON_SOURCE_PROVIDERS,
  validateSourceRecord,
} from '../../../../integrations/common/types.js';
import {
  extractMessageText,
  parseSlackTs,
  constructMessageUrl,
} from './slackExtractor.js';
import { SlackValidationError } from './slackErrors.js';

/**
 * Normalizes a raw Slack message into an agreed SourceRecordCandidate.
 * 
 * @param {object} message - Raw Slack message object
 * @param {object} [context={}] - Ingestion context options
 * @param {string} [context.projectId='default-project'] - Relay project identifier
 * @param {string} context.channelId - Required Slack channel ID
 * @param {string} [context.channelName] - Slack channel name (e.g. 'general')
 * @param {string} [context.teamDomain] - Slack workspace domain
 * @param {string} [context.teamId] - Slack team ID
 * @param {Date} [context.fetchedAt] - Ingestion batch timestamp
 * @param {string} [context.recordType] - Specific recordType override
 * @returns {import('../../contracts/sourceRecord.js').SourceRecordCandidate}
 */
export function normalizeSlackMessageCandidate(message, context = {}) {
  if (!message || typeof message !== 'object') {
    throw new SlackValidationError('Slack message entity must be a non-null object.');
  }

  const channelId = context.channelId || message.channel;
  if (!channelId || typeof channelId !== 'string' || !channelId.trim()) {
    throw new SlackValidationError('Normalization requires a non-empty string "channelId".');
  }

  const rawTs = message.ts ? String(message.ts).trim() : '';
  if (!rawTs) {
    throw new SlackValidationError('Slack message is missing required timestamp "ts".');
  }

  const projectId = (context.projectId && String(context.projectId).trim()) || 'default-project';
  const externalId = `${channelId.trim()}:${rawTs}`;

  // Safe text extraction
  const content = extractMessageText(message);

  // Generate concise title preview
  const channelDisplay = context.channelName ? `#${context.channelName}` : channelId;
  const firstLine = content.split('\n')[0].trim();
  const title = firstLine
    ? `[${channelDisplay}] ${firstLine.slice(0, 80)}${firstLine.length > 80 ? '...' : ''}`
    : `[${channelDisplay}] Message by @${message.user || message.bot_id || 'system'}`;

  // Timestamps
  const createdAt = parseSlackTs(rawTs);
  const updatedAt = message.edited ? parseSlackTs(message.edited.ts) : undefined;
  const fetchedAt = context.fetchedAt instanceof Date && !Number.isNaN(context.fetchedAt.getTime())
    ? context.fetchedAt
    : new Date();

  // Author provenance (strictly no fabrication)
  const author = message.user || message.bot_id || undefined;
  const authorId = message.user || message.bot_id || undefined;

  // Source URL
  const url = constructMessageUrl({
    channelId,
    ts: rawTs,
    teamDomain: context.teamDomain,
    permalink: message.permalink,
  });

  // Thread metadata
  const isThreadParent = Boolean(message.reply_count && message.reply_count > 0);
  const isReply = Boolean(message.thread_ts && message.thread_ts !== rawTs);

  const metadata = {
    channelId,
    channelName: context.channelName || null,
    ts: rawTs,
    threadTs: message.thread_ts || null,
    isThreadParent,
    isReply,
    replyCount: message.reply_count || 0,
    replyUsersCount: message.reply_users_count || 0,
    reactions: Array.isArray(message.reactions)
      ? message.reactions.map((r) => ({ name: r.name, count: r.count, users: r.users || [] }))
      : [],
    subtype: message.subtype || null,
    teamId: context.teamId || message.team || null,
    sourceUrl: url || null,
  };

  const resolvedType = context.recordType || SOURCE_RECORD_TYPES.NOTE;

  /** @type {import('../../contracts/sourceRecord.js').SourceRecordCandidate} */
  const candidate = {
    projectId,
    provider: SOURCE_PROVIDERS.SLACK,
    recordType: resolvedType,
    externalId,
    title,
    content,
    contentType: SOURCE_CONTENT_TYPES.MARKDOWN,
    url,
    author,
    authorId,
    createdAt,
    updatedAt,
    fetchedAt,
    version: 1,
    isActive: true,
    isDeleted: message.subtype === 'message_deleted',
    metadata,
  };

  const validation = validateSourceRecordCandidate(candidate);
  if (!validation.valid) {
    throw new SlackValidationError(
      `Normalized Slack message failed SourceRecordCandidate validation: ${validation.errors.join('; ')}`,
      { data: validation.errors }
    );
  }

  return candidate;
}

/**
 * Normalizes a Slack message into a canonical SourceRecord adhering to validateSourceRecord.
 * 
 * @param {object} message - Raw Slack message object
 * @param {object} [context={}]
 * @returns {import('../../../../integrations/common/types.js').SourceRecord}
 */
export function normalizeSlackMessage(message, context = {}) {
  const candidate = normalizeSlackMessageCandidate(message, context);
  const cleanExternalId = candidate.externalId.replace(/[:.]/g, '_');
  const id = `src_slack_${cleanExternalId}`;
  const nowIso = candidate.fetchedAt.toISOString();

  /** @type {import('../../../../integrations/common/types.js').SourceRecord} */
  const record = {
    id,
    projectId: candidate.projectId,
    provider: COMMON_SOURCE_PROVIDERS.SLACK,
    externalId: candidate.externalId,
    type: RECORD_TYPES.NOTE,
    recordType: RECORD_TYPES.NOTE,
    title: candidate.title,
    content: candidate.content,
    url: candidate.url,
    author: candidate.author,
    authorId: candidate.authorId,
    observedAt: candidate.updatedAt ? candidate.updatedAt.toISOString() : (candidate.createdAt ? candidate.createdAt.toISOString() : undefined),
    createdAt: candidate.createdAt ? candidate.createdAt.toISOString() : undefined,
    updatedAt: candidate.updatedAt ? candidate.updatedAt.toISOString() : undefined,
    fetchedAt: nowIso,
    metadata: candidate.metadata,
  };

  const validation = validateSourceRecord(record);
  if (!validation.valid) {
    throw new SlackValidationError(
      `Normalized Slack message failed SourceRecord validation: ${validation.errors.join('; ')}`,
      { data: validation.errors }
    );
  }

  return record;
}
