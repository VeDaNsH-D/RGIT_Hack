/**
 * @file sourceRecordStore.test.js
 * @description Tests for SourceRecordCandidate persistence: idempotent upserts,
 * deduplication, partial failures, metadata merge, secret scrubbing, and
 * multi-provider compatibility. Uses an in-memory model; no database required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import mongoose from 'mongoose';

import {
  persistSourceRecordCandidates,
  buildUpsertOperation,
  sanitizeMetadata,
  PERSISTENCE_ERROR_CODES,
} from './sourceRecordStore.js';
import { InMemorySourceRecordModel } from './inMemorySourceRecordModel.js';
import { SourceRecord } from '../../../models/SourceRecord.js';
import { normalizeIssue, normalizeCommit } from '../providers/github/githubNormalizer.js';
import { normalizeNotionPageCandidate } from '../providers/notion/notionNormalizer.js';
import { normalizeJiraIssueCandidate, normalizeJiraIssue } from '../providers/jira/jiraNormalizer.js';
import { normalizeSlackMessageCandidate } from '../providers/slack/slackNormalizer.js';

const PROJECT_ID = '665f1c2e8b3a4d0012345678';
const OTHER_PROJECT_ID = '665f1c2e8b3a4d0087654321';
const FETCHED_AT = new Date('2026-10-12T10:00:00Z');

function candidate(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    provider: 'github',
    recordType: 'issue',
    externalId: 'I_1',
    title: 'Login bug',
    content: 'Steps...',
    contentType: 'text/markdown',
    url: 'https://github.com/acme/relay/issues/1',
    author: 'alice',
    authorId: '11',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    fetchedAt: FETCHED_AT,
    version: 1,
    isActive: true,
    isDeleted: false,
    metadata: { number: 1, state: 'open', labels: ['bug'] },
    ...overrides,
  };
}

function persist(model, records, extra = {}) {
  return persistSourceRecordCandidates({ projectId: PROJECT_ID, records, model, now: () => FETCHED_AT, ...extra });
}

describe('persistSourceRecordCandidates: inserts and idempotent updates', () => {
  it('inserts new records using the model field names', async () => {
    const model = new InMemorySourceRecordModel();
    const result = await persist(model, [candidate(), candidate({ externalId: 'I_2', title: 'Second' })]);

    assert.equal(result.status, 'succeeded');
    assert.equal(result.persisted, true);
    assert.equal(result.receivedCount, 2);
    assert.equal(result.createdCount, 2);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.provider, 'github');
    assert.equal(model.docs.size, 2);

    const doc = model.find({ projectId: PROJECT_ID, provider: 'github', externalId: 'I_1' });
    assert.equal(doc.type, 'issue');
    assert.equal(doc.recordType, undefined);
    assert.ok(doc.projectId instanceof mongoose.Types.ObjectId);
    assert.equal(doc.metadata.sourceCreatedAt.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(doc.metadata.fetchedAt.toISOString(), FETCHED_AT.toISOString());
    assert.deepEqual(doc.metadata.providerMetadata.labels, ['bug']);
  });

  it('updates an existing record in place, preserving _id and isDemo', async () => {
    const model = new InMemorySourceRecordModel();
    const existing = model.seed({
      projectId: new mongoose.Types.ObjectId(PROJECT_ID), provider: 'github', externalId: 'I_1',
      type: 'issue', title: 'Old title', isDemo: true,
    });

    const result = await persist(model, [candidate({ title: 'New title' })]);

    assert.equal(result.createdCount, 0);
    assert.equal(result.updatedCount, 1);
    assert.equal(model.docs.size, 1);
    const doc = model.all()[0];
    assert.equal(String(doc._id), String(existing._id));
    assert.equal(doc.title, 'New title');
    assert.equal(doc.isDemo, true);
  });

  it('re-ingesting the same batch updates instead of duplicating', async () => {
    const model = new InMemorySourceRecordModel();
    const batch = [candidate(), candidate({ externalId: 'I_2' }), candidate({ externalId: 'I_3' })];

    const first = await persist(model, batch);
    const idsAfterFirst = model.all().map((d) => String(d._id)).sort();
    const second = await persist(model, batch);

    assert.deepEqual([first.createdCount, first.updatedCount], [3, 0]);
    assert.deepEqual([second.createdCount, second.updatedCount], [0, 3]);
    assert.equal(model.docs.size, 3);
    assert.deepEqual(model.all().map((d) => String(d._id)).sort(), idsAfterFirst);
  });

  it('keeps the same externalId separate across projects and providers', async () => {
    const model = new InMemorySourceRecordModel();
    await persist(model, [candidate(), candidate({ provider: 'jira' })]);
    await persistSourceRecordCandidates({
      projectId: OTHER_PROJECT_ID, records: [candidate({ projectId: OTHER_PROJECT_ID })], model,
    });
    assert.equal(model.docs.size, 3);
  });

  it('skips earlier duplicates of the same identity within a batch', async () => {
    const model = new InMemorySourceRecordModel();
    const result = await persist(model, [candidate({ title: 'first' }), candidate({ title: 'second' })]);

    assert.equal(result.skippedCount, 1);
    assert.equal(result.createdCount, 1);
    assert.equal(result.errors[0].code, PERSISTENCE_ERROR_CODES.DUPLICATE_IN_BATCH);
    assert.equal(result.errors[0].index, 0);
    assert.equal(model.all()[0].title, 'second');
  });

  it('writes in chunks', async () => {
    const model = new InMemorySourceRecordModel();
    const batch = Array.from({ length: 5 }, (_, i) => candidate({ externalId: `I_${i}` }));
    const result = await persist(model, batch, { chunkSize: 2 });
    assert.equal(model.bulkWriteCalls.length, 3);
    assert.equal(result.createdCount, 5);
    assert.equal(model.bulkWriteCalls[0].options.ordered, false);
  });
});

describe('persistSourceRecordCandidates: metadata merge', () => {
  it('does not erase stored fields when a provider omits optional values', async () => {
    const model = new InMemorySourceRecordModel();
    await persist(model, [candidate({ metadata: { number: 1, state: 'open', milestone: 'v1' } })]);

    const sparse = candidate({ url: undefined, author: undefined, authorId: undefined, metadata: { state: 'closed' } });
    const result = await persist(model, [sparse]);
    assert.equal(result.updatedCount, 1);

    const doc = model.all()[0];
    assert.equal(doc.url, 'https://github.com/acme/relay/issues/1');
    assert.equal(doc.metadata.author, 'alice');
    assert.equal(doc.metadata.providerMetadata.state, 'closed');
    assert.equal(doc.metadata.providerMetadata.milestone, 'v1');
    assert.equal(doc.metadata.providerMetadata.number, 1);
  });

  it('writes explicit nulls from the provider (a value genuinely cleared at the source)', async () => {
    const model = new InMemorySourceRecordModel();
    await persist(model, [candidate({ metadata: { milestone: 'v1' } })]);
    await persist(model, [candidate({ metadata: { milestone: null } })]);
    assert.equal(model.all()[0].metadata.providerMetadata.milestone, null);
  });

  it('defaults url to "" and providerMetadata to {} on insert only', async () => {
    const op = buildUpsertOperation(candidate({ url: undefined, metadata: undefined }), new mongoose.Types.ObjectId(PROJECT_ID));
    assert.deepEqual(op.updateOne.update.$setOnInsert, { url: '', 'metadata.providerMetadata': {} });
    assert.equal(op.updateOne.update.$set.url, undefined);
  });
});

describe('persistSourceRecordCandidates: validation and errors', () => {
  it('rejects a missing or malformed projectId before touching the database', async () => {
    const model = new InMemorySourceRecordModel();
    for (const projectId of [undefined, '', 'default-project', 'acme/relay', 12345, PROJECT_ID.slice(1)]) {
      await assert.rejects(
        () => persistSourceRecordCandidates({ projectId, records: [candidate()], model }),
        { code: PERSISTENCE_ERROR_CODES.INVALID_PROJECT_ID },
      );
    }
    assert.equal(model.bulkWriteCalls.length, 0);
  });

  it('rejects a non-array records argument', async () => {
    await assert.rejects(
      () => persistSourceRecordCandidates({ projectId: PROJECT_ID, records: 'x', model: new InMemorySourceRecordModel() }),
      { code: PERSISTENCE_ERROR_CODES.INVALID_INPUT },
    );
  });

  it('fails invalid records individually and persists the rest', async () => {
    const model = new InMemorySourceRecordModel();
    const result = await persist(model, [
      candidate(),
      candidate({ externalId: 'I_bad', title: '' }),
      null,
      candidate({ externalId: 'I_other', projectId: OTHER_PROJECT_ID }),
      candidate({ externalId: 'I_big', content: 'x'.repeat(1_000_001) }),
    ]);

    assert.equal(result.status, 'partial');
    assert.equal(result.createdCount, 1);
    assert.equal(result.failedCount, 4);
    assert.deepEqual(result.errors.map((e) => [e.index, e.code]), [
      [1, PERSISTENCE_ERROR_CODES.INVALID_RECORD],
      [2, PERSISTENCE_ERROR_CODES.INVALID_RECORD],
      [3, PERSISTENCE_ERROR_CODES.PROJECT_MISMATCH],
      [4, PERSISTENCE_ERROR_CODES.RECORD_TOO_LARGE],
    ]);
    assert.equal(result.errors[1].externalId, null);
    assert.equal(model.docs.size, 1);
  });

  it('rejects legacy integrations/common records with guidance', async () => {
    const legacy = normalizeJiraIssue({ key: 'REL-1', fields: { summary: 'Legacy' } }, { projectId: PROJECT_ID });
    const result = await persist(new InMemorySourceRecordModel(), [legacy]);
    assert.equal(result.failedCount, 1);
    assert.equal(result.errors[0].code, PERSISTENCE_ERROR_CODES.UNSUPPORTED_RECORD_FORMAT);
    assert.match(result.errors[0].message, /asCandidate/);
  });

  it('reports a fully failed batch without claiming persistence', async () => {
    const model = new InMemorySourceRecordModel();
    const result = await persist(model, [candidate({ title: '' })]);
    assert.equal(result.status, 'failed');
    assert.equal(result.persisted, false);
    assert.equal(model.bulkWriteCalls.length, 0);
  });

  it('treats an empty batch as a successful no-op', async () => {
    const model = new InMemorySourceRecordModel();
    const result = await persist(model, []);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.persisted, false);
    assert.equal(model.bulkWriteCalls.length, 0);
  });
});

describe('persistSourceRecordCandidates: write failures and races', () => {
  it('retries a duplicate-key race once and counts it as an update', async () => {
    const model = new InMemorySourceRecordModel();
    model.raceOn('I_2');
    const result = await persist(model, [candidate(), candidate({ externalId: 'I_2', title: 'ours' })]);

    assert.equal(result.status, 'succeeded');
    assert.equal(result.createdCount, 1);
    assert.equal(result.updatedCount, 1);
    assert.equal(model.docs.size, 2);
    assert.equal(model.bulkWriteCalls.length, 2);
    assert.equal(model.bulkWriteCalls[1].ops.length, 1);
    assert.equal(model.find({ projectId: PROJECT_ID, provider: 'github', externalId: 'I_2' }).title, 'ours');
  });

  it('reports per-record write errors while keeping successful writes (partial batch)', async () => {
    const model = new InMemorySourceRecordModel();
    model.failOn('I_2', { code: 121, errmsg: 'Document failed validation' });
    const result = await persist(model, [candidate(), candidate({ externalId: 'I_2' }), candidate({ externalId: 'I_3' })]);

    assert.equal(result.status, 'partial');
    assert.equal(result.persisted, true);
    assert.equal(result.createdCount, 2);
    assert.equal(result.failedCount, 1);
    assert.equal(result.errors[0].code, PERSISTENCE_ERROR_CODES.WRITE_FAILED);
    assert.equal(result.errors[0].externalId, 'I_2');
    assert.match(result.errors[0].message, /code 121/);
  });

  it('does not retry duplicate-key errors forever', async () => {
    const model = new InMemorySourceRecordModel();
    model.failOn('I_1', { code: 11000, errmsg: 'E11000 duplicate key' });
    const result = await persist(model, [candidate()]);
    assert.equal(model.bulkWriteCalls.length, 2);
    assert.equal(result.failedCount, 1);
    assert.equal(result.status, 'failed');
  });

  it('marks a whole chunk failed on a non-write database error', async () => {
    const model = new InMemorySourceRecordModel();
    model.failNextBulkWrite(new Error('connection closed: mongodb+srv://user:hunter2@cluster'));
    const result = await persist(model, [candidate(), candidate({ externalId: 'I_2' })], { chunkSize: 1 });

    assert.equal(result.failedCount, 1);
    assert.equal(result.createdCount, 1);
    assert.equal(result.errors[0].code, PERSISTENCE_ERROR_CODES.DATABASE_ERROR);
    assert.ok(!JSON.stringify(result).includes('hunter2'));
  });
});

describe('Secrets are never persisted', () => {
  const secretMeta = {
    number: 7,
    accessToken: 'ghs_InstallationTokenValue00000000000000',
    nested: { client_secret: 'abc', note: 'token ghs_AnotherTokenValue000000000000000000', ok: 'kept' },
    headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123' },
    list: [{ api_key: 'k' }, 'xoxb-1234567890-abcdefghij'],
    'dotted.key': 1,
    $where: 'bad',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
  };

  it('sanitizeMetadata drops credential keys and redacts token values', () => {
    const clean = sanitizeMetadata(secretMeta);
    assert.deepEqual(clean, {
      number: 7,
      nested: { note: 'token [REDACTED]', ok: 'kept' },
      headers: {},
      list: [{}, '[REDACTED]'],
      dotted_key: 1,
    });
  });

  it('persisted documents contain no secrets', async () => {
    const model = new InMemorySourceRecordModel();
    await persist(model, [candidate({ metadata: secretMeta })]);
    const stored = JSON.stringify(model.all());
    for (const needle of ['ghs_', 'Bearer', 'xoxb-', 'client_secret', 'accessToken', 'PRIVATE KEY', 'api_key', '$where']) {
      assert.ok(!stored.includes(needle), `found ${needle}`);
    }
    assert.ok(stored.includes('kept'));
  });
});

describe('Regression: credential and path safety for candidate-level fields', () => {
  it('redacts tokens in candidate fields copied into metadata (author, authorId, passageReference)', async () => {
    const model = new InMemorySourceRecordModel();
    await persist(model, [candidate({
      author: 'ghs_LeakProbeToken000000000000000000000000',
      authorId: `Bearer ${'a'.repeat(30)}`,
      passageReference: 'xoxb-1234567890-abcdefghij',
    })]);
    const { metadata } = model.all()[0];
    assert.equal(metadata.author, '[REDACTED]');
    assert.equal(metadata.authorId, '[REDACTED]');
    assert.equal(metadata.passageReference, '[REDACTED]');
  });

  it('drops empty metadata keys so they cannot form an invalid update path', () => {
    const op = buildUpsertOperation(candidate({ metadata: { '': 'x', ok: 1, nested: { '': 'y' } } }), new mongoose.Types.ObjectId(PROJECT_ID));
    const paths = Object.keys(op.updateOne.update.$set);
    assert.ok(!paths.some((p) => p.endsWith('.')));
    assert.equal(op.updateOne.update.$set['metadata.providerMetadata.ok'], 1);
    assert.deepEqual(op.updateOne.update.$set['metadata.providerMetadata.nested'], {});
  });
});

describe('Multi-provider compatibility (real normalizers)', () => {
  it('persists GitHub, Notion, Jira and Slack candidates in one batch', async () => {
    const ctx = { projectId: PROJECT_ID, fetchedAt: FETCHED_AT };
    const records = [
      normalizeIssue({ node_id: 'I_gh', number: 1, title: 'GH issue', body: 'b', state: 'open' }, { ...ctx, repoFullName: 'acme/relay' }),
      normalizeCommit({ sha: 'a'.repeat(40), commit: { message: 'msg' } }, { ...ctx, repoFullName: 'acme/relay' }),
      normalizeNotionPageCandidate({
        id: '1f2e3d4c-0000-4000-8000-000000000001',
        url: 'https://www.notion.so/Spec-1f2e3d4c000040008000000000000001',
        created_time: '2026-01-01T00:00:00.000Z',
        last_edited_time: '2026-01-02T00:00:00.000Z',
        properties: { title: { type: 'title', title: [{ plain_text: 'Spec' }] } },
      }, ['Body line'], { projectId: PROJECT_ID }),
      normalizeJiraIssueCandidate({ key: 'REL-1', id: '10001', fields: { summary: 'Jira issue' } }, { projectId: PROJECT_ID }),
      normalizeSlackMessageCandidate({ ts: '1700000000.000100', text: 'Ship it', user: 'U1' }, { projectId: PROJECT_ID, channelId: 'C123' }),
    ];

    const model = new InMemorySourceRecordModel();
    const result = await persist(model, records);

    assert.equal(result.status, 'succeeded', JSON.stringify(result.errors));
    assert.equal(result.createdCount, 5);
    assert.equal(result.provider, 'mixed');
    assert.deepEqual(model.all().map((d) => `${d.provider}:${d.type}`).sort(), [
      'github:commit', 'github:issue', 'jira:issue', `notion:${records[2].recordType}`, `slack:${records[4].recordType}`,
    ].sort());

    const again = await persist(model, records);
    assert.deepEqual([again.createdCount, again.updatedCount], [0, 5]);
  });

  it('rejects provider candidates normalized with the default placeholder projectId', async () => {
    const record = normalizeJiraIssueCandidate({ key: 'REL-2', fields: { summary: 'No project' } });
    assert.equal(record.projectId, 'default-project');
    const result = await persist(new InMemorySourceRecordModel(), [record]);
    assert.equal(result.errors[0].code, PERSISTENCE_ERROR_CODES.PROJECT_MISMATCH);
  });
});

describe('Upsert operations cast against the real SourceRecord schema', () => {
  // Mongoose's own bulkWrite casting helper; runs without a database connection.
  const castBulkWrite = createRequire(import.meta.url)('mongoose/lib/helpers/model/castBulkWrite');

  it('casts without errors and keeps Mongoose timestamps separate from source timestamps', async () => {
    const op = buildUpsertOperation(candidate(), new mongoose.Types.ObjectId(PROJECT_ID));
    const err = await new Promise((resolve) => castBulkWrite(SourceRecord, op, {})(resolve));

    assert.equal(err ?? null, null);
    const { filter, update } = op.updateOne;
    assert.ok(filter.projectId instanceof mongoose.Types.ObjectId);
    assert.deepEqual(Object.keys(filter).sort(), ['externalId', 'projectId', 'provider']);
    assert.equal(update.$set.type, 'issue');
    assert.equal(update.$set.recordType, undefined);
    assert.ok(update.$set.updatedAt instanceof Date);
    assert.ok(update.$setOnInsert.createdAt instanceof Date);
    assert.ok(update.$set['metadata.sourceCreatedAt'] instanceof Date);
    assert.equal(update.$set._id, undefined);
  });
});
