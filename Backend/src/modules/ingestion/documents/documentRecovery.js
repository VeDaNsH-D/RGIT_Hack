/**
 * @file documentRecovery.js
 * @description Recovery for 'partial' uploads: a Document was saved but its
 * SourceRecord was not (processDocumentUpload -> status 'partial',
 * reconciliation.action 'retry_source_record').
 *
 * Recovery is idempotent and server-driven:
 * - the Document is looked up by (_id, projectId), so a document id from another
 *   project is indistinguishable from a missing one;
 * - the content hash and extraction are recomputed from the stored original bytes,
 *   never taken from the client;
 * - the SourceRecord is written through the normal upsert keyed on
 *   (projectId, 'document', Document._id), so repeated or concurrent recoveries
 *   cannot create duplicates and no second Document is ever created;
 * - 'recovered' is only returned after exactly one SourceRecord write succeeded.
 *
 * It needs the original bytes. The local adapter's directory is ephemeral on
 * Vercel, so recovery can fail with ORIGINAL_UNAVAILABLE until a durable storage
 * adapter exists; the Document stays untouched in that case.
 */

import mongoose from 'mongoose';
import { Document } from '../../../models/Document.js';
import { SourceRecord } from '../../../models/SourceRecord.js';
import { SOURCE_PROVIDERS } from '../contracts/sourceRecord.js';
import { DOCUMENT_ERROR_CODES as C, toSafeDocumentError } from './documentErrors.js';
import { validateDocumentUpload } from './documentValidation.js';
import { extractDocumentText } from './documentExtraction.js';
import { DocumentChunk } from '../../../models/DocumentChunk.js';
import { computeContentHash } from './documentProcessingService.js';
import {
  persistDocumentSourceRecord, replaceDocumentChunks, claimDocumentForProcessing, markDocumentIndexed, markDocumentFailed,
} from './documentIndexing.js';

/** @readonly @enum {string} */
export const RECOVERY_STATUS = Object.freeze({
  RECOVERED: 'recovered',
  ALREADY_INDEXED: 'already_indexed',
  NOT_FOUND: 'not_found',
  FAILED: 'failed',
});

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const asObjectId = (v) => (v instanceof mongoose.Types.ObjectId ? v : (typeof v === 'string' && OBJECT_ID.test(v) ? new mongoose.Types.ObjectId(v) : null));

const lean = (q) => (typeof q?.lean === 'function' ? q.lean() : q);

/**
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.projectId - Authorized project (from attachProject()).
 * @param {string|mongoose.Types.ObjectId} params.documentId
 * @param {{ read: Function }} params.storage
 * @param {Object} [params.documentModel=Document]
 * @param {Object} [params.sourceRecordModel=SourceRecord]
 * @param {() => Date} [params.now]
 * @returns {Promise<{ status: string, documentId: string, sourceRecord: Object|null, errors: Array<{stage:string, code:string, message:string}> }>}
 */
export async function recoverDocumentSourceRecord({
  projectId, documentId, storage, documentModel = Document, sourceRecordModel = SourceRecord, chunkModel = DocumentChunk, force = false, limits = {}, now = () => new Date(),
} = {}) {
  const projectObjectId = asObjectId(projectId);
  const documentObjectId = asObjectId(documentId);
  if (!projectObjectId || !documentObjectId) {
    throw new TypeError('projectId and documentId must be valid ObjectIds.');
  }
  if (!storage || typeof storage.read !== 'function') {
    throw new TypeError('A storage adapter with read() is required.');
  }

  const base = { documentId: documentObjectId.toHexString(), sourceRecord: null, errors: [] };
  const fail = (stage, err, code, message) => ({
    ...base, status: RECOVERY_STATUS.FAILED, errors: [{ stage, ...toSafeDocumentError(err, code, message) }],
  });

  let document;
  let existing;
  try {
    document = await lean(documentModel.findOne({ _id: documentObjectId, projectId: projectObjectId }));
    if (!document) return { ...base, status: RECOVERY_STATUS.NOT_FOUND };
    existing = await lean(sourceRecordModel.findOne(
      { projectId: projectObjectId, provider: SOURCE_PROVIDERS.DOCUMENT, externalId: documentObjectId.toHexString() },
      { _id: 1 },
    ));
  } catch (err) {
    return fail('lookup', err, C.RECOVERY_LOOKUP_FAILED, 'The document could not be looked up.');
  }
  if (existing && document.status === 'indexed' && !force) return { ...base, status: RECOVERY_STATUS.ALREADY_INDEXED };

  // Only one attempt at a time; a concurrent retry is refused instead of double-processing.
  let claimed;
  try {
    claimed = await claimDocumentForProcessing(documentModel, { projectId: projectObjectId, documentId: documentObjectId, now });
  } catch (err) {
    return fail('lookup', err, C.RECOVERY_LOOKUP_FAILED, 'The document could not be looked up.');
  }
  if (!claimed) return fail('lookup', null, C.DOCUMENT_BUSY, 'This document is already being processed. Try again in a moment.');
  const failed = async (stage, err, code, message) => {
    const out = fail(stage, err, code, message);
    await markDocumentFailed(documentModel, { projectId: projectObjectId, documentId: documentObjectId, code: out.errors[0].code, message: out.errors[0].message, now }).catch(() => {});
    return out;
  };

  let buffer;
  try {
    buffer = await storage.read(document.storageRef?.key);
  } catch {
    return await failed('storage', null, C.ORIGINAL_UNAVAILABLE, 'The original file is no longer available, so the document cannot be re-indexed.');
  }

  const validation = validateDocumentUpload({ buffer, filename: document.filename, mimeType: document.mimeType });
  if (!validation.valid) {
    const first = validation.errors[0];
    await markDocumentFailed(documentModel, { projectId: projectObjectId, documentId: documentObjectId, code: first?.code, message: first?.message, now }).catch(() => {});
    return { ...base, status: RECOVERY_STATUS.FAILED, errors: validation.errors.map((e) => ({ stage: 'validation', ...e })) };
  }
  let extraction;
  try {
    extraction = await extractDocumentText({ buffer, validated: validation.document, limits });
  } catch (err) {
    return await failed('extraction', err, C.EXTRACTION_FAILED, 'Text extraction failed.');
  }

  let persistence;
  try {
    persistence = await persistDocumentSourceRecord({
      document, extraction, contentHash: computeContentHash(buffer), sourceRecordModel, now,
    });
  } catch (err) {
    return await failed('source_record', err, C.SOURCE_RECORD_PERSISTENCE_FAILED, 'The source record could not be saved.');
  }

  const summary = {
    status: persistence.status,
    createdCount: persistence.createdCount,
    updatedCount: persistence.updatedCount,
    failedCount: persistence.failedCount,
  };
  if (persistence.failedCount !== 0 || persistence.createdCount + persistence.updatedCount !== 1) {
    const errors = persistence.errors.map((e) => ({ stage: 'source_record', code: C.SOURCE_RECORD_PERSISTENCE_FAILED, message: `${e.code}: ${e.message}` }));
    await markDocumentFailed(documentModel, { projectId: projectObjectId, documentId: documentObjectId, code: errors[0]?.code, message: errors[0]?.message, now }).catch(() => {});
    return { ...base, status: RECOVERY_STATUS.FAILED, sourceRecord: summary, errors };
  }
  try {
    const contentHash = computeContentHash(buffer);
    const chunks = await replaceDocumentChunks({ document, extraction, contentHash, chunkModel, now });
    await markDocumentIndexed(documentModel, { projectId: projectObjectId, documentId: documentObjectId, chunkCount: chunks.count, digest: chunks.digest, contentHash, pageCount: extraction.metadata?.pageCount, now });
  } catch (err) {
    return await failed('chunks', err, C.CHUNK_INDEXING_FAILED, 'The document could not be indexed.');
  }
  return { ...base, status: RECOVERY_STATUS.RECOVERED, sourceRecord: summary };
}
