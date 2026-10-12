import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { processDocumentUpload, recoverDocumentSourceRecord, createLocalDocumentStorage, RECOVERY_STATUS as S, DOCUMENT_ERROR_CODES as C } from './index.js';
import { InMemoryDocumentModel } from './inMemoryDocumentModel.js';
import { InMemorySourceRecordModel } from '../persistence/inMemorySourceRecordModel.js';

const PROJECT = new mongoose.Types.ObjectId();
const OTHER_PROJECT = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

describe('recoverDocumentSourceRecord', () => {
  let rootDir, storage, documents, sourceRecords, partial, documentModel;

  /** Document model double exposing create() and findOne().lean() over in-memory docs. */
  const wrap = (docs) => ({
    create: (d) => docs.create(d),
    findOne: (filter) => ({
      lean: async () => {
        if (docs.findError) throw docs.findError;
        const hit = docs.docs.find((d) => String(d._id) === String(filter._id) && String(d.projectId) === String(filter.projectId));
        return hit ? hit.toObject() : null;
      },
    }),
  });

  const recover = (over = {}) => recoverDocumentSourceRecord({
    projectId: PROJECT, documentId: partial.document.id, storage, documentModel, sourceRecordModel: sourceRecords, ...over,
  });

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-recovery-'));
    storage = createLocalDocumentStorage({ rootDir });
    documents = new InMemoryDocumentModel();
    documentModel = wrap(documents);
    sourceRecords = new InMemorySourceRecordModel();
    sourceRecords.failNextBulkWrite();
    partial = await processDocumentUpload({
      projectId: PROJECT, uploadedBy: USER, storage, documentModel, sourceRecordModel: sourceRecords,
      file: { buffer: Buffer.from('Handoff notes for recovery'), filename: 'notes.txt', mimeType: 'text/plain' },
    });
    assert.equal(partial.status, 'partial');
  });
  afterEach(() => fs.rm(rootDir, { recursive: true, force: true }));

  it('recovers a partial upload: one SourceRecord, hash from the stored bytes, no new Document', async () => {
    const r = await recover();
    assert.equal(r.status, S.RECOVERED);
    assert.equal(sourceRecords.all().length, 1);
    const rec = sourceRecords.all()[0];
    assert.equal(rec.externalId, partial.document.id);
    assert.equal(rec.metadata.providerMetadata.contentHash, partial.reconciliation.contentHash);
    assert.equal(documents.docs.length, 1);
    assert.equal(documents.createCalls, 1);
  });

  it('is idempotent: a repeated retry reports already_indexed and writes nothing', async () => {
    assert.equal((await recover()).status, S.RECOVERED);
    const again = await recover();
    assert.equal(again.status, S.ALREADY_INDEXED);
    assert.equal(sourceRecords.all().length, 1);
  });

  it('missing document, and a document from another project, are both not_found', async () => {
    assert.equal((await recover({ documentId: new mongoose.Types.ObjectId() })).status, S.NOT_FOUND);
    assert.equal((await recover({ projectId: OTHER_PROJECT })).status, S.NOT_FOUND);
    assert.equal(sourceRecords.all().length, 0);
  });

  it('rejects malformed ids and a missing storage adapter', async () => {
    await assert.rejects(recover({ documentId: 'nope' }), TypeError);
    await assert.rejects(recover({ storage: null }), TypeError);
  });

  it('database failure on lookup: failed, safe message, nothing written', async () => {
    documents.findError = new Error('mongodb://user:pw@host exploded');
    const r = await recover();
    assert.equal(r.status, S.FAILED);
    assert.equal(r.errors[0].code, C.RECOVERY_LOOKUP_FAILED);
    assert.ok(!JSON.stringify(r).includes('mongodb://'));
  });

  it('database failure on SourceRecord write: failed, then a later retry succeeds', async () => {
    sourceRecords.failNextBulkWrite();
    const r = await recover();
    assert.equal(r.status, S.FAILED);
    assert.equal(r.errors[0].code, C.SOURCE_RECORD_PERSISTENCE_FAILED);
    assert.equal(sourceRecords.all().length, 0);
    assert.equal((await recover()).status, S.RECOVERED);
    assert.equal(sourceRecords.all().length, 1);
  });

  it('per-record write rejection is reported as failed, not recovered', async () => {
    sourceRecords.failOn(partial.document.id);
    const r = await recover();
    assert.equal(r.status, S.FAILED);
    assert.equal(r.sourceRecord.failedCount, 1);
  });

  it('a duplicate-key race with a concurrent writer still ends with exactly one record', async () => {
    sourceRecords.raceOn(partial.document.id);
    const r = await recover();
    assert.equal(r.status, S.RECOVERED);
    assert.equal(sourceRecords.all().length, 1);
  });

  it('original file gone: ORIGINAL_UNAVAILABLE, Document untouched, no paths in the response', async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    const r = await recover();
    assert.equal(r.status, S.FAILED);
    assert.equal(r.errors[0].code, C.ORIGINAL_UNAVAILABLE);
    assert.ok(!JSON.stringify(r).includes(rootDir));
    assert.equal(documents.docs.length, 1);
    assert.equal(sourceRecords.all().length, 0);
  });
});
