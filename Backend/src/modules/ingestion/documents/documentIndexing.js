/**
 * @file documentIndexing.js
 * @description Indexing steps shared by upload, replace and retry:
 *   SourceRecord upsert (canonical ingestion record) + DocumentChunk replacement (retrieval units) + status updates.
 *
 * All steps are idempotent. Chunks are keyed on (projectId, documentId, chunkIndex) and the chunker is
 * deterministic, so re-indexing an unchanged document rewrites identical rows and never duplicates them;
 * rows beyond the new chunk count (a shorter replacement) are deleted. Error metadata is content-free.
 */

import { DocumentChunk } from '../../../models/DocumentChunk.js';
import { SourceRecord } from '../../../models/SourceRecord.js';
import { persistSourceRecordCandidates } from '../persistence/sourceRecordStore.js';
import { normalizeDocumentCandidate } from './documentNormalizer.js';
import { chunkDocument } from './documentChunker.js';

/**
 * Normalizes a persisted Document and upserts its SourceRecord.
 * @returns {Promise<Object>} persistSourceRecordCandidates result.
 */
export async function persistDocumentSourceRecord({ document, extraction, contentHash, sourceRecordModel = SourceRecord, now = () => new Date() }) {
  const candidate = normalizeDocumentCandidate({ document, extraction, contentHash, fetchedAt: now() });
  return persistSourceRecordCandidates({ projectId: candidate.projectId, records: [candidate], model: sourceRecordModel, now });
}

export const DIGEST_MAX_CHARS = 380;

/** Deterministic, content-bounded outline of a document: its section headings in order plus how it opens. */
export function buildDocumentDigest(chunks) {
  if (!chunks.length) return '';
  const headings = [...new Set(chunks.map((c) => c.heading).filter(Boolean))].slice(0, 10).map((h) => h.slice(0, 48));
  // The opening is only worth its tokens when the document has too little structure to outline.
  const opening = headings.length >= 3 ? '' : chunks[0].text.replace(/\s+/g, ' ').slice(0, 200);
  const pages = chunks.map((c) => c.pageStart).filter((p) => p != null);
  const parts = [];
  if (pages.length) parts.push(`${Math.max(...pages)} pages`);
  if (headings.length) parts.push(`Sections: ${headings.join(' | ')}`);
  if (opening) parts.push(`Opens: ${opening}`);
  return parts.join('. ').slice(0, DIGEST_MAX_CHARS);
}

/**
 * Rebuilds the chunk rows for one document version.
 * @returns {Promise<{ count: number, truncated: boolean, digest: string }>}
 */
export async function replaceDocumentChunks({ document, extraction, contentHash, chunkModel = DocumentChunk, maxChars, now = () => new Date() }) {
  const { chunks, truncated } = chunkDocument(extraction.segments ?? (extraction.extractedText ? [{ text: extraction.extractedText }] : []), maxChars ? { maxChars } : {});
  const documentId = document._id;
  const base = {
    projectId: document.projectId,
    documentId,
    contentHash,
    filename: document.filename || '',
    title: document.title || '',
    uploadedAt: document.createdAt instanceof Date ? document.createdAt : now(),
  };
  if (chunks.length) {
    await chunkModel.bulkWrite(chunks.map((c) => ({
      updateOne: {
        filter: { projectId: document.projectId, documentId, chunkIndex: c.index },
        update: {
          $set: {
            ...base,
            chunkId: `${documentId}:${c.index}`,
            text: c.text,
            charCount: c.text.length,
            chunkHash: c.chunkHash,
            heading: c.heading || '',
            pageStart: c.pageStart,
            pageEnd: c.pageEnd,
          },
        },
        upsert: true,
      },
    })), { ordered: false });
  }
  await chunkModel.deleteMany({ projectId: document.projectId, documentId, chunkIndex: { $gte: chunks.length } });
  return { count: chunks.length, truncated, digest: buildDocumentDigest(chunks) };
}

/** Removes every chunk of a document (delete flow / failed re-index cleanup). */
export const deleteDocumentChunks = (chunkModel, projectId, documentId) => chunkModel.deleteMany({ projectId, documentId });

/**
 * Atomically moves a document into 'processing'. Returns false when another attempt is already running
 * (started less than `staleMs` ago), so concurrent retries cannot double-process.
 */
export async function claimDocumentForProcessing(documentModel, { projectId, documentId, now = () => new Date(), staleMs = 5 * 60 * 1000, set = {} }) {
  const t = now();
  const res = await documentModel.updateOne(
    { _id: documentId, projectId, $or: [{ status: { $ne: 'processing' } }, { processingStartedAt: { $lt: new Date(t.getTime() - staleMs) } }, { processingStartedAt: { $exists: false } }] },
    { $set: { ...set, status: 'processing', processingStartedAt: t }, $unset: { statusError: '' }, $inc: { attempts: 1 } },
  );
  return (res?.modifiedCount ?? res?.nModified ?? 0) === 1;
}

export const markDocumentIndexed = (documentModel, { projectId, documentId, chunkCount, contentHash, pageCount, digest = '', now = () => new Date() }) =>
  documentModel.updateOne(
    { _id: documentId, projectId },
    { $set: { status: 'indexed', chunkCount, contentHash, digest, indexedAt: now(), ...(pageCount != null ? { pageCount } : {}) }, $unset: { statusError: '', processingStartedAt: '' } },
  );

export const markDocumentFailed = (documentModel, { projectId, documentId, code, message, now = () => new Date() }) =>
  documentModel.updateOne(
    { _id: documentId, projectId },
    { $set: { status: 'failed', statusError: { code: String(code || 'PROCESSING_FAILED').slice(0, 64), message: String(message || 'Processing failed.').slice(0, 300), at: now() } }, $unset: { processingStartedAt: '' } },
  );
