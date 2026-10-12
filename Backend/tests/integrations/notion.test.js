import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NotionConnector,
  NotionClient,
  NotionError,
  NotionAuthenticationError,
  NotionPermissionError,
  NotionRateLimitError,
  NotionNotFoundError,
  extractRichText,
  extractPageTitle,
  formatBlockContent,
  extractProperties,
  extractBlockHierarchy,
  normalizeNotionPage,
  normalizeDatabaseRow,
  parseNotionId,
} from '../../src/integrations/notion/index.js';

import {
  SOURCE_PROVIDERS,
  RECORD_TYPES,
  validateSourceRecord,
  assertValidSourceRecord,
} from '../../src/integrations/common/types.js';

/**
 * Helper to create mock Response object
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

describe('Notion Integration Suite', () => {
  // Test Fixtures
  const SAMPLE_PAGE_ID = '4d036e05-2d4e-4b71-92b5-5d9c792167c1';
  const SAMPLE_DB_ID = '8a7e3b12-9c44-42f1-a1e5-8f6a3109d45e';

  const samplePageData = {
    object: 'page',
    id: SAMPLE_PAGE_ID,
    created_time: '2026-10-10T10:00:00.000Z',
    last_edited_time: '2026-10-12T12:00:00.000Z',
    created_by: { object: 'user', id: 'user-001' },
    last_edited_by: { object: 'user', id: 'user-002' },
    url: 'https://www.notion.so/relay-workspace/Architecture-4d036e052d4e4b7192b55d9c792167c1',
    properties: {
      title: {
        id: 'title',
        type: 'title',
        title: [
          {
            type: 'text',
            text: { content: 'System Architecture Document' },
            plain_text: 'System Architecture Document',
          },
        ],
      },
    },
  };

  const sampleBlocksData = {
    object: 'list',
    results: [
      {
        object: 'block',
        id: 'block-1',
        type: 'heading_1',
        has_children: false,
        heading_1: {
          rich_text: [{ plain_text: 'Architecture Overview' }],
        },
      },
      {
        object: 'block',
        id: 'block-2',
        type: 'paragraph',
        has_children: false,
        paragraph: {
          rich_text: [
            { plain_text: 'This system implements robust microservices with ' },
            { plain_text: 'event sourcing', annotations: { bold: true } },
            { plain_text: '.' },
          ],
        },
      },
      {
        object: 'block',
        id: 'block-3',
        type: 'to_do',
        has_children: false,
        to_do: {
          checked: true,
          rich_text: [{ plain_text: 'Design ingestion schema' }],
        },
      },
      {
        object: 'block',
        id: 'block-4',
        type: 'to_do',
        has_children: false,
        to_do: {
          checked: false,
          rich_text: [{ plain_text: 'Setup Notion webhook' }],
        },
      },
    ],
    has_more: false,
    next_cursor: null,
  };

  // 1. Successful Page Retrieval & Mapping
  describe('1. Successful Page Retrieval', () => {
    it('should retrieve a page with blocks and map to normalized SourceRecord', async () => {
      const mockFetch = async (url) => {
        const u = url.toString();
        if (u.includes(`/pages/${SAMPLE_PAGE_ID}`)) {
          return createMockResponse(samplePageData);
        }
        if (u.includes(`/blocks/${SAMPLE_PAGE_ID}/children`)) {
          return createMockResponse(sampleBlocksData);
        }
        return createMockResponse({ object: 'error', message: 'Not found' }, { status: 404 });
      };

      const connector = new NotionConnector({
        apiKey: 'secret_test_key_123',
        fetchFn: mockFetch,
      });

      const record = await connector.fetchPage(SAMPLE_PAGE_ID);

      // Verify source record validation passes
      const validation = validateSourceRecord(record);
      assert.equal(validation.valid, true, `Validation failed: ${validation.errors.join(', ')}`);
      assert.doesNotThrow(() => assertValidSourceRecord(record));

      // Verify normalized fields
      assert.equal(record.provider, SOURCE_PROVIDERS.NOTION);
      assert.equal(record.type, RECORD_TYPES.DOCUMENT);
      assert.equal(record.title, 'System Architecture Document');
      assert.equal(record.externalId, SAMPLE_PAGE_ID);
      assert.equal(record.url, samplePageData.url);
      assert.equal(record.author, 'user-002');
      assert.ok(record.content.includes('# Architecture Overview'));
      assert.ok(record.content.includes('[x] Design ingestion schema'));
      assert.ok(record.content.includes('[ ] Setup Notion webhook'));
      assert.equal(record.metadata.sourceId, SAMPLE_PAGE_ID);
      assert.equal(record.metadata.sourceUrl, samplePageData.url);
      assert.equal(record.metadata.isDatabaseItem, false);
      assert.equal(record.metadata.blockCount, 4);
    });
  });

  // 2. Database Retrieval
  describe('2. Supported Database Retrieval', () => {
    it('should query a database, extract row properties, and normalize records', async () => {
      const sampleDbQuery = {
        object: 'list',
        results: [
          {
            object: 'page',
            id: 'row-1',
            created_time: '2026-10-09T08:00:00.000Z',
            last_edited_time: '2026-10-11T09:00:00.000Z',
            url: 'https://notion.so/row-1',
            properties: {
              Name: {
                id: 'title',
                type: 'title',
                title: [{ plain_text: 'Setup Postgres Partitioning' }],
              },
              Status: {
                id: 'status',
                type: 'status',
                status: { name: 'In Progress' },
              },
              Tags: {
                id: 'tags',
                type: 'multi_select',
                multi_select: [{ name: 'Database' }, { name: 'DevOps' }],
              },
              Priority: {
                id: 'priority',
                type: 'select',
                select: { name: 'High' },
              },
            },
          },
          {
            object: 'page',
            id: 'row-2',
            created_time: '2026-10-08T08:00:00.000Z',
            last_edited_time: '2026-10-10T09:00:00.000Z',
            url: 'https://notion.so/row-2',
            properties: {
              Name: {
                id: 'title',
                type: 'title',
                title: [{ plain_text: 'API Documentation Revamp' }],
              },
              Status: {
                id: 'status',
                type: 'status',
                status: { name: 'Done' },
              },
              Tags: {
                id: 'tags',
                type: 'multi_select',
                multi_select: [{ name: 'Docs' }],
              },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      };

      const mockFetch = async (url, options) => {
        const u = url.toString();
        if (u.includes(`/databases/${SAMPLE_DB_ID}/query`)) {
          return createMockResponse(sampleDbQuery);
        }
        // When rows fetch their block bodies (empty bodies in this mock)
        if (u.includes('/blocks/')) {
          return createMockResponse({ object: 'list', results: [], has_more: false });
        }
        return createMockResponse({ object: 'error', message: 'Not found' }, { status: 404 });
      };

      const connector = new NotionConnector({
        apiKey: 'secret_test_key_123',
        fetchFn: mockFetch,
      });

      const records = await connector.fetchDatabase(SAMPLE_DB_ID);
      assert.equal(records.length, 2);

      const [firstRecord, secondRecord] = records;
      assert.equal(firstRecord.title, 'Setup Postgres Partitioning');
      assert.equal(firstRecord.metadata.isDatabaseItem, true);
      assert.equal(firstRecord.metadata.databaseId, SAMPLE_DB_ID);
      assert.equal(firstRecord.metadata.properties.Status, 'In Progress');
      assert.deepEqual(firstRecord.metadata.properties.Tags, ['Database', 'DevOps']);
      assert.equal(firstRecord.metadata.properties.Priority, 'High');
      assert.ok(firstRecord.content.includes('**Status**: In Progress'));

      assert.equal(secondRecord.title, 'API Documentation Revamp');
      assert.equal(secondRecord.metadata.properties.Status, 'Done');

      for (const rec of records) {
        assert.doesNotThrow(() => assertValidSourceRecord(rec));
      }
    });
  });

  // 3. Pagination Handling
  describe('3. Pagination Handling', () => {
    it('should paginate block children using cursors without truncating', async () => {
      let callCount = 0;
      const cursorsSeen = [];

      const mockFetch = async (url) => {
        const u = new URL(url);
        if (u.pathname.includes(`/pages/${SAMPLE_PAGE_ID}`)) {
          return createMockResponse(samplePageData);
        }
        if (u.pathname.includes(`/blocks/${SAMPLE_PAGE_ID}/children`)) {
          callCount++;
          const cursor = u.searchParams.get('start_cursor');
          cursorsSeen.push(cursor);

          if (!cursor) {
            // First page returns 2 blocks and next_cursor
            return createMockResponse({
              object: 'list',
              results: [
                {
                  id: 'block-p1',
                  type: 'paragraph',
                  has_children: false,
                  paragraph: { rich_text: [{ plain_text: 'Page 1 text' }] },
                },
              ],
              has_more: true,
              next_cursor: 'cursor_page_2',
            });
          } else if (cursor === 'cursor_page_2') {
            // Second page returns next block and has_more: false
            return createMockResponse({
              object: 'list',
              results: [
                {
                  id: 'block-p2',
                  type: 'paragraph',
                  has_children: false,
                  paragraph: { rich_text: [{ plain_text: 'Page 2 text' }] },
                },
              ],
              has_more: false,
              next_cursor: null,
            });
          }
        }
        return createMockResponse({}, { status: 404 });
      };

      const connector = new NotionConnector({
        apiKey: 'secret_test_key_123',
        fetchFn: mockFetch,
      });

      const record = await connector.fetchPage(SAMPLE_PAGE_ID);

      assert.equal(callCount, 2, 'Should have made 2 paginated calls');
      assert.deepEqual(cursorsSeen, [null, 'cursor_page_2']);
      assert.ok(record.content.includes('Page 1 text'));
      assert.ok(record.content.includes('Page 2 text'));
      assert.equal(record.metadata.blockCount, 2);
    });

    it('should paginate database query results using start_cursor', async () => {
      let queryCount = 0;

      const mockFetch = async (url, options) => {
        const u = new URL(url);
        if (u.pathname.includes(`/databases/${SAMPLE_DB_ID}/query`)) {
          queryCount++;
          const body = options?.body ? JSON.parse(options.body) : {};

          if (!body.start_cursor) {
            return createMockResponse({
              object: 'list',
              results: [
                {
                  id: 'item-1',
                  created_time: '2026-10-10T10:00:00.000Z',
                  properties: {
                    Name: { type: 'title', title: [{ plain_text: 'Task 1' }] },
                  },
                },
              ],
              has_more: true,
              next_cursor: 'db_cur_2',
            });
          } else {
            return createMockResponse({
              object: 'list',
              results: [
                {
                  id: 'item-2',
                  created_time: '2026-10-10T10:00:00.000Z',
                  properties: {
                    Name: { type: 'title', title: [{ plain_text: 'Task 2' }] },
                  },
                },
              ],
              has_more: false,
              next_cursor: null,
            });
          }
        }
        if (u.pathname.includes('/blocks/')) {
          return createMockResponse({ object: 'list', results: [], has_more: false });
        }
        return createMockResponse({}, { status: 404 });
      };

      const connector = new NotionConnector({
        apiKey: 'secret_test_key_123',
        fetchFn: mockFetch,
      });

      const records = await connector.fetchDatabase(SAMPLE_DB_ID);
      assert.equal(queryCount, 2);
      assert.equal(records.length, 2);
      assert.equal(records[0].title, 'Task 1');
      assert.equal(records[1].title, 'Task 2');
    });
  });

  // 4. Nested Content Extraction
  describe('4. Nested Content Extraction', () => {
    it('should recursively extract nested child blocks with proper indentation', async () => {
      const mockFetch = async (url) => {
        const u = new URL(url);
        if (u.pathname.includes(`/pages/${SAMPLE_PAGE_ID}`)) {
          return createMockResponse(samplePageData);
        }
        if (u.pathname.includes(`/blocks/${SAMPLE_PAGE_ID}/children`)) {
          return createMockResponse({
            object: 'list',
            results: [
              {
                id: 'parent-toggle',
                type: 'toggle',
                has_children: true,
                toggle: { rich_text: [{ plain_text: 'System Components' }] },
              },
            ],
            has_more: false,
          });
        }
        if (u.pathname.includes('/blocks/parent-toggle/children')) {
          return createMockResponse({
            object: 'list',
            results: [
              {
                id: 'child-bullet-1',
                type: 'bulleted_list_item',
                has_children: false,
                bulleted_list_item: { rich_text: [{ plain_text: 'Auth Service' }] },
              },
              {
                id: 'child-bullet-2',
                type: 'bulleted_list_item',
                has_children: true,
                bulleted_list_item: { rich_text: [{ plain_text: 'Data Storage' }] },
              },
            ],
            has_more: false,
          });
        }
        if (u.pathname.includes('/blocks/child-bullet-2/children')) {
          return createMockResponse({
            object: 'list',
            results: [
              {
                id: 'grandchild-1',
                type: 'paragraph',
                has_children: false,
                paragraph: { rich_text: [{ plain_text: 'PostgreSQL 16 replica set' }] },
              },
            ],
            has_more: false,
          });
        }
        return createMockResponse({}, { status: 404 });
      };

      const connector = new NotionConnector({
        apiKey: 'secret_test_key_123',
        fetchFn: mockFetch,
      });

      const record = await connector.fetchPage(SAMPLE_PAGE_ID);

      // Verify hierarchical content formatting
      assert.ok(record.content.includes('> **System Components**'));
      assert.ok(record.content.includes('  - Auth Service'));
      assert.ok(record.content.includes('  - Data Storage'));
      assert.ok(record.content.includes('    PostgreSQL 16 replica set'));
      assert.equal(record.metadata.blockCount, 4);
    });
  });

  // 5. Empty Pages & Unsupported Content Blocks
  describe('5. Empty Pages and Unsupported Content Blocks', () => {
    it('should gracefully handle empty pages without blocks', async () => {
      const mockFetch = async (url) => {
        const u = new URL(url);
        if (u.pathname.includes(`/pages/${SAMPLE_PAGE_ID}`)) {
          return createMockResponse(samplePageData);
        }
        if (u.pathname.includes('/blocks/')) {
          return createMockResponse({ object: 'list', results: [], has_more: false });
        }
        return createMockResponse({}, { status: 404 });
      };

      const connector = new NotionConnector({
        apiKey: 'secret_test_key_123',
        fetchFn: mockFetch,
      });

      const record = await connector.fetchPage(SAMPLE_PAGE_ID);
      assert.equal(record.content, '');
      assert.equal(record.metadata.blockCount, 0);
      assert.doesNotThrow(() => assertValidSourceRecord(record));
    });

    it('should gracefully skip unsupported block types without failing', async () => {
      const mockFetch = async (url) => {
        const u = new URL(url);
        if (u.pathname.includes(`/pages/${SAMPLE_PAGE_ID}`)) {
          return createMockResponse(samplePageData);
        }
        if (u.pathname.includes('/blocks/')) {
          return createMockResponse({
            object: 'list',
            results: [
              {
                id: 'unsupported-block',
                type: 'unsupported_3rd_party_widget',
                has_children: false,
                unsupported_3rd_party_widget: {},
              },
              {
                id: 'valid-block',
                type: 'paragraph',
                has_children: false,
                paragraph: { rich_text: [{ plain_text: 'Supported content' }] },
              },
            ],
            has_more: false,
          });
        }
        return createMockResponse({}, { status: 404 });
      };

      const connector = new NotionConnector({
        apiKey: 'secret_test_key_123',
        fetchFn: mockFetch,
      });

      const record = await connector.fetchPage(SAMPLE_PAGE_ID);
      assert.equal(record.content, 'Supported content');
      assert.equal(record.metadata.blockCount, 2);
    });
  });

  // 6. Mapping into Normalized Record Format
  describe('6. Mapping into Normalized Record Format', () => {
    it('should generate valid SourceRecord adhering to types contract', async () => {
      const pageData = {
        id: 'rec-test-1',
        created_time: '2026-10-01T00:00:00.000Z',
        last_edited_time: '2026-10-02T00:00:00.000Z',
        properties: {
          title: { type: 'title', title: [{ plain_text: 'Contract Test Page' }] },
        },
      };

      const record = normalizeNotionPage({
        page: pageData,
        blocks: [{ text: 'Some text', id: 'b1', type: 'paragraph' }],
        childCount: 1,
      });

      const validation = validateSourceRecord(record);
      assert.equal(validation.valid, true);
      assert.equal(record.provider, 'notion');
      assert.equal(record.externalId, 'rec-test-1');
      assert.equal(record.title, 'Contract Test Page');
      assert.equal(record.content, 'Some text');
      assert.equal(record.type, 'document');
      assert.ok(record.observedAt);
      assert.ok(record.fetchedAt);
    });
  });

  // 7. Source ID and URL Preservation
  describe('7. Source ID and URL Preservation', () => {
    it('should preserve original source ID and URL for provenance tracing', async () => {
      const pageData = {
        id: 'orig-id-999',
        url: 'https://notion.so/my-org/orig-id-999',
        created_time: '2026-10-01T00:00:00.000Z',
        last_edited_time: '2026-10-02T00:00:00.000Z',
        properties: {
          title: { type: 'title', title: [{ plain_text: 'Traceability Doc' }] },
        },
      };

      const record = normalizeNotionPage({
        page: pageData,
        blocks: [],
      });

      assert.equal(record.externalId, 'orig-id-999');
      assert.equal(record.url, 'https://notion.so/my-org/orig-id-999');
      assert.equal(record.metadata.sourceId, 'orig-id-999');
      assert.equal(record.metadata.sourceUrl, 'https://notion.so/my-org/orig-id-999');
    });

    it('should clean hyphens when parsing Notion IDs', () => {
      assert.equal(
        parseNotionId('4d036e05-2d4e-4b71-92b5-5d9c792167c1'),
        '4d036e05-2d4e-4b71-92b5-5d9c792167c1'
      );
      assert.equal(
        parseNotionId('4d036e052d4e4b7192b55d9c792167c1'),
        '4d036e05-2d4e-4b71-92b5-5d9c792167c1'
      );
      assert.equal(
        parseNotionId('https://notion.so/workspace/My-Page-4d036e052d4e4b7192b55d9c792167c1'),
        '4d036e05-2d4e-4b71-92b5-5d9c792167c1'
      );
    });
  });

  // 8. Missing Credentials Handling
  describe('8. Missing Credentials', () => {
    it('should throw NotionAuthenticationError when API key is missing', () => {
      // Clear env temporarily if set
      const origKey = process.env.NOTION_API_KEY;
      delete process.env.NOTION_API_KEY;

      try {
        assert.throws(
          () => new NotionConnector({ apiKey: '' }),
          (err) => {
            assert.ok(err instanceof NotionAuthenticationError);
            assert.ok(err.message.includes('NOTION_API_KEY is required'));
            assert.equal(err.code, 'NOTION_API_KEY_MISSING');
            return true;
          }
        );
      } finally {
        if (origKey) process.env.NOTION_API_KEY = origKey;
      }
    });

    it('should throw NotionAuthenticationError when Notion API returns 401 Unauthorized', async () => {
      const mockFetch = async () =>
        createMockResponse(
          { object: 'error', status: 401, code: 'unauthorized', message: 'API token is invalid.' },
          { status: 401 }
        );

      const connector = new NotionConnector({
        apiKey: 'invalid_token',
        fetchFn: mockFetch,
      });

      await assert.rejects(
        () => connector.fetchPage(SAMPLE_PAGE_ID),
        (err) => {
          assert.ok(err instanceof NotionAuthenticationError);
          assert.equal(err.status, 401);
          assert.equal(err.code, 'unauthorized');
          return true;
        }
      );
    });
  });

  // 9. Permission Failures
  describe('9. Permission Failures', () => {
    it('should throw NotionPermissionError on 403 restricted resource without indefinite retries', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        return createMockResponse(
          {
            object: 'error',
            status: 403,
            code: 'restricted_resource',
            message: 'Integration does not have access to this resource.',
          },
          { status: 403 }
        );
      };

      const connector = new NotionConnector({
        apiKey: 'test_token',
        fetchFn: mockFetch,
      });

      await assert.rejects(
        () => connector.fetchPage(SAMPLE_PAGE_ID),
        (err) => {
          assert.ok(err instanceof NotionPermissionError);
          assert.equal(err.status, 403);
          assert.equal(err.code, 'restricted_resource');
          return true;
        }
      );

      // Verify permanent error is NOT retried
      assert.equal(callCount, 1, 'Should not retry permanent permission errors');
    });

    it('should throw NotionPermissionError on 404 object_not_found (unshared page)', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        return createMockResponse(
          {
            object: 'error',
            status: 404,
            code: 'object_not_found',
            message: 'Could not find page with ID. Make sure it is shared with the integration.',
          },
          { status: 404 }
        );
      };

      const connector = new NotionConnector({
        apiKey: 'test_token',
        fetchFn: mockFetch,
      });

      await assert.rejects(
        () => connector.fetchPage(SAMPLE_PAGE_ID),
        (err) => {
          assert.ok(err instanceof NotionPermissionError);
          assert.equal(err.status, 404);
          assert.equal(err.code, 'object_not_found');
          return true;
        }
      );

      assert.equal(callCount, 1, 'Should not retry unshared page 404 errors');
    });
  });

  // 10. Rate Limits & Transient Errors
  describe('10. Rate Limits and Transient API Errors', () => {
    it('should retry on 429 rate limit and succeed when subsequent call succeeds', async () => {
      let callCount = 0;

      const mockFetch = async (url) => {
        callCount++;
        if (callCount === 1) {
          return createMockResponse(
            { object: 'error', status: 429, code: 'rate_limited', message: 'Rate limit hit' },
            { status: 429, headers: { 'retry-after': '0' } }
          );
        }
        const u = url.toString();
        if (u.includes('/pages/')) return createMockResponse(samplePageData);
        if (u.includes('/blocks/')) return createMockResponse({ object: 'list', results: [], has_more: false });
        return createMockResponse({}, { status: 404 });
      };

      const client = new NotionClient({
        apiKey: 'test_token',
        fetchFn: mockFetch,
        retryOptions: { maxRetries: 2, initialDelayMs: 1, backoffMultiplier: 1 },
      });

      const connector = new NotionConnector({ client });
      const record = await connector.fetchPage(SAMPLE_PAGE_ID);

      assert.ok(record);
      assert.equal(callCount >= 2, true, 'Should have retried after 429');
    });

    it('should throw NotionRateLimitError when retries are exhausted on 429', async () => {
      const mockFetch = async () =>
        createMockResponse(
          { object: 'error', status: 429, code: 'rate_limited', message: 'Rate limit exceeded' },
          { status: 429, headers: { 'retry-after': '1' } }
        );

      const client = new NotionClient({
        apiKey: 'test_token',
        fetchFn: mockFetch,
        retryOptions: { maxRetries: 1, initialDelayMs: 1, backoffMultiplier: 1 },
      });

      await assert.rejects(
        () => client.getPage(SAMPLE_PAGE_ID),
        (err) => {
          assert.ok(err instanceof NotionRateLimitError);
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterSeconds, 1);
          return true;
        }
      );
    });
  });

  // 11. Malformed Responses
  describe('11. Malformed Responses', () => {
    it('should handle non-JSON / HTML error responses gracefully', async () => {
      const mockFetch = async () =>
        createMockResponse('<html><body>502 Bad Gateway</body></html>', { status: 502 });

      const client = new NotionClient({
        apiKey: 'test_token',
        fetchFn: mockFetch,
        retryOptions: { maxRetries: 0 },
      });

      await assert.rejects(
        () => client.getPage(SAMPLE_PAGE_ID),
        (err) => {
          assert.ok(err instanceof NotionError);
          assert.equal(err.status, 502);
          assert.ok(err.message.includes('502 Bad Gateway'));
          return true;
        }
      );
    });
  });

  // 12. Workspace Sync (Search authorized pages)
  describe('12. Workspace Sync for Authorized Resources', () => {
    it('should sync all authorized pages in the workspace', async () => {
      const mockFetch = async (url, options) => {
        const u = new URL(url);
        if (u.pathname.includes('/search')) {
          return createMockResponse({
            object: 'list',
            results: [
              {
                object: 'page',
                id: 'shared-page-1',
                created_time: '2026-10-10T00:00:00.000Z',
                last_edited_time: '2026-10-10T00:00:00.000Z',
                url: 'https://notion.so/shared-page-1',
                properties: {
                  title: { type: 'title', title: [{ plain_text: 'Shared Page 1' }] },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          });
        }
        if (u.pathname.includes('/blocks/shared-page-1/children')) {
          return createMockResponse({
            object: 'list',
            results: [
              {
                id: 'b-1',
                type: 'paragraph',
                has_children: false,
                paragraph: { rich_text: [{ plain_text: 'Content of shared page 1' }] },
              },
            ],
            has_more: false,
          });
        }
        return createMockResponse({}, { status: 404 });
      };

      const connector = new NotionConnector({
        apiKey: 'secret_test_key_123',
        fetchFn: mockFetch,
      });

      const records = await connector.syncAuthorizedWorkspace();
      assert.equal(records.length, 1);
      assert.equal(records[0].title, 'Shared Page 1');
      assert.equal(records[0].content, 'Content of shared page 1');
      assert.doesNotThrow(() => assertValidSourceRecord(records[0]));
    });
  });

  // Additional block formatters & property extractors
  describe('Formatting & Extractor Unit Coverage', () => {
    it('should format code blocks, quotes, callouts, and bookmarks', () => {
      const codeBlock = {
        type: 'code',
        code: {
          language: 'typescript',
          rich_text: [{ plain_text: 'const x: number = 42;' }],
        },
      };
      assert.equal(
        formatBlockContent(codeBlock),
        '```typescript\nconst x: number = 42;\n```'
      );

      const quoteBlock = {
        type: 'quote',
        quote: { rich_text: [{ plain_text: 'A famous quote' }] },
      };
      assert.equal(formatBlockContent(quoteBlock), '> A famous quote');

      const calloutBlock = {
        type: 'callout',
        callout: {
          icon: { type: 'emoji', emoji: '💡' },
          rich_text: [{ plain_text: 'Important note' }],
        },
      };
      assert.equal(formatBlockContent(calloutBlock), '> 💡 Important note');

      const bookmarkBlock = {
        type: 'bookmark',
        bookmark: { url: 'https://github.com' },
      };
      assert.equal(formatBlockContent(bookmarkBlock), '[https://github.com](https://github.com)');
    });

    it('should extract various database properties', () => {
      const properties = {
        Cost: { type: 'number', number: 1250 },
        Active: { type: 'checkbox', checkbox: true },
        Homepage: { type: 'url', url: 'https://example.com' },
        Contact: { type: 'email', email: 'dev@example.com' },
        Schedule: {
          type: 'date',
          date: { start: '2026-10-15', end: '2026-10-20' },
        },
      };

      const extracted = extractProperties(properties);
      assert.equal(extracted.Cost, 1250);
      assert.equal(extracted.Active, true);
      assert.equal(extracted.Homepage, 'https://example.com');
      assert.equal(extracted.Contact, 'dev@example.com');
      assert.deepEqual(extracted.Schedule, { start: '2026-10-15', end: '2026-10-20' });
    });
  });
});
