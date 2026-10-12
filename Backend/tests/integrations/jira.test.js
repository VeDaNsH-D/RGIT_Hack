import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  JiraConnector,
  JiraClient,
  JiraError,
  JiraClientError,
  JiraAuthenticationError,
  JiraPermissionError,
  JiraRateLimitError,
  JiraNotFoundError,
  JiraValidationError,
  extractAdfNode,
  extractDescription,
  extractIssueProperties,
  applyMarks,
  normalizeJiraIssue,
  normalizeJiraIssueCandidate,
  constructIssueUrl,
  parseDate,
} from '../../src/integrations/jira/index.js';

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

describe('Jira Integration Suite', () => {
  const TEST_HOST = 'https://test-team.atlassian.net';
  const TEST_EMAIL = 'dev@test-team.com';
  const TEST_TOKEN = 'test_jira_token_abc123';
  const TEST_PROJECT_KEY = 'RELAY';

  const SAMPLE_ADF_DESCRIPTION = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Implementation Details' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Please ensure ' },
          {
            type: 'text',
            text: 'OAuth2 authentication',
            marks: [{ type: 'strong' }],
          },
          { type: 'text', text: ' is thoroughly verified using ' },
          {
            type: 'text',
            text: 'token headers',
            marks: [{ type: 'code' }],
          },
          { type: 'text', text: '.' },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Unit test ADF parser' }],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Test pagination cursors' }],
              },
            ],
          },
        ],
      },
      {
        type: 'codeBlock',
        attrs: { language: 'javascript' },
        content: [{ type: 'text', text: 'const client = new JiraClient();' }],
      },
      {
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Do not invent missing deadlines.' }],
          },
        ],
      },
    ],
  };

  const SAMPLE_RAW_ISSUE = {
    id: '10042',
    key: 'RELAY-42',
    self: `${TEST_HOST}/rest/api/3/issue/10042`,
    fields: {
      summary: 'Implement Jira Ingestion Connector',
      description: SAMPLE_ADF_DESCRIPTION,
      status: {
        name: 'In Progress',
        statusCategory: { key: 'indeterminate', name: 'In Progress' },
      },
      priority: { name: 'High' },
      assignee: {
        accountId: 'acc-12345',
        displayName: 'Alice Developer',
        emailAddress: 'alice@test-team.com',
      },
      reporter: {
        accountId: 'acc-67890',
        displayName: 'Bob Lead',
        emailAddress: 'bob@test-team.com',
      },
      creator: {
        accountId: 'acc-67890',
        displayName: 'Bob Lead',
      },
      labels: ['backend', 'ingestion', 'q4'],
      duedate: '2026-11-15',
      created: '2026-10-01T10:00:00.000Z',
      updated: '2026-10-10T14:30:00.000Z',
      project: {
        id: '20001',
        key: 'RELAY',
        name: 'Relay Continuity Engine',
      },
      issuetype: {
        name: 'Task',
        subtask: false,
      },
      resolution: null,
    },
  };

  // =========================================================================
  // 1. Successful Issue Retrieval
  // =========================================================================
  describe('1. Successful Issue Retrieval', () => {
    it('should retrieve a single issue and map to normalized SourceRecord', async () => {
      const mockFetch = async (url) => {
        assert.ok(url.includes('/rest/api/3/issue/RELAY-42'));
        return createMockResponse(SAMPLE_RAW_ISSUE);
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        email: TEST_EMAIL,
        apiToken: TEST_TOKEN,
        fetchFn: mockFetch,
      });

      const record = await connector.fetchIssue('RELAY-42', { projectId: 'project-xyz' });

      assert.equal(record.id, 'src_jira_RELAY-42');
      assert.equal(record.provider, SOURCE_PROVIDERS.JIRA);
      assert.equal(record.recordType, RECORD_TYPES.ISSUE);
      assert.equal(record.type, RECORD_TYPES.ISSUE);
      assert.equal(record.title, 'Implement Jira Ingestion Connector');
      assert.equal(record.externalId, 'RELAY-42');
      assert.equal(record.projectId, 'project-xyz');
      assert.equal(record.author, 'Bob Lead');
      assert.equal(record.authorId, 'acc-67890');
      assert.equal(record.url, `${TEST_HOST}/browse/RELAY-42`);
      assert.ok(record.content.includes('## Implementation Details'));
      assert.ok(record.content.includes('**OAuth2 authentication**'));
      assert.ok(record.content.includes('`token headers`'));
      assert.ok(record.content.includes('- Unit test ADF parser'));
      assert.ok(record.content.includes('```javascript\nconst client = new JiraClient();\n```'));
      assert.ok(record.content.includes('> Do not invent missing deadlines.'));

      assertValidSourceRecord(record);
    });

    it('should retrieve authorized projects for the connected account', async () => {
      const mockProjects = [
        { id: '20001', key: 'RELAY', name: 'Relay Project', projectTypeKey: 'software' },
        { id: '20002', key: 'DOCS', name: 'Documentation', projectTypeKey: 'business' },
      ];

      const mockFetch = async (url) => {
        assert.ok(url.includes('/rest/api/3/project'));
        return createMockResponse(mockProjects);
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        apiToken: TEST_TOKEN,
        fetchFn: mockFetch,
      });

      const projects = await connector.getProjects();
      assert.equal(projects.length, 2);
      assert.equal(projects[0].key, 'RELAY');
      assert.equal(projects[1].key, 'DOCS');
    });
  });

  // =========================================================================
  // 2. Pagination Handling
  // =========================================================================
  describe('2. Pagination Handling', () => {
    it('should correctly paginate through issues using startAt offset', async () => {
      const page1Issues = [
        { ...SAMPLE_RAW_ISSUE, id: '101', key: 'RELAY-1' },
        { ...SAMPLE_RAW_ISSUE, id: '102', key: 'RELAY-2' },
      ];
      const page2Issues = [
        { ...SAMPLE_RAW_ISSUE, id: '103', key: 'RELAY-3' },
      ];

      const calls = [];
      const mockFetch = async (url) => {
        calls.push(url);
        if (url.includes('startAt=0')) {
          return createMockResponse({
            startAt: 0,
            maxResults: 2,
            total: 3,
            issues: page1Issues,
          });
        }
        if (url.includes('startAt=2')) {
          return createMockResponse({
            startAt: 2,
            maxResults: 2,
            total: 3,
            issues: page2Issues,
          });
        }
        return createMockResponse({ startAt: 3, maxResults: 2, total: 3, issues: [] });
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        apiToken: TEST_TOKEN,
        fetchFn: mockFetch,
      });

      const records = await connector.fetchIssues({
        projectKey: 'RELAY',
        perPage: 2,
        maxPages: 5,
        fetchAll: true,
      });

      assert.equal(records.length, 3);
      assert.equal(records[0].externalId, 'RELAY-1');
      assert.equal(records[1].externalId, 'RELAY-2');
      assert.equal(records[2].externalId, 'RELAY-3');
      assert.equal(calls.length, 2);
    });

    it('should respect maxPages limit to avoid unconstrained retrieval', async () => {
      let pageCount = 0;
      const mockFetch = async () => {
        pageCount += 1;
        return createMockResponse({
          startAt: (pageCount - 1) * 2,
          maxResults: 2,
          total: 100, // Large total
          issues: [
            { ...SAMPLE_RAW_ISSUE, id: `id-${pageCount}-1`, key: `RELAY-${pageCount}-1` },
            { ...SAMPLE_RAW_ISSUE, id: `id-${pageCount}-2`, key: `RELAY-${pageCount}-2` },
          ],
        });
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        apiToken: TEST_TOKEN,
        fetchFn: mockFetch,
      });

      const records = await connector.fetchIssues({
        maxPages: 2,
        perPage: 2,
      });

      assert.equal(records.length, 4);
      assert.equal(pageCount, 2);
    });
  });

  // =========================================================================
  // 3. Field Extraction & Normalization
  // =========================================================================
  describe('3. Field Extraction & Normalization', () => {
    it('should validate against canonical SourceRecordCandidate and SourceRecord contracts', () => {
      const candidate = normalizeJiraIssueCandidate(SAMPLE_RAW_ISSUE, {
        projectId: 'relay-core',
        baseUrl: TEST_HOST,
      });

      const candidateValidation = validateSourceRecordCandidate(candidate);
      assert.equal(candidateValidation.valid, true, candidateValidation.errors.join('; '));
      assert.equal(candidate.provider, 'jira');
      assert.equal(candidate.recordType, 'issue');
      assert.equal(candidate.externalId, 'RELAY-42');
      assert.equal(candidate.title, 'Implement Jira Ingestion Connector');
      assert.equal(candidate.metadata.priority, 'High');
      assert.equal(candidate.metadata.status, 'In Progress');
      assert.deepEqual(candidate.metadata.labels, ['backend', 'ingestion', 'q4']);
      assert.equal(candidate.metadata.dueDate, '2026-11-15');

      const fullRecord = normalizeJiraIssue(SAMPLE_RAW_ISSUE, {
        projectId: 'relay-core',
        baseUrl: TEST_HOST,
      });

      const recordValidation = validateSourceRecord(fullRecord);
      assert.equal(recordValidation.valid, true, recordValidation.errors.join('; '));
      assert.equal(fullRecord.id, 'src_jira_RELAY-42');
    });

    it('should correctly determine isActive based on resolution and statusCategory', () => {
      const openIssue = {
        ...SAMPLE_RAW_ISSUE,
        fields: {
          ...SAMPLE_RAW_ISSUE.fields,
          resolution: null,
          status: { statusCategory: { key: 'indeterminate' } },
        },
      };
      const resolvedIssue = {
        ...SAMPLE_RAW_ISSUE,
        fields: {
          ...SAMPLE_RAW_ISSUE.fields,
          resolution: { name: 'Done' },
          status: { statusCategory: { key: 'done' } },
        },
      };

      const candOpen = normalizeJiraIssueCandidate(openIssue);
      const candResolved = normalizeJiraIssueCandidate(resolvedIssue);

      assert.equal(candOpen.isActive, true);
      assert.equal(candResolved.isActive, false);
    });
  });

  // =========================================================================
  // 4. Rich-Text (ADF) Description Handling
  // =========================================================================
  describe('4. Rich-Text (ADF) Description Handling', () => {
    it('should convert ADF formatting marks (bold, italic, code, strike, links)', () => {
      const adf = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'plain ' },
              { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
              { type: 'text', text: ' and ' },
              { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
              { type: 'text', text: ' and ' },
              { type: 'text', text: 'strike', marks: [{ type: 'strike' }] },
              { type: 'text', text: ' and ' },
              { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://jira.atlassian.com' } }] },
            ],
          },
        ],
      };

      const markdown = extractDescription(adf);
      assert.ok(markdown.includes('**bold**'));
      assert.ok(markdown.includes('*italic*'));
      assert.ok(markdown.includes('~~strike~~'));
      assert.ok(markdown.includes('[link](https://jira.atlassian.com)'));
    });

    it('should format panels, horizontal rules, mentions, and tables cleanly', () => {
      const adf = {
        type: 'doc',
        content: [
          {
            type: 'panel',
            attrs: { panelType: 'warning' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Check permissions' }] }],
          },
          { type: 'rule' },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Assigned to ' },
              { type: 'mention', attrs: { text: 'john.doe' } },
            ],
          },
        ],
      };

      const markdown = extractDescription(adf);
      assert.ok(markdown.includes('> **[Warning]** Check permissions'));
      assert.ok(markdown.includes('---'));
      assert.ok(markdown.includes('@john.doe'));
    });

    it('should handle raw string descriptions gracefully without failing', () => {
      const rawText = 'This is a legacy plain text description.';
      assert.equal(extractDescription(rawText), rawText);
    });

    it('should skip unrecognized ADF node types safely without crashing', () => {
      const adfWithUnknown = {
        type: 'doc',
        content: [
          {
            type: 'someUnknownAtlassianExtension',
            content: [{ type: 'text', text: 'nested text inside extension' }],
          },
        ],
      };

      const extracted = extractDescription(adfWithUnknown);
      assert.ok(extracted.includes('nested text inside extension'));
    });
  });

  // =========================================================================
  // 5. Missing Optional Fields (Never Fabricate Values)
  // =========================================================================
  describe('5. Missing Optional Fields', () => {
    it('should keep missing due dates, assignees, and descriptions null or empty without fabricating values', () => {
      const minimalIssue = {
        id: '99001',
        key: 'MIN-1',
        fields: {
          summary: 'Minimal Issue Without Optional Fields',
          description: null,
          duedate: null, // No deadline
          assignee: null, // No assignee
          priority: null, // No priority
          status: { name: 'To Do', statusCategory: { key: 'new' } },
          labels: [],
          created: '2026-10-05T00:00:00.000Z',
          updated: '2026-10-05T00:00:00.000Z',
        },
      };

      const record = normalizeJiraIssue(minimalIssue, { baseUrl: TEST_HOST });

      assert.equal(record.content, '');
      assert.equal(record.metadata.dueDate, null); // Strictly preserved as null
      assert.equal(record.metadata.assignee, null);
      assert.equal(record.metadata.priority, null);
      assert.deepEqual(record.metadata.labels, []);
      assertValidSourceRecord(record);
    });

    it('should parse valid dates and return undefined for missing dates without crashing', () => {
      assert.equal(parseDate(null), undefined);
      assert.equal(parseDate(undefined), undefined);
      assert.equal(parseDate('invalid-date'), undefined);
      assert.ok(parseDate('2026-10-12T10:00:00.000Z') instanceof Date);
    });
  });

  // =========================================================================
  // 6. Source ID, Issue Key, and URL Preservation
  // =========================================================================
  describe('6. Source ID, Issue Key, and URL Preservation', () => {
    it('should preserve original issue key, ID, and construct canonical browse URL', () => {
      const issue = {
        id: '54321',
        key: 'CORE-999',
        self: 'https://myorg.atlassian.net/rest/api/3/issue/54321',
        fields: {
          summary: 'Core Issue',
          created: '2026-10-01T00:00:00.000Z',
          updated: '2026-10-01T00:00:00.000Z',
        },
      };

      const record = normalizeJiraIssue(issue, { baseUrl: 'https://myorg.atlassian.net' });

      assert.equal(record.externalId, 'CORE-999');
      assert.equal(record.metadata.key, 'CORE-999');
      assert.equal(record.metadata.issueId, '54321');
      assert.equal(record.url, 'https://myorg.atlassian.net/browse/CORE-999');
      assert.equal(record.metadata.sourceUrl, 'https://myorg.atlassian.net/browse/CORE-999');
    });

    it('should construct browse URL from self link when baseUrl is omitted', () => {
      const issue = {
        id: '123',
        key: 'DEMO-1',
        self: 'https://custom-host.atlassian.net/rest/api/3/issue/123',
      };
      const url = constructIssueUrl(issue);
      assert.equal(url, 'https://custom-host.atlassian.net/browse/DEMO-1');
    });
  });

  // =========================================================================
  // 7. Missing Credentials
  // =========================================================================
  describe('7. Missing Credentials', () => {
    it('should throw JiraAuthenticationError when JIRA_API_TOKEN is missing', () => {
      assert.throws(
        () => new JiraConnector({ host: TEST_HOST, apiToken: '' }),
        (err) => {
          assert.ok(err instanceof JiraAuthenticationError);
          assert.equal(err.statusCode, 401);
          assert.ok(err.message.includes('JIRA_API_TOKEN is required'));
          return true;
        }
      );
    });

    it('should throw JiraValidationError when JIRA_HOST is missing', () => {
      assert.throws(
        () => new JiraConnector({ host: '', apiToken: 'token_123' }),
        (err) => {
          assert.ok(err instanceof JiraValidationError);
          assert.ok(err.message.includes('JIRA_HOST is required'));
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 8. Permission Failures
  // =========================================================================
  describe('8. Permission Failures', () => {
    it('should throw JiraAuthenticationError on 401 Unauthorized without retrying indefinitely', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount += 1;
        return createMockResponse({ errorMessages: ['Unauthorized token'] }, { status: 401 });
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        apiToken: 'invalid_token',
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 3 },
      });

      await assert.rejects(
        () => connector.fetchIssue('RELAY-1'),
        (err) => {
          assert.ok(err instanceof JiraAuthenticationError);
          assert.equal(err.statusCode, 401);
          return true;
        }
      );

      // Permanent 401 should fail fast on first attempt
      assert.equal(callCount, 1);
    });

    it('should throw JiraPermissionError on 403 Forbidden without retrying indefinitely', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount += 1;
        return createMockResponse({ errorMessages: ["You do not have permission to view this issue."] }, { status: 403 });
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        apiToken: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 3 },
      });

      await assert.rejects(
        () => connector.fetchIssue('RELAY-SECRET'),
        (err) => {
          assert.ok(err instanceof JiraPermissionError);
          assert.equal(err.statusCode, 403);
          return true;
        }
      );

      assert.equal(callCount, 1);
    });

    it('should throw JiraNotFoundError on 404 Not Found without retrying indefinitely', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount += 1;
        return createMockResponse({ errorMessages: ["Issue Does Not Exist"] }, { status: 404 });
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        apiToken: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 3 },
      });

      await assert.rejects(
        () => connector.fetchIssue('RELAY-NONEXISTENT'),
        (err) => {
          assert.ok(err instanceof JiraNotFoundError);
          assert.equal(err.statusCode, 404);
          return true;
        }
      );

      assert.equal(callCount, 1);
    });
  });

  // =========================================================================
  // 9. Rate Limits and Transient API Errors
  // =========================================================================
  describe('9. Rate Limits and Transient API Errors', () => {
    it('should retry on 429 Rate Limit and succeed when next attempt returns 200', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount += 1;
        if (callCount === 1) {
          return createMockResponse('Rate limit exceeded', {
            status: 429,
            headers: { 'Retry-After': '0' },
          });
        }
        return createMockResponse(SAMPLE_RAW_ISSUE);
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        apiToken: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 3, initialDelayMs: 1 },
      });

      const record = await connector.fetchIssue('RELAY-42');
      assert.equal(record.externalId, 'RELAY-42');
      assert.equal(callCount, 2);
    });

    it('should retry on 503 Service Unavailable and succeed on subsequent attempt', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount += 1;
        if (callCount === 1) {
          return createMockResponse('Jira upstream unavailable', { status: 503 });
        }
        return createMockResponse(SAMPLE_RAW_ISSUE);
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        apiToken: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 3, initialDelayMs: 1 },
      });

      const record = await connector.fetchIssue('RELAY-42');
      assert.equal(record.externalId, 'RELAY-42');
      assert.equal(callCount, 2);
    });

    it('should throw JiraRateLimitError when retries are exhausted on 429', async () => {
      const mockFetch = async () => {
        return createMockResponse('Rate limited', {
          status: 429,
          headers: { 'Retry-After': '1' },
        });
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        apiToken: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 2, initialDelayMs: 1 },
      });

      await assert.rejects(
        () => connector.fetchIssue('RELAY-42'),
        (err) => {
          assert.ok(err instanceof JiraRateLimitError);
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
    it('should handle non-JSON / HTML error pages gracefully without throwing JSON parse error', async () => {
      const htmlError = '<html><body><h1>502 Bad Gateway</h1>Cloudflare</body></html>';
      const mockFetch = async () => {
        return createMockResponse(htmlError, { status: 502, headers: { 'content-type': 'text/html' } });
      };

      const connector = new JiraConnector({
        host: TEST_HOST,
        apiToken: TEST_TOKEN,
        fetchFn: mockFetch,
        retryOptions: { maxAttempts: 1 },
      });

      await assert.rejects(
        () => connector.fetchIssue('RELAY-1'),
        (err) => {
          assert.ok(err instanceof JiraClientError);
          assert.equal(err.statusCode, 502);
          assert.ok(err.message.includes('502 Bad Gateway'));
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 11. Authentication Header Construction (Security Verification)
  // =========================================================================
  describe('11. Authentication Header Construction', () => {
    it('should use Basic Auth base64(email:token) when email is provided', async () => {
      let authHeader = '';
      const mockFetch = async (url, options) => {
        authHeader = options.headers.Authorization;
        return createMockResponse(SAMPLE_RAW_ISSUE);
      };

      const client = new JiraClient({
        host: TEST_HOST,
        email: 'user@company.com',
        apiToken: 'secret_token',
        fetchFn: mockFetch,
      });

      await client.getIssue('RELAY-1');
      const expectedEncoded = Buffer.from('user@company.com:secret_token').toString('base64');
      assert.equal(authHeader, `Basic ${expectedEncoded}`);
    });

    it('should use Bearer Auth when email is omitted', async () => {
      let authHeader = '';
      const mockFetch = async (url, options) => {
        authHeader = options.headers.Authorization;
        return createMockResponse(SAMPLE_RAW_ISSUE);
      };

      const client = new JiraClient({
        host: TEST_HOST,
        apiToken: 'oauth_or_pat_token',
        fetchFn: mockFetch,
      });

      await client.getIssue('RELAY-1');
      assert.equal(authHeader, 'Bearer oauth_or_pat_token');
    });
  });
});
