/**
 * @file conflictDetector.test.js
 * @description Unit tests for deterministic conflict detector in Express backend.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectProjectConflicts,
  extractFacts,
  normalizeSubject,
  computeFingerprint,
} from '../../src/services/conflictDetector.js';
import { conflictDetectionResultSchema } from '../../src/contracts/schemas.js';

describe('Deterministic Conflict Detector: Core Helpers', () => {
  it('normalizeSubject normalizes casing, stop words, and special characters', () => {
    const s1 = normalizeSubject('Deploy the Redis Cluster with PKCE!');
    const s2 = normalizeSubject('deploy redis cluster pkce');
    assert.equal(s1, s2);
  });

  it('computeFingerprint is deterministic and symmetric across ID order', () => {
    const fp1 = computeFingerprint('deadline_mismatch', 'auth task', 'id_1', 'id_2');
    const fp2 = computeFingerprint('deadline_mismatch', 'auth task', 'id_2', 'id_1');
    assert.equal(fp1, fp2);
    assert.equal(typeof fp1, 'string');
    assert.equal(fp1.length, 32);
  });
});

describe('Deterministic Conflict Detector: Categories and Evidence', () => {
  it('detects genuine deadline mismatch between task and document', () => {
    const tasks = [
      {
        _id: '507f191e810c19729de860ea',
        title: 'Migrate OAuth2 Gateway',
        deadline: '2026-10-15T00:00:00Z',
        status: 'open',
        createdAt: '2026-10-01T10:00:00Z',
      },
    ];
    const documents = [
      {
        _id: '507f191e810c19729de860eb',
        title: 'Architecture Spec',
        extractedText: 'Migrate OAuth2 Gateway deadline: 2026-10-31.',
        createdAt: '2026-10-05T12:00:00Z',
      },
    ];

    const result = detectProjectConflicts({
      projectId: 'proj_123',
      tasks,
      documents,
    });

    assert.equal(result.projectId, 'proj_123');
    assert.equal(result.conflictCount, 1);
    const conflict = result.conflicts[0];
    assert.equal(conflict.category, 'deadline_mismatch');
    assert.equal(conflict.severity, 'high');
    assert.ok(conflict.description.includes('2026-10-15'));
    assert.ok(conflict.description.includes('2026-10-31'));
    assert.equal(conflict.evidence.length, 2);
    assert.equal(conflict.evidence[0].sourceRecordId, '507f191e810c19729de860ea');
    assert.equal(conflict.evidence[1].documentId, '507f191e810c19729de860eb');

    // Validates with Zod schema
    assert.doesNotThrow(() => conflictDetectionResultSchema.parse(result));
  });

  it('detects genuine status mismatch between open task and completed PR', () => {
    const tasks = [
      {
        _id: '507f191e810c19729de860ea',
        title: 'Implement PKCE verification',
        status: 'open',
        createdAt: '2026-10-01T10:00:00Z',
      },
    ];
    const sourceRecords = [
      {
        _id: '507f191e810c19729de860ec',
        title: 'PR #42: Implement PKCE verification',
        content: 'PR merged and deployed to staging. Work completed.',
        type: 'pull_request',
        createdAt: '2026-10-08T15:00:00Z',
      },
    ];

    const result = detectProjectConflicts({
      projectId: 'proj_123',
      tasks,
      sourceRecords,
    });

    assert.equal(result.conflictCount, 1);
    const conflict = result.conflicts[0];
    assert.equal(conflict.category, 'status_mismatch');
    assert.ok(conflict.description.includes('open'));
    assert.ok(conflict.description.includes('completed'));
    assert.ok(conflict.description.includes('newer than'));
    assert.equal(conflict.evidence.length, 2);
  });

  it('unrelated facts do not produce conflicts', () => {
    const tasks = [
      {
        _id: 'task_1',
        title: 'Setup Redis cluster',
        deadline: '2026-10-15T00:00:00Z',
        status: 'open',
      },
      {
        _id: 'task_2',
        title: 'Update UI button styles',
        deadline: '2026-10-30T00:00:00Z',
        status: 'open',
      },
    ];

    const result = detectProjectConflicts({
      projectId: 'proj_123',
      tasks,
    });

    assert.equal(result.conflictCount, 0);
  });

  it('matching facts with identical values do not produce conflicts', () => {
    const tasks = [
      {
        _id: 'task_1',
        title: 'Migrate OAuth2 Gateway',
        deadline: '2026-10-15T00:00:00Z',
        status: 'open',
      },
    ];
    const documents = [
      {
        _id: 'doc_1',
        title: 'Spec',
        extractedText: 'Migrate OAuth2 Gateway deadline: 2026-10-15.',
      },
    ];

    const result = detectProjectConflicts({
      projectId: 'proj_123',
      tasks,
      documents,
    });

    assert.equal(result.conflictCount, 0);
  });

  it('isolated single-source fact produces zero conflicts', () => {
    const tasks = [
      {
        _id: 'task_1',
        title: 'Solo unconfirmed task',
        deadline: '2026-10-20T00:00:00Z',
        status: 'open',
      },
    ];

    const result = detectProjectConflicts({
      projectId: 'proj_123',
      tasks,
    });

    assert.equal(result.conflictCount, 0);
  });

  it('preserves both competing sources when records have different timestamps', () => {
    const facts = [
      {
        factType: 'deadline',
        subject: 'Database Migration',
        value: '2026-10-10',
        sourceRecordId: 'older_source',
        sourceType: 'task',
        excerpt: 'Older deadline 2026-10-10',
        timestamp: '2026-10-01T00:00:00.000Z',
      },
      {
        factType: 'deadline',
        subject: 'Database Migration',
        value: '2026-10-25',
        sourceRecordId: 'newer_source',
        sourceType: 'note',
        excerpt: 'Newer deadline 2026-10-25',
        timestamp: '2026-10-09T00:00:00.000Z',
      },
    ];

    const result = detectProjectConflicts({
      projectId: 'proj_123',
      facts,
    });

    assert.equal(result.conflictCount, 1);
    const c = result.conflicts[0];
    assert.ok(c.description.includes("Source 'newer_source' is newer than Source 'older_source'"));
    assert.equal(c.evidence.length, 2);
    assert.equal(c.evidence[0].sourceRecordId, 'older_source');
    assert.equal(c.evidence[1].sourceRecordId, 'newer_source');
  });

  it('does not mutate input parameters', () => {
    const originalTasks = Object.freeze([
      Object.freeze({
        _id: 't_freeze',
        title: 'Freeze test',
        status: 'open',
      }),
    ]);

    assert.doesNotThrow(() => {
      detectProjectConflicts({
        projectId: 'proj_123',
        tasks: originalTasks,
      });
    });
  });
});
