/**
 * @file sourceRecord.test.js
 * @description Unit tests for the shared SourceRecordCandidate contract, the
 * candidate -> persisted SourceRecord mapping, and the ingestion result helpers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCE_PROVIDERS,
  SOURCE_RECORD_TYPES,
  SOURCE_CONTENT_TYPES,
  INGESTION_STATUS,
  RESOURCE_STATUS,
  validateSourceRecordCandidate,
  toSourceRecordDocument,
  createIngestionResult,
  finalizeIngestionResult,
} from './sourceRecord.js';

function validCandidate(overrides = {}) {
  return {
    projectId: '665f1c2e8b3a4d0012345678',
    provider: SOURCE_PROVIDERS.GITHUB,
    recordType: SOURCE_RECORD_TYPES.ISSUE,
    externalId: 'I_kwDOABC123',
    title: 'Login fails on Safari',
    content: 'Steps to reproduce...',
    contentType: SOURCE_CONTENT_TYPES.MARKDOWN,
    url: 'https://github.com/acme/relay/issues/1',
    author: 'octocat',
    authorId: '1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    fetchedAt: new Date('2026-10-12T10:00:00Z'),
    version: 1,
    isActive: true,
    isDeleted: false,
    metadata: { number: 1, state: 'open' },
    ...overrides,
  };
}

describe('SourceRecordCandidate contract validation', () => {
  it('accepts a complete valid candidate', () => {
    assert.deepEqual(validateSourceRecordCandidate(validCandidate()), { valid: true, errors: [] });
  });

  it('accepts a candidate with all optional fields omitted', () => {
    const minimal = validCandidate();
    for (const key of ['url', 'author', 'authorId', 'createdAt', 'updatedAt', 'metadata']) delete minimal[key];
    assert.equal(validateSourceRecordCandidate(minimal).valid, true);
  });

  it('rejects persistence-owned "id" even when recordType is absent', () => {
    const candidate = validCandidate({ id: 'abc' });
    delete candidate.recordType;
    const result = validateSourceRecordCandidate(candidate);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('internal database IDs')));
  });

  it('rejects "_id"', () => {
    assert.equal(validateSourceRecordCandidate(validCandidate({ _id: 'x' })).valid, false);
  });

  it('rejects the persisted field name "type" in place of recordType', () => {
    const result = validateSourceRecordCandidate(validCandidate({ type: 'issue' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('"type"')));
  });

  it('rejects unknown providers and record types', () => {
    const result = validateSourceRecordCandidate(validCandidate({ provider: 'gitlab', recordType: 'wiki' }));
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 2);
  });

  it('rejects non-integer versions, invalid dates, non-http URLs and array metadata', () => {
    const cases = [
      { version: 1.5 },
      { version: 0 },
      { fetchedAt: '2026-10-12T10:00:00Z' },
      { createdAt: new Date('invalid') },
      { url: 'javascript:alert(1)' },
      { metadata: ['a'] },
      { title: '   ' },
      { content: null },
    ];
    for (const override of cases) {
      assert.equal(validateSourceRecordCandidate(validCandidate(override)).valid, false, JSON.stringify(override));
    }
  });

  it('rejects non-object inputs', () => {
    for (const value of [null, undefined, 'x', 42, []]) {
      assert.equal(validateSourceRecordCandidate(value).valid, false);
    }
  });
});

describe('Candidate -> persisted SourceRecord mapping', () => {
  it('maps recordType to type and keeps the unique key fields', () => {
    const doc = toSourceRecordDocument(validCandidate());
    assert.equal(doc.type, 'issue');
    assert.equal(doc.recordType, undefined);
    assert.equal(doc.projectId, '665f1c2e8b3a4d0012345678');
    assert.equal(doc.provider, 'github');
    assert.equal(doc.externalId, 'I_kwDOABC123');
    assert.equal(doc._id, undefined);
    assert.equal(doc.id, undefined);
  });

  it('stores source timestamps under metadata so Mongoose timestamps are not overwritten', () => {
    const doc = toSourceRecordDocument(validCandidate());
    assert.equal(doc.createdAt, undefined);
    assert.equal(doc.updatedAt, undefined);
    assert.equal(doc.metadata.sourceCreatedAt.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(doc.metadata.sourceUpdatedAt.toISOString(), '2026-01-02T00:00:00.000Z');
    assert.equal(doc.metadata.fetchedAt.toISOString(), '2026-10-12T10:00:00.000Z');
  });

  it('nests provider metadata and preserves candidate-only fields', () => {
    const doc = toSourceRecordDocument(validCandidate());
    assert.deepEqual(doc.metadata.providerMetadata, { number: 1, state: 'open' });
    assert.equal(doc.metadata.contentType, 'text/markdown');
    assert.equal(doc.metadata.author, 'octocat');
    assert.equal(doc.metadata.isActive, true);
    assert.equal(doc.metadata.version, 1);
  });

  it('only emits fields defined on the SourceRecord model', () => {
    const doc = toSourceRecordDocument(validCandidate({ url: undefined }));
    assert.deepEqual(Object.keys(doc).sort(), [
      'content', 'externalId', 'metadata', 'projectId', 'provider', 'title', 'type', 'url',
    ]);
    assert.equal(doc.url, '');
  });

  it('serializes timestamps to ISO 8601 at JSON boundaries', () => {
    const json = JSON.parse(JSON.stringify(toSourceRecordDocument(validCandidate())));
    assert.equal(json.metadata.sourceCreatedAt, '2026-01-01T00:00:00.000Z');
  });

  it('refuses to map an invalid candidate', () => {
    assert.throws(() => toSourceRecordDocument(validCandidate({ _id: 'x' })), TypeError);
  });
});

describe('Ingestion result helpers', () => {
  it('creates a result that does not claim persistence', () => {
    const result = createIngestionResult({
      provider: 'github',
      projectId: 'p1',
      resources: ['issues'],
      startedAt: new Date('2026-10-12T10:00:00Z'),
    });
    assert.equal(result.persisted, false);
    assert.equal(result.createdCount, null);
    assert.equal(result.updatedCount, null);
    assert.equal(result.startedAt, '2026-10-12T10:00:00.000Z');
    assert.equal(result.resources.issues.status, RESOURCE_STATUS.SKIPPED);
  });

  it('finalizes totals and status: succeeded / partial / failed', () => {
    const make = () => createIngestionResult({ provider: 'github', projectId: 'p1', resources: ['a', 'b'] });

    const ok = make();
    Object.assign(ok.resources.a, { status: RESOURCE_STATUS.SUCCEEDED, fetchedCount: 3, normalizedCount: 2, skippedCount: 1 });
    Object.assign(ok.resources.b, { status: RESOURCE_STATUS.SUCCEEDED });
    finalizeIngestionResult(ok);
    assert.equal(ok.status, INGESTION_STATUS.SUCCEEDED);
    assert.equal(ok.fetchedCount, 3);
    assert.equal(ok.normalizedCount, 2);
    assert.equal(ok.skippedCount, 1);
    assert.ok(ok.completedAt);

    const partial = make();
    partial.resources.a.status = RESOURCE_STATUS.SUCCEEDED;
    partial.resources.b.status = RESOURCE_STATUS.FAILED;
    partial.errors.push({ resource: 'b', code: 'RATE_LIMITED', message: 'x' });
    assert.equal(finalizeIngestionResult(partial).status, INGESTION_STATUS.PARTIAL);

    const failed = make();
    failed.resources.a.status = RESOURCE_STATUS.FAILED;
    failed.errors.push({ resource: 'a', code: 'AUTH_FAILED', message: 'x' });
    assert.equal(finalizeIngestionResult(failed).status, INGESTION_STATUS.FAILED);
  });
});
