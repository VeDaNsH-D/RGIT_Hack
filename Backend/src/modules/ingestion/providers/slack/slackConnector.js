/**
 * @file slackConnector.js
 * @description High-level Slack Ingestion Connector.
 *
 * Orchestrates fetching messages from configured Slack channels, retrieving thread
 * replies where authorized, handling cursor-based pagination, and mapping records
 * into canonical SourceRecord / SourceRecordCandidate schemas.
 */

import { SlackClient } from './slackClient.js';
import { normalizeSlackMessage, normalizeSlackMessageCandidate } from './slackNormalizer.js';
import { SlackAuthenticationError, SlackValidationError } from './slackErrors.js';
import { validateSourceRecord } from '../../../../integrations/common/types.js';

export class SlackConnector {
  /**
   * @param {object} [config={}]
   * @param {SlackClient} [config.client] Custom or preconfigured Slack client
   * @param {string} [config.token] Slack API Bot or User token
   * @param {string} [config.teamDomain] Configured workspace subdomain
   * @param {typeof fetch} [config.fetchFn] Injected fetch implementation
   */
  constructor({ client, token, teamDomain, fetchFn, ...clientOptions } = {}) {
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
