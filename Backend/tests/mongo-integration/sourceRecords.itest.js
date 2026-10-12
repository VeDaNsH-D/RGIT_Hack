/**
 * REAL MongoDB (mongodb-memory-server) tests for SourceRecord persistence.
 * Run with: npm run test:integration
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMongo, stopMongo, resetCollections } from './harness.js';

await startMongo();
const { SourceRecord } = await import('../../src/models/SourceRecord.js');
const { persistSourceRecordCandidates } = await import('../../src/modules/ingestion/persistence/sourceRecordStore.js');

const PROJECT_A = new mongoose.Types.ObjectId().toHexString();
const PROJECT_B = new mongoose.Types.ObjectId().toHexString();
const T0 = new Date('2026-01-01T00:00:00Z');

const cand = (projectId, over = {}) => ({
  projectId, provider: 'github', recordType: 'issue', externalId: 'I_1', title: 'Login bug',
  content: 'Steps...', contentType: 'text/markdown', url: 'https://github.com/acme/relay/issues/1',
  author: 'alice', authorId: '11', createdAt: T0, updatedAt: T0, fetchedAt: T0,
  version: 1, isActive: true, isDeleted: false,
  metadata: { number: 1, state: 'open', labels: ['bug'] },
  ...over,
});

describe('SourceRecord persistence on real MongoDB', () => {
  after(stopMongo);
  beforeEach(resetCollections);

  it('creates the compound unique index (projectId, provider, externalId)', async () => {
    const indexes = await SourceRecord.collection.indexes();
    const unique = indexes.find((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ projectId: 1, provider: 1, externalId: 1 }));
    assert.ok(unique, 'unique compound index missing');
  });

  it('rejects a second document with the same identity (E11000) but allows other projects/providers', async () => {
    const base = { projectId: PROJECT_A, provider: 'github', externalId: 'x', title: 't' };
    await SourceRecord.create(base);
    await assert.rejects(SourceRecord.create(base), (e) => e.code === 11000);
    await SourceRecord.create({ ...base, projectId: PROJECT_B });
    await SourceRecord.create({ ...base, provider: 'jira' });
    assert.equal(await SourceRecord.countDocuments({}), 3);
  });

  it('creates, retrieves, and reports counts', async () => {
    const r = await persistSourceRecordCandidates({ projectId: PROJECT_A, records: [cand(PROJECT_A)] });
    assert.equal(r.status, 'succeeded');
    assert.deepEqual([r.createdCount, r.updatedCount, r.failedCount], [1, 0, 0]);
    const doc = await SourceRecord.findOne({ projectId: PROJECT_A }).lean();
    assert.equal(doc.type, 'issue');
    assert.equal(doc.provider, 'github');
    assert.equal(doc.content, 'Steps...');
    assert.ok(doc.projectId instanceof mongoose.Types.ObjectId);
    assert.deepEqual(doc.metadata.providerMetadata, { number: 1, state: 'open', labels: ['bug'] });
    assert.equal(doc.metadata.sourceCreatedAt.toISOString(), T0.toISOString());
  });

  it('re-ingesting is idempotent: one document, stable _id and createdAt, newer updatedAt', async () => {
    await persistSourceRecordCandidates({ projectId: PROJECT_A, records: [cand(PROJECT_A)], now: () => new Date('2026-02-01T00:00:00Z') });
    const first = await SourceRecord.findOne({}).lean();
    const r = await persistSourceRecordCandidates({
      projectId: PROJECT_A,
      records: [cand(PROJECT_A, { title: 'Login bug (edited)', content: 'v2' })],
      now: () => new Date('2026-03-01T00:00:00Z'),
    });
    assert.deepEqual([r.createdCount, r.updatedCount], [0, 1]);
    assert.equal(await SourceRecord.countDocuments({}), 1);
    const second = await SourceRecord.findOne({}).lean();
    assert.equal(String(second._id), String(first._id));
    assert.equal(second.createdAt.toISOString(), first.createdAt.toISOString());
    assert.ok(second.updatedAt > first.updatedAt);
    assert.equal(second.title, 'Login bug (edited)');
    assert.equal(second.content, 'v2');
  });

  it('omitted optional values keep stored data; explicit null overwrites; provider metadata merges', async () => {
    await persistSourceRecordCandidates({ projectId: PROJECT_A, records: [cand(PROJECT_A, { metadata: { a: 1, b: 2, c: 3 } })] });
    await persistSourceRecordCandidates({
      projectId: PROJECT_A,
      records: [cand(PROJECT_A, { url: undefined, metadata: { b: 20, c: null, d: 4 } })],
    });
    const doc = await SourceRecord.findOne({}).lean();
    assert.equal(doc.url, 'https://github.com/acme/relay/issues/1', 'omitted url must not blank the stored one');
    assert.deepEqual(doc.metadata.providerMetadata, { a: 1, b: 20, c: null, d: 4 });
  });

  it('isolates projects: same externalId in two projects yields two records', async () => {
    await persistSourceRecordCandidates({ projectId: PROJECT_A, records: [cand(PROJECT_A)] });
    await persistSourceRecordCandidates({ projectId: PROJECT_B, records: [cand(PROJECT_B)] });
    assert.equal(await SourceRecord.countDocuments({ projectId: PROJECT_A }), 1);
    assert.equal(await SourceRecord.countDocuments({ projectId: PROJECT_B }), 1);
    assert.equal(await SourceRecord.countDocuments({}), 2);
  });

  it('duplicates inside one batch are skipped, not double-written', async () => {
    const r = await persistSourceRecordCandidates({ projectId: PROJECT_A, records: [cand(PROJECT_A), cand(PROJECT_A, { title: 'dup' })] });
    assert.equal(await SourceRecord.countDocuments({}), 1);
    assert.equal(r.skippedCount, 1);
  });

  it('concurrent ingestion of the same identity never creates duplicates (race)', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      persistSourceRecordCandidates({ projectId: PROJECT_A, records: [cand(PROJECT_A, { content: `writer-${i}` })] })));
    assert.equal(await SourceRecord.countDocuments({}), 1);
    for (const r of results) assert.equal(r.failedCount, 0, JSON.stringify(r.errors));
    assert.equal(results.reduce((n, r) => n + r.createdCount, 0), 1, 'exactly one writer creates');
  });

  it('writes no credentials to the database', async () => {
    await persistSourceRecordCandidates({
      projectId: PROJECT_A,
      records: [cand(PROJECT_A, { metadata: { accessToken: 'ghs_abcdefghijklmnopqrstuvwxyz0123456789', note: 'ok' } })],
    });
    const raw = JSON.stringify(await SourceRecord.findOne({}).lean());
    assert.ok(!raw.includes('ghs_abcdefghijklmnopqrstuvwxyz'));
    assert.ok(raw.includes('"note":"ok"'));
  });

  it('persists a mixed multi-provider batch with correct per-provider identity', async () => {
    const r = await persistSourceRecordCandidates({
      projectId: PROJECT_A,
      records: [
        cand(PROJECT_A), cand(PROJECT_A, { provider: 'jira', externalId: 'I_1' }),
        cand(PROJECT_A, { provider: 'slack', recordType: 'message', externalId: 'C1:1.0', contentType: 'text/plain' }),
      ],
    });
    assert.equal(r.createdCount, 3);
    assert.equal(await SourceRecord.countDocuments({}), 3);
  });
});
