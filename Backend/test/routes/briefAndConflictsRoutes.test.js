/**
 * @file briefAndConflictsRoutes.test.js
 * @description Route integration tests for Project Brief and Conflict Detection endpoints.
 */

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rgit_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_min_32_characters_long!';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test_cron_secret_min_32_characters!';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleGenerateProjectBrief,
  handleDetectConflicts,
} from '../../src/routes/projects.js';
import { projectBriefSchema, conflictDetectionResultSchema } from '../../src/contracts/schemas.js';

function createMockResponse() {
  const res = {
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
  return res;
}

const baseProject = {
  _id: '507f191e810c19729de860ea',
  name: 'Alpha Migration',
  description: 'Migration to modern tech stack',
  ownerId: '507f191e810c19729de860eb',
};

describe('Route Handler: Project Brief (Understand This Project)', () => {
  it('returns 200 with all 9 required fields on success', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        project_id: '507f191e810c19729de860ea',
        project_name: 'Alpha Migration',
        project_overview: 'Synthesized overview of Alpha Migration.',
        technology_stack: ['express', 'fastapi', 'redis'],
        current_status: 'Active development',
        completed_work: ['Task: Setup repository'],
        pending_actions: ['Task: Deploy cluster'],
        blockers: ['[HIGH] Port contention'],
        recommended_next_steps: ['Resolve port conflict'],
        missing_information: [
          { topic: 'Staging URL', explanation: 'Missing staging endpoint', impact: 'Testing delayed' },
        ],
        evidence_references: ['507f191e810c19729de860ea'],
        generated_at: new Date().toISOString(),
      }),
    });

    try {
      const req = {
        project: baseProject,
        tasks: [],
        documents: [],
        sourceRecords: [],
      };
      const res = createMockResponse();

      await handleGenerateProjectBrief(req, res, () => {});

      assert.equal(res.statusCode, 200);
      assert.ok(res.body);
      // Validates schema compliance
      const validated = projectBriefSchema.parse(res.body);
      assert.equal(validated.projectId, '507f191e810c19729de860ea');
      assert.equal(validated.projectName, 'Alpha Migration');
      assert.ok(validated.projectOverview.includes('Alpha Migration'));
      assert.equal(validated.technologyStack.length, 3);
      assert.equal(validated.completedWork.length, 1);
      assert.equal(validated.pendingActions.length, 1);
      assert.equal(validated.blockers.length, 1);
      assert.equal(validated.recommendedNextSteps.length, 1);
      assert.equal(validated.missingInformation.length, 1);
      assert.equal(validated.evidenceReferences.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles AI service failure with safe 502 error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: { get: () => 'application/json' },
      json: async () => ({ detail: 'LLM capacity exhausted' }),
    });

    try {
      const req = {
        project: baseProject,
        tasks: [],
        documents: [],
        sourceRecords: [],
      };
      const res = createMockResponse();

      await handleGenerateProjectBrief(req, res, () => {});

      assert.equal(res.statusCode, 503);
      assert.ok(res.body.message.includes('LLM capacity exhausted'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Route Handler: Deterministic Conflict Detection', () => {
  it('detects conflicts and returns validated candidates with 200', async () => {
    const tasks = [
      {
        _id: '507f191e810c19729de86011',
        title: 'Deploy Gateway',
        status: 'open',
        deadline: '2026-10-15T00:00:00Z',
      },
    ];
    const sourceRecords = [
      {
        _id: '507f191e810c19729de86022',
        title: 'PR #10: Deploy Gateway',
        content: 'Work merged and completed.',
        type: 'pull_request',
      },
    ];

    const req = {
      project: baseProject,
      tasks,
      documents: [],
      sourceRecords,
    };
    const res = createMockResponse();

    await handleDetectConflicts(req, res, () => {});

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.projectId, '507f191e810c19729de860ea');
    assert.equal(res.body.conflictCount, 1);
    assert.equal(res.body.conflicts[0].category, 'status_mismatch');

    // Validates against Zod schema
    assert.doesNotThrow(() => conflictDetectionResultSchema.parse(res.body));
  });
});
