import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NotionConnector,
  NotionClient,
  NotionAuthenticationError,
  NotionPermissionError,
  NotionRateLimitError,
  extractRichText,
  formatBlockContent,
  extractProperties,
  normalizeNotionPageCandidate,
  parseNotionId,
} from './index.js';

import {
  SOURCE_PROVIDERS,
  SOURCE_RECORD_TYPES,
  SOURCE_CONTENT_TYPES,
  validateSourceRecordCandidate,
} from '../../contracts/sourceRecord.js';

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
      if (isString) throw new SyntaxError('Unexpected token in JSON');
      return body;
    },
    async text() {
      return responseBody;
    },
  };
}

describe('Ingestion Module: Notion Provider & Candidate Validation', () => {
  const SAMPLE_PAGE_ID = '4d036e05-2d4e-4b71-92b5-5d9c792167c1';
  const SAMPLE_PROJECT_ID = 'proj_relay_main';

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
            text: { content: 'Relay System Architecture' },
            plain_text: 'Relay System Architecture',
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
          rich_text: [{ plain_text: 'Context extraction and continuity platform.' }],
        },
      },
    ],
    has_more: false,
    next_cursor: null,
  };

  it('should fetch a Notion page and normalize to a valid SourceRecordCandidate', async () => {
    const mockFetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/pages/${SAMPLE_PAGE_ID}`)) return createMockResponse(samplePageData);
      if (u.includes(`/blocks/${SAMPLE_PAGE_ID}/children`)) return createMockResponse(sampleBlocksData);
      return createMockResponse({}, { status: 404 });
    };

    const connector = new NotionConnector({
      apiKey: 'secret_mock_token',
      fetchFn: mockFetch,
    });

    const candidate = await connector.fetchPage(SAMPLE_PAGE_ID, {
      projectId: SAMPLE_PROJECT_ID,
    });

    // Validate directly against agreed application contract
    const validation = validateSourceRecordCandidate(candidate);
    assert.equal(validation.valid, true, `Errors: ${validation.errors.join(', ')}`);

    // Must NOT contain internal database ID
    assert.equal(candidate.id, undefined);
    assert.equal(candidate._id, undefined);

    // Provenance and timestamps
    assert.equal(candidate.provider, SOURCE_PROVIDERS.NOTION);
    assert.equal(candidate.recordType, SOURCE_RECORD_TYPES.DOCUMENT);
    assert.equal(candidate.contentType, SOURCE_CONTENT_TYPES.MARKDOWN);
    assert.equal(candidate.externalId, SAMPLE_PAGE_ID);
    assert.equal(candidate.title, 'Relay System Architecture');
    assert.ok(candidate.content.includes('# Architecture Overview'));
    assert.ok(candidate.createdAt instanceof Date);
    assert.ok(candidate.updatedAt instanceof Date);
    assert.ok(candidate.fetchedAt instanceof Date);
    assert.equal(candidate.url, samplePageData.url);
    assert.equal(candidate.metadata.sourceId, SAMPLE_PAGE_ID);
    assert.equal(candidate.metadata.blockCount, 2);
  });

  it('should normalize database rows into SourceRecordCandidates with properties', async () => {
    const mockDbQuery = {
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
              type: 'title',
              title: [{ plain_text: 'Implement Database Sharding' }],
            },
            Status: {
              type: 'status',
              status: { name: 'Done' },
            },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    };

    const mockFetch = async (url) => {
      const u = url.toString();
      if (u.includes('/query')) return createMockResponse(mockDbQuery);
      if (u.includes('/blocks/')) return createMockResponse({ object: 'list', results: [], has_more: false });
      return createMockResponse({}, { status: 404 });
    };

    const connector = new NotionConnector({
      apiKey: 'secret_mock_token',
      fetchFn: mockFetch,
    });

    const candidates = await connector.fetchDatabase('db-123', {
      projectId: SAMPLE_PROJECT_ID,
    });

    assert.equal(candidates.length, 1);
    const candidate = candidates[0];
    const validation = validateSourceRecordCandidate(candidate);
    assert.equal(validation.valid, true);
    assert.equal(candidate.title, 'Implement Database Sharding');
    assert.equal(candidate.metadata.isDatabaseItem, true);
    assert.equal(candidate.metadata.properties.Status, 'Done');
  });

  it('should parse Notion UUIDs correctly from URL or raw hex', () => {
    const rawHex = '4d036e052d4e4b7192b55d9c792167c1';
    assert.equal(parseNotionId(rawHex), '4d036e05-2d4e-4b71-92b5-5d9c792167c1');

    const url = 'https://www.notion.so/workspace/My-Page-4d036e052d4e4b7192b55d9c792167c1';
    assert.equal(parseNotionId(url), '4d036e05-2d4e-4b71-92b5-5d9c792167c1');
  });
});
