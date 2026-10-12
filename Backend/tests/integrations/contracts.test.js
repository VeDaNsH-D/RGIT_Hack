/**
 * @file contracts.test.js
 * @description Contract test suite validating standardized external integration behavior
 * across Notion, Jira, and Slack connectors against the shared BaseConnector contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BaseConnector,
  isConnector,
} from '../../src/integrations/common/connector.js';

import {
  IntegrationError,
  IntegrationAuthenticationError,
  IntegrationPermissionError,
  IntegrationRateLimitError,
  IntegrationNotFoundError,
  IntegrationNetworkError,
  IntegrationResponseError,
  IntegrationValidationError,
  sanitizeErrorMessage,
  normalizeProviderError,
} from '../../src/integrations/common/errors.js';

import {
  createSyncResult,
  SYNC_STATUS,
} from '../../src/integrations/common/results.js';

import { NotionConnector } from '../../src/modules/ingestion/providers/notion/notionConnector.js';
import { JiraConnector } from '../../src/modules/ingestion/providers/jira/jiraConnector.js';
import { SlackConnector } from '../../src/modules/ingestion/providers/slack/slackConnector.js';

import {
  SOURCE_PROVIDERS,
  validateSourceRecordCandidate,
} from '../../src/modules/ingestion/contracts/sourceRecord.js';

describe('Task 8: Standardized External Integration Contracts', () => {

  describe('1. Common Connector Interface Conformance', () => {
    it('all three provider adapters must inherit from BaseConnector and satisfy isConnector()', () => {
      const mockFetch = async () => new Response('{}', { status: 200 });

      const notion = new NotionConnector({ apiKey: 'ntn_test_mock_token', fetchFn: mockFetch });
      const jira = new JiraConnector({ host: 'https://test.atlassian.net', apiToken: 'mock_token', fetchFn: mockFetch });
      const slack = new SlackConnector({ token: 'xoxb-mock-token', fetchFn: mockFetch });

      const adapters = [
        { name: 'notion', instance: notion, expectedProvider: 'notion' },
        { name: 'jira', instance: jira, expectedProvider: 'jira' },
        { name: 'slack', instance: slack, expectedProvider: 'slack' },
      ];

      for (const { name, instance, expectedProvider } of adapters) {
        assert.ok(instance instanceof BaseConnector, `${name} must inherit from BaseConnector`);
        assert.ok(isConnector(instance), `${name} must satisfy isConnector()`);
        assert.equal(instance.provider, expectedProvider);
        assert.equal(typeof instance.validateConfig, 'function');
        assert.equal(typeof instance.verifyConnection, 'function');
        assert.equal(typeof instance.sync, 'function');
      }
    });

    it('each adapter class provides static validateConfig() method', () => {
      assert.equal(typeof NotionConnector.validateConfig, 'function');
      assert.equal(typeof JiraConnector.validateConfig, 'function');
      assert.equal(typeof SlackConnector.validateConfig, 'function');

      assert.equal(NotionConnector.validateConfig({ apiKey: '' }).valid, false);
      assert.equal(NotionConnector.validateConfig({ apiKey: 'valid-key' }).valid, true);

      assert.equal(JiraConnector.validateConfig({ host: '', apiToken: '' }).valid, false);
      assert.equal(JiraConnector.validateConfig({ host: 'https://test.atlassian.net', apiToken: 'token' }).valid, true);

      assert.equal(SlackConnector.validateConfig({ token: '' }).valid, false);
      assert.equal(SlackConnector.validateConfig({ token: 'xoxb-token' }).valid, true);
    });
  });

  describe('2. Normalized Records & Provenance Preservation', () => {
    it('records preserve provider, externalId, source URL, and timestamps without fabricating values', async () => {
      // 1. Notion normalized record
      const mockNotionFetch = async (url) => {
        if (url.includes('/v1/pages/')) {
          return new Response(JSON.stringify({
            object: 'page',
            id: '12345678-1234-1234-1234-123456789abc',
            url: 'https://notion.so/my-workspace/page-12345678123412341234123456789abc',
            created_time: '2026-01-01T10:00:00.000Z',
            last_edited_time: '2026-01-02T10:00:00.000Z',
            properties: {
              title: { title: [{ plain_text: 'Notion Architecture' }] },
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ results: [], has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const notion = new NotionConnector({ apiKey: 'ntn_mock', fetchFn: mockNotionFetch });
      const notionCandidate = await notion.fetchPage('12345678-1234-1234-1234-123456789abc', { fetchContent: false });

      assert.equal(notionCandidate.provider, SOURCE_PROVIDERS.NOTION);
      assert.equal(notionCandidate.externalId, '12345678-1234-1234-1234-123456789abc');
      assert.equal(notionCandidate.url, 'https://notion.so/my-workspace/page-12345678123412341234123456789abc');
      assert.ok(notionCandidate.createdAt instanceof Date);
      assert.ok(notionCandidate.updatedAt instanceof Date);
      assert.ok(validateSourceRecordCandidate(notionCandidate).valid);

      // 2. Jira normalized record
      const mockJiraFetch = async () => new Response(JSON.stringify({
        id: '10001',
        key: 'RELAY-42',
        fields: {
          summary: 'Fix connector pagination',
          description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'pagination detail' }] }] },
          created: '2026-02-01T12:00:00.000Z',
          updated: '2026-02-02T14:00:00.000Z',
          status: { name: 'In Progress' },
          priority: { name: 'High' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });

      const jira = new JiraConnector({ host: 'https://test.atlassian.net', apiToken: 'token', fetchFn: mockJiraFetch });
      const jiraCandidate = await jira.fetchIssue('RELAY-42', { asCandidate: true });

      assert.equal(jiraCandidate.provider, SOURCE_PROVIDERS.JIRA);
      assert.equal(jiraCandidate.externalId, 'RELAY-42');
      assert.ok(jiraCandidate.url.includes('browse/RELAY-42'));
      assert.ok(jiraCandidate.createdAt instanceof Date);
      assert.ok(validateSourceRecordCandidate(jiraCandidate).valid);

      // 3. Slack normalized record
      const mockSlackFetch = async () => new Response(JSON.stringify({
        ok: true,
        messages: [{
          ts: '1700000000.000100',
          text: 'Design review discussion',
          user: 'U12345',
        }],
        has_more: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });

      const slack = new SlackConnector({ token: 'xoxb-mock', fetchFn: mockSlackFetch });
      const slackCandidates = await slack.fetchMessages({ channelId: 'C99999', asCandidate: true });

      assert.equal(slackCandidates.length, 1);
      assert.equal(slackCandidates[0].provider, SOURCE_PROVIDERS.SLACK);
      assert.equal(slackCandidates[0].externalId, 'C99999:1700000000.000100');
      assert.ok(slackCandidates[0].createdAt instanceof Date);
      assert.ok(validateSourceRecordCandidate(slackCandidates[0]).valid);
    });
  });

  describe('3. Successful, Empty, and Populated Sync States', () => {
    it('returns status empty when zero records are available and no errors occur', () => {
      const result = createSyncResult({
        provider: 'notion',
        records: [],
      });

      assert.equal(result.status, SYNC_STATUS.EMPTY);
      assert.equal(result.recordsProcessed, 0);
      assert.equal(result.records.length, 0);
      assert.equal(result.errors.length, 0);
      assert.equal(result.hasMore, false);
      assert.ok(typeof result.syncedAt === 'string');
    });

    it('returns status success when records are retrieved without errors', () => {
      const result = createSyncResult({
        provider: 'jira',
        records: [{ externalId: 'RELAY-1', title: 'Test 1' }, { externalId: 'RELAY-2', title: 'Test 2' }],
      });

      assert.equal(result.status, SYNC_STATUS.SUCCESS);
      assert.equal(result.recordsProcessed, 2);
      assert.equal(result.records.length, 2);
      assert.equal(result.errors.length, 0);
    });
  });

  describe('4. Partial Failures Are Never Reported as Complete Success', () => {
    it('coerces status to partial when errors array is non-empty and records exist', () => {
      const result = createSyncResult({
        provider: 'slack',
        status: 'success', // caller mistakenly passes 'success'
        records: [{ externalId: 'msg-1' }],
        errors: [new Error('Failed to fetch thread replies for msg-1')],
      });

      assert.equal(result.status, SYNC_STATUS.PARTIAL);
      assert.equal(result.records.length, 1);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].code, 'INTEGRATION_ERROR');
    });

    it('coerces status to failed when errors exist and zero records exist', () => {
      const result = createSyncResult({
        provider: 'notion',
        status: 'success',
        records: [],
        errors: [new IntegrationAuthenticationError('Unauthorized')],
      });

      assert.equal(result.status, SYNC_STATUS.FAILED);
      assert.equal(result.records.length, 0);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].statusCode, 401);
    });
  });

  describe('5. Consistent Authentication Error Mapping', () => {
    it('maps 401 and missing credential errors uniformly to IntegrationAuthenticationError', async () => {
      // Notion missing key
      assert.throws(
        () => new NotionConnector({ apiKey: '' }),
        (err) => err instanceof IntegrationAuthenticationError && err.statusCode === 401
      );

      // Jira missing token
      assert.throws(
        () => new JiraConnector({ host: 'https://test.atlassian.net', apiToken: '' }),
        (err) => err instanceof IntegrationAuthenticationError && err.statusCode === 401
      );

      // Slack missing token
      assert.throws(
        () => new SlackConnector({ token: '' }),
        (err) => err instanceof IntegrationAuthenticationError && err.statusCode === 401
      );

      // verifyConnection on 401 returns ok: false with normalized error
      const mock401Fetch = async () => new Response('{"message": "Unauthorized"}', { status: 401 });
      const notion = new NotionConnector({ apiKey: 'invalid_key', fetchFn: mock401Fetch });
      const verifyResult = await notion.verifyConnection();

      assert.equal(verifyResult.ok, false);
      assert.equal(verifyResult.details.statusCode, 401);
    });
  });

  describe('6. Provider-Specific Pagination Semantics', () => {
    it('handles Jira offset-based pagination and respects maxPages limit', async () => {
      let callCount = 0;
      const mockFetch = async (url) => {
        callCount += 1;
        const parsedUrl = new URL(url);
        const startAt = Number(parsedUrl.searchParams.get('startAt') || 0);

        return new Response(JSON.stringify({
          startAt,
          maxResults: 2,
          total: 10,
          issues: [
            { id: `id-${startAt + 1}`, key: `RELAY-${startAt + 1}`, fields: { summary: `Issue ${startAt + 1}`, created: '2026-01-01', updated: '2026-01-01' } },
            { id: `id-${startAt + 2}`, key: `RELAY-${startAt + 2}`, fields: { summary: `Issue ${startAt + 2}`, created: '2026-01-01', updated: '2026-01-01' } },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const jira = new JiraConnector({ host: 'https://test.atlassian.net', apiToken: 'token', fetchFn: mockFetch });
      const syncResult = await jira.sync({ maxPages: 2, perPage: 2 });

      assert.equal(callCount, 2);
      assert.equal(syncResult.records.length, 4);
      assert.equal(syncResult.hasMore, true);
      assert.equal(syncResult.cursor, 4);
    });

    it('handles Slack cursor-based pagination and terminates on has_more: false', async () => {
      let callCount = 0;
      const mockFetch = async (url) => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({
            ok: true,
            messages: [{ ts: '1000.1', text: 'first msg' }],
            has_more: true,
            response_metadata: { next_cursor: 'cursor_page_2' },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          ok: true,
          messages: [{ ts: '1000.2', text: 'second msg' }],
          has_more: false,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const slack = new SlackConnector({ token: 'xoxb-mock', fetchFn: mockFetch });
      const syncResult = await slack.sync({ channelId: 'C123', maxPages: 5 });

      assert.equal(callCount, 2);
      assert.equal(syncResult.records.length, 2);
      assert.equal(syncResult.status, SYNC_STATUS.SUCCESS);
    });
  });

  describe('7. Rate Limits and Transient Failure Mapping', () => {
    it('classifies 429 as IntegrationRateLimitError with isTransient=true and retryAfter', () => {
      const err = normalizeProviderError({
        status: 429,
        retryAfter: 15,
        message: 'Rate limit exceeded by provider',
      }, 'notion');

      assert.ok(err instanceof IntegrationRateLimitError);
      assert.equal(err.statusCode, 429);
      assert.equal(err.retryAfter, 15);
      assert.equal(err.isTransient, true);
      assert.equal(err.provider, 'notion');
    });

    it('classifies network timeouts and fetch failures as IntegrationNetworkError', () => {
      const networkErr = new TypeError('fetch failed');
      const normalized = normalizeProviderError(networkErr, 'jira');

      assert.ok(normalized instanceof IntegrationNetworkError);
      assert.equal(normalized.statusCode, 503);
      assert.equal(normalized.isTransient, true);
    });
  });

  describe('8. Malformed Provider Responses Fail Predictably', () => {
    it('maps HTML error bodies or SyntaxErrors into IntegrationResponseError', () => {
      const parseErr = new SyntaxError('Unexpected token < in JSON at position 0');
      const normalized = normalizeProviderError(parseErr, 'slack');

      assert.ok(normalized instanceof IntegrationResponseError);
      assert.equal(normalized.statusCode, 502);
      assert.equal(normalized.code, 'INVALID_PROVIDER_RESPONSE');
    });
  });

  describe('9. Credential Redaction and Safe Logging', () => {
    it('redacts tokens and secrets from error messages across all patterns', () => {
      const sensitiveMessages = [
        'Failed request with Authorization: Bearer secret_live_notion_xyz123',
        'Request failed at Basic dXNlcm5hbWU6cGFzc3dvcmQ=',
        'Slack error for token xoxb-1234567890-abcdef',
        'Jira error with token ATATT3xFfGF0example',
        'Connection refused at https://api.notion.com/v1/search?api_key=ntn_supersecret',
      ];

      for (const msg of sensitiveMessages) {
        const cleaned = sanitizeErrorMessage(msg);
        assert.ok(!cleaned.includes('secret_live_notion_xyz123'));
        assert.ok(!cleaned.includes('dXNlcm5hbWU6cGFzc3dvcmQ='));
        assert.ok(!cleaned.includes('xoxb-1234567890-abcdef'));
        assert.ok(!cleaned.includes('ATATT3xFfGF0example'));
        assert.ok(!cleaned.includes('ntn_supersecret'));
        assert.ok(cleaned.includes('[REDACTED]'));
      }
    });

    it('SyncResult serializes cleanly to JSON without leaking tokens or prototypes', () => {
      const result = createSyncResult({
        provider: 'notion',
        records: [],
        errors: [{
          code: 'UNAUTHORIZED',
          message: 'Failed with Bearer secret_12345abc',
        }],
      });

      const jsonString = JSON.stringify(result);
      assert.ok(!jsonString.includes('secret_12345abc'));
      assert.ok(jsonString.includes('[REDACTED]'));
    });
  });

});
