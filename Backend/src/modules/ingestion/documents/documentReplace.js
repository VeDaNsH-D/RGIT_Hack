/**
 * @file documentReplace.js
 * @description Replaces the file behind an existing Document (same Document id, new bytes).
 *
 * validate -> hash -> extract -> (unchanged? stop) -> store new file -> atomically swap the Document's
 * fields and claim it for processing -> re-upsert the SourceRecord -> rebuild chunks (stale rows beyond the new
 * count are deleted) -> mark indexed -> remove the old file. Until the swap succeeds nothing about the existing
 * document changes. After the swap, a failure leaves the document 'failed' (excluded from handoff retrieval)
 * and retryable. The authorized project comes from the caller; the document is always looked up with it.
 */

import mongoose from 'mongoose';
import { Document } from '../../../models/Document.js';
import { SourceRecord } from '../../../models/SourceRecord.js';
import { DocumentChunk } from '../../../models/DocumentChunk.js';
import { DOCUMENT_ERROR_CODES as C, toSafeDocumentError } from './documentErrors.js';
import { validateDocumentUpload, DEFAULT_MAX_FILE_BYTES } from './documentValidation.js';
import { extractDocumentText } from './documentExtraction.js';
import { computeContentHash } from './documentProcessingService.js';
import {
  persistDocumentSourceRecord, replaceDocumentChunks, claimDocumentForProcessing, markDocumentIndexed, markDocumentFailed,
} from './documentIndexing.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const lean = (q) => (typeof q?.lean === 'function' ? q.lean() : q);

/**
 * @returns {Promise<{ status: 'replaced'|'unchanged'|'not_found'|'busy'|'failed', stage?: string, document?: Object, errors: Array, warnings: Array }>}
 */
export async function replaceDocumentFile({
  projectId, documentId, file, storage, limits = {},
  documentModel = Document, sourceRecordModel = SourceRecord, chunkModel = DocumentChunk, now = () => new Date(),
} = {}) {
  if (!OBJECT_ID.test(String(projectId)) || !OBJECT_ID.test(String(documentId))) throw new TypeError('projectId and documentId must be valid ObjectIds.');
  const projectObjectId = new mongoose.Types.ObjectId(String(projectId));
  const documentObjectId = new mongoose.Types.ObjectId(String(documentId));
  const out = { status: 'failed', errors: [], warnings: [] };
  const err = (stage, e, code, message) => { out.errors.push({ stage, ...toSafeDocumentError(e, code, message) }); out.stage = stage; return out; };

  const current = await lean(documentModel.findOne({ _id: documentObjectId, projectId: projectObjectId }));
  if (!current) return { ...out, status: 'not_found' };

  const validation = validateDocumentUpload(file, { maxBytes: limits.maxBytes ?? DEFAULT_MAX_FILE_BYTES });
  if (!validation.valid) {
    for (const e of validation.errors) out.errors.push({ stage: 'validation', ...e });
    out.stage = 'validation';
    return out;
  }
  const validated = validation.document;
  const contentHash = computeContentHash(file.buffer);
  let extraction;
  try {
    extraction = await extractDocumentText({ buffer: file.buffer, validated, limits });
  } catch (e) {
    return err('extraction', e, C.EXTRACTION_FAILED, 'Text extraction failed.');
  }
  if (current.contentHash === contentHash && current.status === 'indexed') return { ...out, status: 'unchanged', document: { id: String(current._id) } };
  if (extraction.status === 'empty') out.warnings.push({ stage: 'extraction', code: C.NO_EXTRACTABLE_TEXT, message: 'The document contains no extractable text (OCR is not supported).' });

  let stored;
  try {
    stored = await storage.put({ buffer: file.buffer, extension: validated.extension });
  } catch (e) {
    return err('storage', e, C.STORAGE_FAILED, 'The file could not be stored.');
  }

  let claimed = false;
  try {
    claimed = await claimDocumentForProcessing(documentModel, {
      projectId: projectObjectId, documentId: documentObjectId, now,
      set: {
        filename: validated.originalFilename, mimeType: validated.mimeType, size: validated.size, storageRef: stored.storageRef,
        url: stored.storageRef.url || '', extractedText: extraction.extractedText, contentHash, pageCount: extraction.metadata?.pageCount ?? null, chunkCount: 0,
      },
    });
  } catch (e) {
    await storage.delete(stored.key).catch(() => {});
    return err('document', e, C.DOCUMENT_PERSISTENCE_FAILED, 'The document record could not be updated.');
  }
  if (!claimed) {
    await storage.delete(stored.key).catch(() => {});
    out.status = 'busy';
    return err('document', null, C.DOCUMENT_BUSY, 'This document is already being processed. Try again in a moment.');
  }

  const updated = { ...current, filename: validated.originalFilename, mimeType: validated.mimeType, size: validated.size, extractedText: undefined, storageRef: stored.storageRef };
  let indexError = null;
  try {
    const persistence = await persistDocumentSourceRecord({ document: updated, extraction, contentHash, sourceRecordModel, now });
    if (persistence.failedCount !== 0 || persistence.createdCount + persistence.updatedCount !== 1) throw new Error('source record not saved');
  } catch (e) {
    indexError = [C.SOURCE_RECORD_PERSISTENCE_FAILED, 'The source record could not be saved.', e];
  }
  if (!indexError) {
    try {
      const chunks = await replaceDocumentChunks({ document: updated, extraction, contentHash, chunkModel, now });
      await markDocumentIndexed(documentModel, { projectId: projectObjectId, documentId: documentObjectId, chunkCount: chunks.count, digest: chunks.digest, contentHash, pageCount: extraction.metadata?.pageCount, now });
      if (chunks.truncated) out.warnings.push({ stage: 'chunks', code: 'CHUNK_LIMIT_REACHED', message: 'The document is very long; only its first sections were indexed for handoffs.' });
    } catch (e) {
      indexError = [C.CHUNK_INDEXING_FAILED, 'The document could not be indexed.', e];
    }
  }
  if (indexError) {
    err('index', indexError[2], indexError[0], indexError[1]);
    await markDocumentFailed(documentModel, { projectId: projectObjectId, documentId: documentObjectId, code: indexError[0], message: indexError[1], now }).catch(() => {});
    out.status = 'failed';
    out.document = { id: String(documentObjectId), status: 'failed' };
    return out;
  }

  // The new version is live; the previous file is no longer referenced.
  if (current.storageRef?.key && current.storageRef.key !== stored.key) await storage.delete(current.storageRef.key).catch(() => { out.warnings.push({ stage: 'cleanup', code: C.CLEANUP_FAILED, message: 'The previous file could not be removed.' }); });
  out.status = 'replaced';
  out.errors = [];
  out.document = { id: String(documentObjectId), status: 'indexed', filename: validated.originalFilename, size: validated.size };
  return out;
}
