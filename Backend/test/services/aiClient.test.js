/**
 * @file aiClient.test.js
 * @description Unit tests for AI Context Intelligence client using node:test and node:assert/strict.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AiServiceClient,
  generateContextPack,
  AiServiceError,
  AI_CLIENT_ERROR_CODES,
  sanitizeMessage,
} from '../../src/services/aiClient.js';

const MOCK_VALID_RESPONSE = {
  case_id: 'case_test_101',
  summary: 'API migration is in progress with 1 open blocker.',
  decisions: [
    {
      decision: 'Migrate to v2',
      rationale: 'Unified routing',
      source_ids: ['src_1'],
      decided_at: null,
    },
  ],
  attempted_actions: [],
  blockers: [
    {
      description: 'CORS failures on legacy auth',
      severity: 'high',
      source_ids: ['src_2'],
    },
  ],
  proposed_tasks: [],
  missing_information: [],
  contradictions: [],
};

const MOCK_REQUEST_PAYLOAD = {
  case_id: 'case_test_101',
  case_description: 'Test case description',
  sources: [
    { id: 'src_1', title: 'Commit 1', content: 'v2 migration' },
    { id: 'src_2', title: 'Issue 2', content: 'CORS failure' },
  ],
  tasks: [],
  documents: [],
};

describe('AI Client: Sanitization', () => {
  it('redacts Groq API keys and Bearer tokens', () => {
    const raw = 'Failed with key gsk_1234567890abcdefABCDEF and Bearer my-secret-jwt-token-123';
    const sanitized = sanitizeMessage(raw);
    assert.ok(!sanitized.includes('gsk_1234567890abcdefABCDEF'));
    assert.ok(!sanitized.includes('my-secret-jwt-token-123'));
    assert.ok(sanitized.includes('[REDACTED_API_KEY]'));
    assert.ok(sanitized.includes('Bearer [REDACTED_TOKEN]'));
  });

  it('handles null and non-string inputs safely', () => {
    assert.equal(sanitizeMessage(null), '');
    assert.equal(sanitizeMessage(undefined), '');
  });
});

describe('AI Client: Payload Validation', () => {
  it('rejects null or non-object payloads before sending HTTP request', async () => {
    await assert.rejects(
      async () => generateContextPack(null),
      (err) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, AI_CLIENT_ERROR_CODES.INVALID_PAYLOAD);
        assert.equal(err.status, 400);
        return true;
      }
    );

    await assert.rejects(
      async () => generateContextPack([]),
      (err) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, AI_CLIENT_ERROR_CODES.INVALID_PAYLOAD);
        return true;
      }
    );
  });
});

describe('AI Client: Successful Generation', () => {
  it('dispatches POST to default endpoint and returns validated response', async () => {
    let capturedUrl = '';
    let capturedOptions = {};

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return new Response(JSON.stringify(MOCK_VALID_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new AiServiceClient({ fetchFn: mockFetch });
    const result = await client.generateContextPack(MOCK_REQUEST_PAYLOAD);

    assert.equal(capturedUrl, 'http://127.0.0.1:8001/api/v1/context-packs/generate');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(capturedOptions.body), MOCK_REQUEST_PAYLOAD);

    assert.equal(result.case_id, 'case_test_101');
    assert.equal(result.summary, MOCK_VALID_RESPONSE.summary);
    assert.equal(result.decisions.length, 1);
    assert.equal(result.blockers.length, 1);
  });

  it('honors custom base URL with trailing slash stripped', async () => {
    let capturedUrl = '';

    const mockFetch = async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify(MOCK_VALID_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new AiServiceClient({
      baseUrl: 'http://custom-ai-host:9000///',
      fetchFn: mockFetch,
    });

    await client.generateContextPack(MOCK_REQUEST_PAYLOAD);
    assert.equal(capturedUrl, 'http://custom-ai-host:9000/api/v1/context-packs/generate');
  });

  it('works using the top-level convenience generateContextPack function', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify(MOCK_VALID_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const result = await generateContextPack(MOCK_REQUEST_PAYLOAD, { fetchFn: mockFetch });
    assert.equal(result.case_id, 'case_test_101');
  });
});

describe('AI Client: HTTP Error Handling', () => {
  it('handles 422 Unprocessable Entity (e.g. invalid evidence citation)', async () => {
    const errorBody = {
      detail: 'Invalid evidence citation in AI output: Model cited unknown source IDs: [src_unknown]',
    };

    const mockFetch = async () =>
      new Response(JSON.stringify(errorBody), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });

    await assert.rejects(
      async () => generateContextPack(MOCK_REQUEST_PAYLOAD, { fetchFn: mockFetch }),
      (err) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, AI_CLIENT_ERROR_CODES.HTTP_ERROR);
        assert.equal(err.status, 422);
        assert.ok(err.message.includes('src_unknown'));
        return true;
      }
    );
  });

  it('handles 503 Service Unavailable (e.g. missing GROQ_API_KEY)', async () => {
    const errorBody = {
      detail: 'GROQ_API_KEY is not configured in the environment. Please configure it in aiml/.env.',
    };

    const mockFetch = async () =>
      new Response(JSON.stringify(errorBody), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });

    await assert.rejects(
      async () => generateContextPack(MOCK_REQUEST_PAYLOAD, { fetchFn: mockFetch }),
      (err) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, AI_CLIENT_ERROR_CODES.HTTP_ERROR);
        assert.equal(err.status, 503);
        assert.ok(err.message.includes('GROQ_API_KEY is not configured'));
        return true;
      }
    );
  });

  it('sanitizes secrets in HTTP error response bodies', async () => {
    const errorBody = {
      detail: 'Failed with key gsk_secret_1234567890',
    };

    const mockFetch = async () =>
      new Response(JSON.stringify(errorBody), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });

    await assert.rejects(
      async () => generateContextPack(MOCK_REQUEST_PAYLOAD, { fetchFn: mockFetch }),
      (err) => {
        assert.ok(!err.message.includes('gsk_secret_1234567890'));
        assert.ok(err.message.includes('[REDACTED_API_KEY]'));
        return true;
      }
    );
  });
});

describe('AI Client: Timeout & Connection Errors', () => {
  it('throws TIMEOUT error when request exceeds timeout limit', async () => {
    const mockFetch = async (url, options) => {
      // Simulate timeout abort
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      throw abortError;
    };

    await assert.rejects(
      async () => generateContextPack(MOCK_REQUEST_PAYLOAD, { timeoutMs: 50, fetchFn: mockFetch }),
      (err) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, AI_CLIENT_ERROR_CODES.TIMEOUT);
        assert.equal(err.status, 504);
        assert.ok(err.message.includes('timed out'));
        return true;
      }
    );
  });

  it('throws CONNECTION_ERROR when network connection fails', async () => {
    const mockFetch = async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8001');
    };

    await assert.rejects(
      async () => generateContextPack(MOCK_REQUEST_PAYLOAD, { fetchFn: mockFetch }),
      (err) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, AI_CLIENT_ERROR_CODES.CONNECTION_ERROR);
        assert.equal(err.status, 502);
        assert.ok(err.message.includes('Failed to connect'));
        return true;
      }
    );
  });
});

describe('AI Client: Malformed Model Response Handling', () => {
  it('throws MALFORMED_RESPONSE when response body is not valid JSON', async () => {
    const mockFetch = async () =>
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 200, // Status 200 with HTML/text
        headers: { 'Content-Type': 'text/html' },
      });

    await assert.rejects(
      async () => generateContextPack(MOCK_REQUEST_PAYLOAD, { fetchFn: mockFetch }),
      (err) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, AI_CLIENT_ERROR_CODES.MALFORMED_RESPONSE);
        assert.equal(err.status, 502);
        return true;
      }
    );
  });

  it('throws MALFORMED_RESPONSE when required fields like summary or case_id are missing', async () => {
    const invalidData = {
      case_id: 'case_test_101',
      // missing summary
      decisions: [],
    };

    const mockFetch = async () =>
      new Response(JSON.stringify(invalidData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    await assert.rejects(
      async () => generateContextPack(MOCK_REQUEST_PAYLOAD, { fetchFn: mockFetch }),
      (err) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, AI_CLIENT_ERROR_CODES.MALFORMED_RESPONSE);
        assert.equal(err.status, 502);
        return true;
      }
    );
  });
});
