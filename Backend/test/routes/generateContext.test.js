/**
 * @file generateContext.test.js
 * @description Unit tests for POST /api/projects/:id/ai/generate-context route and middleware using node:test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Set mock environment variables before importing modules that load config.js
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/relay_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || '01234567890123456789012345678901';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test_cron_secret_value_32chars';

const { handleGenerateContext } = await import('../../src/routes/projects.js');
const { requireRole } = await import('../../src/middleware/access.js');
const { requireAuth } = await import('../../src/middleware/auth.js');
const { AI_CLIENT_ERROR_CODES } = await import('../../src/services/aiClient.js');

// --- Mock Response Helper ----------------------------------------------------

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

describe('POST /api/projects/:id/ai/generate-context: Route Handler', () => {
  const baseReq = {
    project: {
      _id: '507f1f77bcf86cd799439011',
      name: 'Auth Gateway',
      description: 'API Gateway project',
    },
    tasks: [],
    documents: [],
    sourceRecords: [],
  };

  it('returns 200 with generated AI context intelligence on success', async () => {
    const mockAiResponse = {
      case_id: '507f1f77bcf86cd799439011',
      summary: 'Auth Gateway is healthy with 0 blockers.',
      decisions: [],
      attempted_actions: [],
      blockers: [],
      proposed_tasks: [],
      missing_information: [],
      contradictions: [],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockAiResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    try {
      const req = { ...baseReq };
      const res = createMockResponse();
      let nextCalled = false;

      await handleGenerateContext(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.case_id, '507f1f77bcf86cd799439011');
      assert.equal(res.body.summary, mockAiResponse.summary);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps AI service timeout to HTTP 504 with sanitized message', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    };

    try {
      const req = { ...baseReq };
      const res = createMockResponse();

      await handleGenerateContext(req, res, () => {});

      assert.equal(res.statusCode, 504);
      assert.equal(res.body.error, AI_CLIENT_ERROR_CODES.TIMEOUT);
      assert.ok(res.body.message.includes('timed out'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps AI connection failure to HTTP 502 with safe error message', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8001');
    };

    try {
      const req = { ...baseReq };
      const res = createMockResponse();

      await handleGenerateContext(req, res, () => {});

      assert.equal(res.statusCode, 502);
      assert.equal(res.body.error, AI_CLIENT_ERROR_CODES.CONNECTION_ERROR);
      assert.ok(res.body.message.includes('Failed to connect'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps AI service HTTP 422 (e.g. invalid evidence citation) properly', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: 'Model cited invalid evidence: [unknown_id]' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });

    try {
      const req = { ...baseReq };
      const res = createMockResponse();

      await handleGenerateContext(req, res, () => {});

      assert.equal(res.statusCode, 422);
      assert.equal(res.body.error, AI_CLIENT_ERROR_CODES.HTTP_ERROR);
      assert.ok(res.body.message.includes('unknown_id'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('passes unexpected errors to Express next(err) handler', async () => {
    const req = {
      project: {
        get _id() {
          throw new RangeError('Unexpected memory error');
        },
      },
    };
    const res = createMockResponse();
    let capturedError = null;

    await handleGenerateContext(req, res, (err) => {
      capturedError = err;
    });

    assert.ok(capturedError instanceof RangeError);
    assert.equal(capturedError.message, 'Unexpected memory error');
  });
});

describe('POST /api/projects/:id/ai/generate-context: Authentication & Authorization Middleware', () => {
  it('requireAuth rejects requests missing bearer token with 401', async () => {
    const req = { headers: {} };
    const res = createMockResponse();
    let nextCalled = false;

    await requireAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
  });

  it('requireAuth rejects invalid token format with 401', async () => {
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
    const res = createMockResponse();
    let nextCalled = false;

    await requireAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('requireRole rejects when caller membership rank is insufficient with 403', () => {
    const middleware = requireRole('owner');
    const req = {
      membership: { role: 'viewer' },
    };
    const res = createMockResponse();
    let nextCalled = false;

    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'forbidden');
  });

  it('requireRole allows when caller membership meets role rank requirement', () => {
    const middleware = requireRole('viewer');
    const req = {
      membership: { role: 'viewer' },
    };
    const res = createMockResponse();
    let nextCalled = false;

    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });
});
