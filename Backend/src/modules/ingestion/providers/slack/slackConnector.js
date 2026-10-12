/**
 * @file slackConnector.js
 * @description High-level Slack Ingestion Connector conforming to the shared BaseConnector contract.
 *
 * Orchestrates fetching messages from configured Slack channels, retrieving thread
 * replies where authorized, handling cursor-based pagination, and mapping records
 * into canonical SourceRecord / SourceRecordCandidate schemas.
 */

import { BaseConnector } from '../../../../integrations/common/connector.js';
import { createSyncResult, SYNC_STATUS } from '../../../../integrations/common/results.js';
import { normalizeProviderError } from '../../../../integrations/common/errors.js';
import { SlackClient } from './slackClient.js';
import { normalizeSlackMessage, normalizeSlackMessageCandidate } from './slackNormalizer.js';
import { SlackAuthenticationError, SlackValidationError } from './slackErrors.js';
import { validateSourceRecord } from '../../../../integrations/common/types.js';

export class SlackConnector extends BaseConnector {
  /**
   * @param {object} [config={}]
   * @param {SlackClient} [config.client] Custom or preconfigured Slack client
   * @param {string} [config.token] Slack API Bot or User token
   * @param {string} [config.teamDomain] Configured workspace subdomain
   * @param {typeof fetch} [config.fetchFn] Injected fetch implementation
   */
  constructor({ client, token, teamDomain, fetchFn, ...clientOptions } = {}) {
    super();
    if (!client) {
      const resolvedToken = token !== undefined
        ? token
        : (process.env.SLACK_BOT_TOKEN || process.env.SLACK_TOKEN);

      if (!resolvedToken || typeof resolvedToken !== 'string' || !resolvedToken.trim()) {
        throw new SlackAuthenticationError(
          'SLACK_BOT_TOKEN is required. Please provide it in options or set SLACK_BOT_TOKEN in environment.',
          { code: 'SLACK_TOKEN_MISSING' }
        );
      }
    }

    this.client = client || new SlackClient({ token, fetchFn, ...clientOptions });
    this.teamDomain = teamDomain || process.env.SLACK_WORKSPACE_DOMAIN || '';
  }

  /**
   * Identifies the external provider.
   * @returns {string}
   */
  get provider() {
    return 'slack';
  }

  /**
   * Validates configuration credentials and required settings.
   *
   * @param {object} [config={}]
   * @returns {{ valid: boolean, errors: string[] }}
   */
  static validateConfig(config = {}) {
    const token = config.token !== undefined
      ? config.token
      : (process.env.SLACK_BOT_TOKEN || process.env.SLACK_TOKEN);

    const errors = [];
    if (!token || typeof token !== 'string' || !token.trim()) {
      errors.push('SLACK_BOT_TOKEN (or SLACK_TOKEN) is required.');
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
    return SlackConnector.validateConfig(config);
  }

  /**
   * Verifies credentials and connectivity by contacting the Slack Web API.
   *
   * @returns {Promise<{ ok: boolean, error?: string, details?: object }>}
   */
  async verifyConnection() {
    try {
      const auth = typeof this.client.authTest === 'function'
        ? await this.client.authTest()
        : typeof this.client.testAuth === 'function'
          ? await this.client.testAuth()
          : await this.client._request('auth.test', { method: 'POST' });
      return {
        ok: true,
        details: {
          user: auth?.user,
          userId: auth?.user_id,
          team: auth?.team,
          teamId: auth?.team_id,
        },
      };
    } catch (err) {
      const normalized = normalizeProviderError(err, 'slack');
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
   * Performs an authorized sync of Slack messages returning a standardized SyncResult.
   *
   * @param {object} [options={}]
   * @param {string} [options.channelId] - Single channel identifier
   * @param {string[]} [options.channelIds=[]] - Array of channel identifiers
   * @param {string} [options.projectId='default-project'] - Target Relay project identifier
   * @param {number} [options.maxPages=5] - Maximum pagination pages per channel
   * @param {number} [options.perPage=100] - Messages per page
   * @param {boolean} [options.includeThreads=false] - Whether to fetch thread replies
   * @param {boolean} [options.asCandidate=true] - Return SourceRecordCandidate by default
   * @returns {Promise<import('../../../../integrations/common/results.js').SyncResult>}
   */
  async sync({
    channelId,
    channelIds = [],
    projectId = 'default-project',
    maxPages = 5,
    perPage = 100,
    includeThreads = false,
    asCandidate = true,
  } = {}) {
    const records = [];
    const errors = [];
    let hasMore = false;
    let nextCursor = null;

    try {
      let targets = [];
      if (channelId && typeof channelId === 'string' && channelId.trim()) {
        targets.push(channelId.trim());
      }
      if (Array.isArray(channelIds)) {
        for (const id of channelIds) {
          if (id && typeof id === 'string' && !targets.includes(id.trim())) {
            targets.push(id.trim());
          }
        }
      }

      // If no channels specified, attempt to discover member channels
      if (targets.length === 0) {
        try {
          const channels = await this.getChannels();
          const joined = channels.filter((c) => c.is_member).map((c) => c.id);
          targets = joined.length > 0 ? joined : channels.slice(0, 3).map((c) => c.id);
        } catch (discErr) {
          errors.push(normalizeProviderError(discErr, 'slack'));
        }
      }

      for (const targetChan of targets) {
        try {
          const chanRecords = await this.fetchMessages({
            channelId: targetChan,
            projectId,
            maxPages,
            perPage,
            includeThreads,
            asCandidate,
          });
          records.push(...chanRecords);
        } catch (chanErr) {
          errors.push(normalizeProviderError(chanErr, 'slack'));
        }
      }
    } catch (fatalErr) {
      errors.push(normalizeProviderError(fatalErr, 'slack'));
    }

    return createSyncResult({
      provider: 'slack',
      records,
      recordsProcessed: records.length,
      errors,
      cursor: nextCursor,
      hasMore,
      metadata: {
        projectId,
        includeThreads,
      },
    });
  }

  /**
   * Fetches messages from a configured channel with cursor-based pagination.
   * 
   * @param {object} options
   * @param {string} options.channelId - Required channel identifier (e.g. 'C12345')
   * @param {string} [options.channelName] - Optional channel name for display (e.g. 'general')
   * @param {string} [options.projectId='default-project'] - Target Relay project identifier
   * @param {number} [options.maxPages=5] - Maximum pagination pages to retrieve
   * @param {number} [options.perPage=100] - Results per page limit
   * @param {boolean} [options.includeThreads=false] - Whether to fetch replies for thread parents
   * @param {boolean} [options.fetchAll=false] - Whether to ignore maxPages and fetch all available
   * @param {boolean} [options.asCandidate=false] - Return SourceRecordCandidate instead of SourceRecord
   * @returns {Promise<Array<import('../../../../integrations/common/types.js').SourceRecord>>}
   */
  async fetchMessages({
    channelId,
    channelName,
    projectId = 'default-project',
    maxPages = 5,
    perPage = 100,
    includeThreads = false,
    fetchAll = false,
    asCandidate = false,
  } = {}) {
    if (!channelId || typeof channelId !== 'string' || !channelId.trim()) {
      throw new SlackValidationError('A valid non-empty "channelId" is required to fetch messages.');
    }

    const cleanChannelId = channelId.trim();
    let currentCursor = undefined;
    let pagesFetched = 0;
    const allRecords = [];

    while (true) {
      if (!fetchAll && pagesFetched >= maxPages) {
        break;
      }

      const response = await this.client.getConversationHistory(cleanChannelId, {
        cursor: currentCursor,
        limit: perPage,
      });

      const messages = Array.isArray(response?.messages) ? response.messages : [];

      for (const msg of messages) {
        const context = {
          projectId,
          channelId: cleanChannelId,
          channelName,
          teamDomain: this.teamDomain,
          fetchedAt: new Date(),
        };

        const record = asCandidate
          ? normalizeSlackMessageCandidate(msg, context)
          : normalizeSlackMessage(msg, context);

        allRecords.push(record);

        // Fetch thread replies if requested and message has replies
        if (includeThreads && msg.reply_count && msg.reply_count > 0) {
          const replies = await this.fetchThreadReplies(cleanChannelId, msg.ts, {
            projectId,
            channelName,
            asCandidate,
          });
          // Replies include parent message as first item; skip parent to avoid duplicate
          const childReplies = replies.filter((r) => r.metadata?.ts !== msg.ts);
          allRecords.push(...childReplies);
        }
      }

      pagesFetched += 1;
      currentCursor = response?.response_metadata?.next_cursor;

      if (!response?.has_more || !currentCursor) {
        break;
      }
    }

    return allRecords;
  }

  /**
   * Fetches replies within a message thread.
   * 
   * @param {string} channelId
   * @param {string} threadTs
   * @param {object} [options={}]
   * @param {string} [options.channelName]
   * @param {string} [options.projectId='default-project']
   * @param {boolean} [options.asCandidate=false]
   * @returns {Promise<Array<import('../../../../integrations/common/types.js').SourceRecord>>}
   */
  async fetchThreadReplies(channelId, threadTs, {
    channelName,
    projectId = 'default-project',
    asCandidate = false,
  } = {}) {
    if (!channelId || !threadTs) {
      throw new SlackValidationError('channelId and threadTs are required to fetch thread replies.');
    }

    const response = await this.client.getConversationReplies(channelId, threadTs);
    const messages = Array.isArray(response?.messages) ? response.messages : [];

    return messages.map((msg) => {
      const context = {
        projectId,
        channelId,
        channelName,
        teamDomain: this.teamDomain,
        fetchedAt: new Date(),
      };
      return asCandidate
        ? normalizeSlackMessageCandidate(msg, context)
        : normalizeSlackMessage(msg, context);
    });
  }

  /**
   * Lists channels accessible by the bot.
   * 
   * @param {object} [options={}]
   * @returns {Promise<Array<{ id: string, name: string, is_private: boolean, is_member: boolean }>>}
   */
  async getChannels(options = {}) {
    const response = await this.client.getChannels(options);
    const rawChannels = Array.isArray(response?.channels) ? response.channels : [];
    return rawChannels.map((c) => ({
      id: c.id,
      name: c.name,
      is_private: Boolean(c.is_private),
      is_member: Boolean(c.is_member),
    }));
  }
}
