import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SlackConnector,
  SlackClient,
  SlackError,
  SlackClientError,
  SlackAuthenticationError,
  SlackPermissionError,
  SlackRateLimitError,
  SlackNotFoundError,
  SlackValidationError,
  formatSlackText,
  extractTextFromBlocks,
  extractMessageText,
  parseSlackTs,
  constructMessageUrl,
  normalizeSlackMessage,
  normalizeSlackMessageCandidate,
} from '../../src/integrations/slack/index.js';

import {
  SOURCE_PROVIDERS,
  RECORD_TYPES,
  validateSourceRecord,
  assertValidSourceRecord,
} from '../../src/integrations/common/types.js';

import {
  validateSourceRecordCandidate,
} from '../../src/modules/ingestion/contracts/sourceRecord.js';

/**
 * Helper to create mock Response object matching fetch API
 */
function createMockResponse(body, { status = 200, headers = {} } = {}) {
  const isString = typeof body === 'string';
  const responseBody = isString ? body : JSON.stringify(body);
  const responseHeaders = new Headers({
    'content-type': isString ? 'text/plain' : 'application/json',
    ...headers,
  });

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `Status ${status}`,
    headers: responseHeaders,
    async json() {
      if (isString) {
        throw new SyntaxError('Unexpected token in JSON');
      }
      return body;
    },
    async text() {
      return responseBody;
    },
  };
}

describe('Slack Integration Suite', () => {
  const TEST_TOKEN = 'xoxb-test-mock-token-12345';
  const TEST_CHANNEL_ID = 'C0123456789';
  const TEST_CHANNEL_NAME = 'project-relay';
  const TEST_DOMAIN = 'relay-workspace';

  const SAMPLE_PARENT_MESSAGE = {
    type: 'message',
    user: 'U0123ABC',
    text: 'Hello team! Check <https://github.com/relay|Relay Repo> and <@U0456DEF|bob>. <!here> updates ready.',
    ts: '1728734400.123456',
    team: 'T0987XYZ',
    reply_count: 2,
    reply_users_count: 2,
    latest_reply: '1728734500.654321',
    reactions: [
      { name: 'rocket', count: 3, users: ['U0123ABC', 'U0456DEF'] },
    ],
  };

  const SAMPLE_REPLY_MESSAGE = {
    type: 'message',
    user: 'U0456DEF',
    text: 'Looks great! Approved from my side.',
    ts: '1728734500.654321',
    thread_ts: '1728734400.123456',
    parent_user_id: 'U0123ABC',
  };

  // =========================================================================
  // 1. Successful Message Retrieval
  // =========================================================================
  describe('1. Successful Message Retrieval', () => {
    it('should retrieve channel messages and normalize into valid SourceRecord', async () => {
      const mockFetch = async (url) => {
        assert.ok(url.includes('conversations.history'));
        assert.ok(url.includes(`channel=${TEST_CHANNEL_ID}`));
        return createMockResponse({
          ok: true,
          messages: [SAMPLE_PARENT_MESSAGE],
          has_more: false,
        });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        teamDomain: TEST_DOMAIN,
        fetchFn: mockFetch,
      });

      const records = await connector.fetchMessages({
        channelId: TEST_CHANNEL_ID,
        channelName: TEST_CHANNEL_NAME,
        projectId: 'project-relay-id',
      });

      assert.equal(records.length, 1);
      const record = records[0];

      assert.equal(record.id, `src_slack_${TEST_CHANNEL_ID}_1728734400_123456`);
      assert.equal(record.provider, SOURCE_PROVIDERS.SLACK);
      assert.equal(record.recordType, RECORD_TYPES.NOTE);
      assert.equal(record.externalId, `${TEST_CHANNEL_ID}:1728734400.123456`);
      assert.equal(record.author, 'U0123ABC');
      assert.equal(record.authorId, 'U0123ABC');
      assert.ok(record.content.includes('[Relay Repo](https://github.com/relay)'));
      assert.ok(record.content.includes('@bob'));
      assert.ok(record.content.includes('@here'));
      assert.equal(record.url, `https://${TEST_DOMAIN}.slack.com/archives/${TEST_CHANNEL_ID}/p1728734400123456`);

      assertValidSourceRecord(record);
    });

    it('should retrieve authorized channel listings', async () => {
      const mockFetch = async (url) => {
        assert.ok(url.includes('conversations.list'));
        return createMockResponse({
          ok: true,
          channels: [
            { id: 'C01', name: 'general', is_private: false, is_member: true },
            { id: 'C02', name: 'dev-team', is_private: true, is_member: true },
          ],
        });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
      });

      const channels = await connector.getChannels();
      assert.equal(channels.length, 2);
      assert.equal(channels[0].name, 'general');
      assert.equal(channels[1].is_private, true);
    });
  });

  // =========================================================================
  // 2. Pagination Handling
  // =========================================================================
  describe('2. Pagination Handling', () => {
    it('should paginate messages using next_cursor', async () => {
      const calls = [];
      const mockFetch = async (url) => {
        calls.push(url);
        if (url.includes('cursor=cursor_page_2')) {
          return createMockResponse({
            ok: true,
            messages: [{ ...SAMPLE_PARENT_MESSAGE, ts: '1728734600.000002' }],
            has_more: false,
            response_metadata: { next_cursor: '' },
          });
        }
        return createMockResponse({
          ok: true,
          messages: [{ ...SAMPLE_PARENT_MESSAGE, ts: '1728734600.000001' }],
          has_more: true,
          response_metadata: { next_cursor: 'cursor_page_2' },
        });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
      });

      const records = await connector.fetchMessages({
        channelId: TEST_CHANNEL_ID,
        perPage: 1,
        maxPages: 5,
      });

      assert.equal(records.length, 2);
      assert.equal(calls.length, 2);
      assert.ok(calls[1].includes('cursor=cursor_page_2'));
    });

    it('should respect maxPages limit to avoid unconstrained retrieval', async () => {
      let pageCount = 0;
      const mockFetch = async () => {
        pageCount += 1;
        return createMockResponse({
          ok: true,
          messages: [{ ...SAMPLE_PARENT_MESSAGE, ts: `1728734700.00000${pageCount}` }],
          has_more: true,
          response_metadata: { next_cursor: `next_cursor_${pageCount}` },
        });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
      });

      const records = await connector.fetchMessages({
        channelId: TEST_CHANNEL_ID,
        maxPages: 2,
      });

      assert.equal(records.length, 2);
      assert.equal(pageCount, 2);
    });
  });

  // =========================================================================
  // 3. Thread Replies
  // =========================================================================
  describe('3. Thread Replies', () => {
    it('should fetch thread replies and link to parent message without duplicating parent', async () => {
      const mockFetch = async (url) => {
        if (url.includes('conversations.history')) {
          return createMockResponse({
            ok: true,
            messages: [SAMPLE_PARENT_MESSAGE],
            has_more: false,
          });
        }
        if (url.includes('conversations.replies')) {
          assert.ok(url.includes(`ts=${SAMPLE_PARENT_MESSAGE.ts}`));
          return createMockResponse({
            ok: true,
            // Slack returns parent message as item 0 in conversations.replies
            messages: [SAMPLE_PARENT_MESSAGE, SAMPLE_REPLY_MESSAGE],
            has_more: false,
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
      });

      const records = await connector.fetchMessages({
        channelId: TEST_CHANNEL_ID,
        includeThreads: true,
      });

      // Should contain 2 total records: parent and reply (no duplicated parent)
      assert.equal(records.length, 2);
      const parentRecord = records[0];
      const replyRecord = records[1];

      assert.equal(parentRecord.metadata.isThreadParent, true);
      assert.equal(parentRecord.metadata.isReply, false);
      assert.equal(parentRecord.metadata.replyCount, 2);

      assert.equal(replyRecord.metadata.isReply, true);
      assert.equal(replyRecord.metadata.threadTs, SAMPLE_PARENT_MESSAGE.ts);
      assert.equal(replyRecord.author, 'U0456DEF');
      assert.ok(replyRecord.content.includes('Looks great! Approved from my side.'));
    });
  });

  // =========================================================================
  // 4. Channel Selection and Permission Boundaries
  // =========================================================================
  describe('4. Channel Selection and Permission Boundaries', () => {
    it('should throw SlackValidationError when channelId is missing', async () => {
      const connector = new SlackConnector({ token: TEST_TOKEN });
      await assert.rejects(
        () => connector.fetchMessages({ channelId: '' }),
        (err) => {
          assert.ok(err instanceof SlackValidationError);
          assert.ok(err.message.includes('channelId'));
          return true;
        }
      );
    });

    it('should throw SlackPermissionError when bot is not in private channel', async () => {
      const mockFetch = async () => {
        return createMockResponse({ ok: false, error: 'not_in_channel' });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 1 },
      });

      await assert.rejects(
        () => connector.fetchMessages({ channelId: 'C_PRIVATE' }),
        (err) => {
          assert.ok(err instanceof SlackPermissionError);
          assert.equal(err.code, 'not_in_channel');
          assert.equal(err.statusCode, 403);
          return true;
        }
      );
    });

    it('should throw SlackNotFoundError when channel does not exist', async () => {
      const mockFetch = async () => {
        return createMockResponse({ ok: false, error: 'channel_not_found' });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 1 },
      });

      await assert.rejects(
        () => connector.fetchMessages({ channelId: 'C_NONEXISTENT' }),
        (err) => {
          assert.ok(err instanceof SlackNotFoundError);
          assert.equal(err.code, 'channel_not_found');
          assert.equal(err.statusCode, 404);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 5. Normalization and Contract Adherence
  // =========================================================================
  describe('5. Normalization and Contract Adherence', () => {
    it('should validate against canonical SourceRecordCandidate and SourceRecord contracts', () => {
      const candidate = normalizeSlackMessageCandidate(SAMPLE_PARENT_MESSAGE, {
        channelId: TEST_CHANNEL_ID,
        channelName: TEST_CHANNEL_NAME,
        teamDomain: TEST_DOMAIN,
        projectId: 'project-123',
      });

      const candidateVal = validateSourceRecordCandidate(candidate);
      assert.equal(candidateVal.valid, true, candidateVal.errors.join('; '));
      assert.equal(candidate.provider, 'slack');
      assert.equal(candidate.recordType, 'note');
      assert.equal(candidate.externalId, `${TEST_CHANNEL_ID}:${SAMPLE_PARENT_MESSAGE.ts}`);

      const fullRecord = normalizeSlackMessage(SAMPLE_PARENT_MESSAGE, {
        channelId: TEST_CHANNEL_ID,
        channelName: TEST_CHANNEL_NAME,
        teamDomain: TEST_DOMAIN,
        projectId: 'project-123',
      });

      const recordVal = validateSourceRecord(fullRecord);
      assert.equal(recordVal.valid, true, recordVal.errors.join('; '));
      assert.equal(fullRecord.provider, 'slack');
    });

    it('should accurately parse timestamps without loss of resolution', () => {
      const tsDate = parseSlackTs('1728734400.123456');
      assert.ok(tsDate instanceof Date);
      assert.equal(parseSlackTs(null), undefined);
      assert.equal(parseSlackTs('invalid'), undefined);
    });
  });

  // =========================================================================
  // 6. Empty Messages and Block Content
  // =========================================================================
  describe('6. Empty Messages and Block Content', () => {
    it('should extract text from Block Kit elements when top-level text is empty', () => {
      const blockMessage = {
        type: 'message',
        ts: '1728734400.999999',
        user: 'U_BLOCKS',
        text: '',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Section text with <https://example.com|Link>' },
          },
        ],
      };

      const record = normalizeSlackMessage(blockMessage, { channelId: TEST_CHANNEL_ID });
      assert.equal(record.content, 'Section text with [Link](https://example.com)');
      assertValidSourceRecord(record);
    });

    it('should handle empty or subtype messages gracefully without throwing', () => {
      const systemMessage = {
        type: 'message',
        subtype: 'channel_join',
        ts: '1728734400.000000',
        user: 'U_NEW',
        text: '',
      };

      const record = normalizeSlackMessage(systemMessage, { channelId: TEST_CHANNEL_ID });
      assert.equal(record.content, '');
      assert.equal(record.metadata.subtype, 'channel_join');
      assertValidSourceRecord(record);
    });
  });

  // =========================================================================
  // 7. Missing Credentials
  // =========================================================================
  describe('7. Missing Credentials', () => {
    it('should throw SlackAuthenticationError when token is missing', () => {
      assert.throws(
        () => new SlackConnector({ token: '' }),
        (err) => {
          assert.ok(err instanceof SlackAuthenticationError);
          assert.equal(err.statusCode, 401);
          assert.ok(err.message.includes('SLACK_BOT_TOKEN is required'));
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 8. Insufficient Scopes and Revoked Access
  // =========================================================================
  describe('8. Insufficient Scopes and Revoked Access', () => {
    it('should throw SlackPermissionError on missing_scope without retrying indefinitely', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount += 1;
        return createMockResponse({
          ok: false,
          error: 'missing_scope',
          needed: 'channels:history',
        });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 3 },
      });

      await assert.rejects(
        () => connector.fetchMessages({ channelId: TEST_CHANNEL_ID }),
        (err) => {
          assert.ok(err instanceof SlackPermissionError);
          assert.equal(err.code, 'missing_scope');
          assert.ok(err.message.includes('channels:history'));
          return true;
        }
      );

      // Permanent failure must fail-fast without retry loops
      assert.equal(callCount, 1);
    });

    it('should throw SlackAuthenticationError on token_revoked or invalid_auth', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount += 1;
        return createMockResponse({ ok: false, error: 'token_revoked' });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 3 },
      });

      await assert.rejects(
        () => connector.fetchMessages({ channelId: TEST_CHANNEL_ID }),
        (err) => {
          assert.ok(err instanceof SlackAuthenticationError);
          assert.equal(err.code, 'token_revoked');
          return true;
        }
      );

      assert.equal(callCount, 1);
    });
  });

  // =========================================================================
  // 9. Rate Limits and Transient Errors
  // =========================================================================
  describe('9. Rate Limits and Transient Errors', () => {
    it('should retry on HTTP 429 rate limit and succeed when subsequent call succeeds', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount += 1;
        if (callCount === 1) {
          return createMockResponse('Rate limit exceeded', {
            status: 429,
            headers: { 'Retry-After': '0' },
          });
        }
        return createMockResponse({
          ok: true,
          messages: [SAMPLE_PARENT_MESSAGE],
          has_more: false,
        });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 3, initialDelayMs: 1 },
      });

      const records = await connector.fetchMessages({ channelId: TEST_CHANNEL_ID });
      assert.equal(records.length, 1);
      assert.equal(callCount, 2);
    });

    it('should retry on ratelimited Slack payload error and succeed', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount += 1;
        if (callCount === 1) {
          return createMockResponse(
            { ok: false, error: 'ratelimited' },
            { headers: { 'Retry-After': '0' } }
          );
        }
        return createMockResponse({
          ok: true,
          messages: [SAMPLE_PARENT_MESSAGE],
          has_more: false,
        });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 3, initialDelayMs: 1 },
      });

      const records = await connector.fetchMessages({ channelId: TEST_CHANNEL_ID });
      assert.equal(records.length, 1);
      assert.equal(callCount, 2);
    });

    it('should throw SlackRateLimitError when retries are exhausted on rate limit', async () => {
      const mockFetch = async () => {
        return createMockResponse('Rate limit exceeded', {
          status: 429,
          headers: { 'Retry-After': '1' },
        });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 2, initialDelayMs: 1 },
      });

      await assert.rejects(
        () => connector.fetchMessages({ channelId: TEST_CHANNEL_ID }),
        (err) => {
          assert.ok(err instanceof SlackRateLimitError);
          assert.equal(err.statusCode, 429);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 10. Malformed Responses
  // =========================================================================
  describe('10. Malformed Responses', () => {
    it('should handle non-JSON HTML error responses gracefully without raw JSON parse crash', async () => {
      const mockFetch = async () => {
        return createMockResponse('<html><body>502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 1 },
      });

      await assert.rejects(
        () => connector.fetchMessages({ channelId: TEST_CHANNEL_ID }),
        (err) => {
          assert.ok(err instanceof SlackClientError);
          assert.equal(err.statusCode, 502);
          return true;
        }
      );
    });
  });

  // =========================================================================
  describe('11. Connection Verification & authTest', () => {
    it('should verify connection successfully when auth.test succeeds', async () => {
      const mockFetch = async (url) => {
        if (url.includes('auth.test')) {
          return createMockResponse({
            ok: true,
            url: 'https://relay-team.slack.com/',
            team: 'Relay Team',
            user: 'relay_bot',
            team_id: 'T12345',
            user_id: 'U12345',
          });
        }
        return createMockResponse({ ok: false, error: 'unknown_endpoint' }, { status: 404 });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
      });

      const result = await connector.verifyConnection();
      assert.equal(result.ok, true);
      assert.equal(result.details.team, 'Relay Team');
      assert.equal(result.details.teamId, 'T12345');
      assert.equal(result.details.user, 'relay_bot');
      assert.equal(result.details.userId, 'U12345');
    });

    it('should return ok: false with error details when auth.test fails', async () => {
      const mockFetch = async () => {
        return createMockResponse({ ok: false, error: 'invalid_auth' });
      };

      const connector = new SlackConnector({
        token: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 1 },
      });

      const result = await connector.verifyConnection();
      assert.equal(result.ok, false);
      assert.ok(result.error);
    });
  });
});
