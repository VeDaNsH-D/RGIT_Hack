import { Router } from 'express';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { Document } from '../models/Document.js';
import { sanitizeMetadata } from '../modules/ingestion/persistence/sourceRecordStore.js';
import { SOURCE_PROVIDERS, SOURCE_RECORD_TYPES } from '../modules/ingestion/contracts/sourceRecord.js';

/**
 * Read-only ingestion APIs (all require a bearer token and project membership;
 * viewer role or higher, like GET /api/projects/:id/context):
 *
 *   GET /api/projects/:id/ingestion/source-records   (alias; /source-records is shadowed in app.js, see below)
 *   GET /api/projects/:id/source-records/:recordId
 *   GET /api/projects/:id/documents
 *   GET /api/projects/:id/documents/:documentId
 *   GET /api/projects/:id/ingestion/status
 *
 * Middleware order: requireAuth -> attachProject() (404 for malformed/unknown
 * projects and non-members) -> requireRole('viewer') -> sub-resource id validation (400). Every query is scoped to
 * req.project._id; no client-supplied filter object ever reaches MongoDB.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE = 10000;

const INGESTION_PROVIDERS = Object.freeze(Object.values(SOURCE_PROVIDERS));
const RECORD_TYPES = Object.freeze(Object.values(SOURCE_RECORD_TYPES));
const SENSITIVE_KEY = /token|secret|password|passwd|credential|authorization|api[-_]?key|private[-_]?key|cookie|storagekey|path/i;

const idString = (v) => (v == null ? null : String(v));
const isObjectId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

class RequestError extends Error {
  constructor(message, code = 'validation_error') {
    super(message);
    this.status = 400;
    this.code = code;
  }
}

function singleParam(query, name) {
  const v = query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new RequestError(`Query parameter '${name}' must be a single value.`);
  return v;
}

function parsePagination(query) {
  const read = (name, def, max) => {
    const raw = singleParam(query, name);
    if (raw === undefined || raw === '') return def;
    if (!/^[1-9]\d{0,8}$/.test(raw)) throw new RequestError(`Query parameter '${name}' must be a positive integer.`);
    const n = Number(raw);
    if (n > max) throw new RequestError(`Query parameter '${name}' must be at most ${max}.`);
    return n;
  };
  const page = read('page', 1, MAX_PAGE);
  const limit = read('limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return { page, limit, skip: (page - 1) * limit };
}

function parseEnum(query, name, allowed) {
  const raw = singleParam(query, name);
  if (raw === undefined || raw === '') return undefined;
  if (!allowed.includes(raw)) {
    throw new RequestError(`Invalid '${name}'. Allowed values: ${allowed.join(', ')}.`);
  }
  return raw;
}

function pageMeta({ page, limit }, total) {
  const totalPages = Math.ceil(total / limit);
  return { page, limit, total, totalPages, hasNextPage: page < totalPages };
}

const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const FS_PATH = /^(?:\/(?!\/)[^\s/]+(?:\/[^\s/]*)+|[A-Za-z]:\\[^\s]*|\.{1,2}\/[^\s]+)$/;

/**
 * Last-line-of-defence cleaning for API output. Persisted metadata is already
 * scrubbed on write; this also protects against rows written by other code paths.
 * - drops credential-looking and path-looking keys, at any depth (objects in arrays too);
 * - redacts token-shaped string values under ANY key (reuses the persistence scrubber);
 * - strips user:password@ from URLs and replaces filesystem-path-looking values.
 */
function redact(value) {
  const cleaned = sanitizeMetadata(value);
  const walk = (node, depth = 0) => {
    if (depth > 10) return undefined;
    if (typeof node === 'string') {
      const stripped = node.replace(URL_USERINFO, '$1[REDACTED]@');
      return FS_PATH.test(stripped.trim()) ? '[REDACTED_PATH]' : stripped;
    }
    if (Array.isArray(node)) return node.map((v) => walk(v, depth + 1));
    if (node && typeof node === 'object' && !(node instanceof Date) && typeof node.toHexString !== 'function') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (!SENSITIVE_KEY.test(k)) out[k] = walk(v, depth + 1);
      }
      return out;
    }
    return node;
  };
  return walk(cleaned);
}

const cleanUrl = (u) => (typeof u === 'string' && u ? u.replace(URL_USERINFO, '$1[REDACTED]@') : null);

function serializeSourceRecord(r, { includeContent = false } = {}) {
  const meta = r.metadata || {};
  const item = {
    id: idString(r._id),
    projectId: idString(r.projectId),
    provider: r.provider,
    type: r.type,
    externalId: r.externalId,
    title: r.title,
    url: cleanUrl(r.url),
    author: meta.author ?? null,
    sourceCreatedAt: meta.sourceCreatedAt ?? null,
    sourceUpdatedAt: meta.sourceUpdatedAt ?? null,
    fetchedAt: meta.fetchedAt ?? null,
    extractionStatus: meta.extractionStatus ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  if (includeContent) {
    item.content = r.content ?? '';
    item.contentType = meta.contentType ?? null;
    item.version = meta.version ?? null;
    item.isActive = meta.isActive ?? null;
    item.isDeleted = meta.isDeleted ?? null;
    item.metadata = redact(meta.providerMetadata || {});
  }
  return item;
}

function serializeDocument(d, sourceRecord) {
  const indexed = Boolean(sourceRecord);
  return {
    id: idString(d._id),
    projectId: idString(d.projectId),
    title: d.title,
    filename: d.filename,
    mimeType: d.mimeType,
    size: d.size,
    uploadedBy: idString(d.uploadedBy),
    storageProvider: d.storageRef?.provider ?? 'none',
    url: typeof d.url === 'string' && /^https?:\/\//i.test(d.url) ? d.url : null,
    // The Document schema has no status field: a stored Document has been
    // validated and extracted; it is "indexed" once its SourceRecord exists.
    processing: {
      status: indexed ? 'indexed' : 'pending_indexing',
      extractionStatus: sourceRecord?.metadata?.extractionStatus ?? null,
      sourceRecordId: indexed ? idString(sourceRecord._id) : null,
      contentHash: sourceRecord?.metadata?.providerMetadata?.contentHash ?? null,
      characterCount: sourceRecord?.metadata?.providerMetadata?.characterCount ?? null,
      pageCount: sourceRecord?.metadata?.providerMetadata?.pageCount ?? null,
    },
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/**
 * @param {Object} [deps] - Injectable models (tests).
 * @param {Object} [deps.sourceRecordModel=SourceRecord]
 * @param {Object} [deps.sourceConnectionModel=SourceConnection]
 * @param {Object} [deps.documentModel=Document]
 */
export function createIngestionRouter(deps = {}) {
  const SR = deps.sourceRecordModel ?? SourceRecord;
  const SC = deps.sourceConnectionModel ?? SourceConnection;
  const Doc = deps.documentModel ?? Document;

  const router = Router();

  const validateIds = (...names) => (req, res, next) => {
    for (const name of names) {
      if (!isObjectId(req.params[name])) {
        // Same shape as a missing resource: no hint about what exists.
        return res.status(400).json({ error: 'validation_error', message: `Invalid ${name}` });
      }
    }
    next();
  };
  // Project id validity is decided by attachProject() (malformed -> 404, like every other project
  // route); sub-resource ids are validated only after membership is established.
  const guard = (...idNames) => [requireAuth, attachProject(), requireRole('viewer'), validateIds(...idNames)];
  const handle = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };
  const bad = (res, err) => res.status(400).json({ error: err.code, message: err.message });

  // NOTE: routes/projects.js (Person 2) also defines GET /:id/source-records and is mounted
  // first, so in the assembled app that path is served by it (member role, full content, raw
  // metadata). The alias below is always reachable and is the supported way to call this handler.
  router.get(['/:id/source-records', '/:id/ingestion/source-records'], ...guard(), handle(async (req, res) => {
    let page, provider, type;
    try {
      page = parsePagination(req.query);
      provider = parseEnum(req.query, 'provider', INGESTION_PROVIDERS);
      type = parseEnum(req.query, 'type', RECORD_TYPES);
    } catch (err) {
      if (err instanceof RequestError) return bad(res, err);
      throw err;
    }
    const filter = {
      projectId: req.project._id,
      // Manual notes/decisions belong to the notes API, not ingestion.
      provider: provider ?? { $in: INGESTION_PROVIDERS },
      ...(type ? { type } : {}),
    };
    const [rows, total] = await Promise.all([
      SR.find(filter).select('-content').sort({ createdAt: -1, _id: -1 }).skip(page.skip).limit(page.limit).lean(),
      SR.countDocuments(filter),
    ]);
    res.json({ items: rows.map((r) => serializeSourceRecord(r)), pagination: pageMeta(page, total) });
  }));

  router.get('/:id/source-records/:recordId', ...guard('recordId'), handle(async (req, res) => {
    const record = await SR.findOne({
      _id: new mongoose.Types.ObjectId(req.params.recordId),
      projectId: req.project._id,
      provider: { $in: INGESTION_PROVIDERS },
    }).lean();
    if (!record) return res.status(404).json({ error: 'not_found', message: 'Source record not found' });
    res.json({ item: serializeSourceRecord(record, { includeContent: true }) });
  }));

  async function recordsByDocumentId(projectId, ids) {
    if (!ids.length) return new Map();
    const rows = await SR.find({ projectId, provider: SOURCE_PROVIDERS.DOCUMENT, externalId: { $in: ids } })
      .select('_id externalId metadata.extractionStatus metadata.providerMetadata.contentHash metadata.providerMetadata.characterCount metadata.providerMetadata.pageCount')
      .lean();
    return new Map(rows.map((r) => [r.externalId, r]));
  }

  router.get('/:id/documents', ...guard(), handle(async (req, res) => {
    let page;
    try {
      page = parsePagination(req.query);
    } catch (err) {
      if (err instanceof RequestError) return bad(res, err);
      throw err;
    }
    const filter = { projectId: req.project._id };
    const [docs, total] = await Promise.all([
      Doc.find(filter).select('-extractedText -storageRef.key -storageRef.url').sort({ createdAt: -1, _id: -1 }).skip(page.skip).limit(page.limit).lean(),
      Doc.countDocuments(filter),
    ]);
    const records = await recordsByDocumentId(req.project._id, docs.map((d) => idString(d._id)));
    res.json({ items: docs.map((d) => serializeDocument(d, records.get(idString(d._id)))), pagination: pageMeta(page, total) });
  }));

  router.get('/:id/documents/:documentId', ...guard('documentId'), handle(async (req, res) => {
    const doc = await Doc.findOne({
      _id: new mongoose.Types.ObjectId(req.params.documentId),
      projectId: req.project._id,
    }).select('-extractedText -storageRef.key -storageRef.url').lean();
    if (!doc) return res.status(404).json({ error: 'not_found', message: 'Document not found' });
    const records = await recordsByDocumentId(req.project._id, [idString(doc._id)]);
    res.json({ item: serializeDocument(doc, records.get(idString(doc._id))) });
  }));

  router.get('/:id/ingestion/status', ...guard(), handle(async (req, res) => {
    const projectId = req.project._id;
    const [connections, counts] = await Promise.all([
      // Only provider names are read; config (which may hold identifiers) is never selected.
      SC.find({ projectId }).select('provider').lean(),
      SR.aggregate([
        { $match: { projectId, provider: { $in: INGESTION_PROVIDERS } } },
        { $group: { _id: '$provider', count: { $sum: 1 } } },
      ]),
    ]);
    const connectionCounts = new Map();
    for (const c of connections) connectionCounts.set(c.provider, (connectionCounts.get(c.provider) || 0) + 1);
    const recordCounts = new Map(counts.map((c) => [c._id, c.count]));

    res.json({
      projectId: idString(projectId),
      providers: INGESTION_PROVIDERS
        .filter((p) => p !== SOURCE_PROVIDERS.DOCUMENT)
        .map((provider) => ({
          provider,
          supported: true,
          connected: connectionCounts.has(provider),
          connectionCount: connectionCounts.get(provider) || 0,
          recordCount: recordCounts.get(provider) || 0,
        })),
      documents: {
        available: true,
        uploadEndpoint: `/api/projects/${idString(projectId)}/documents`,
        maxFileBytes: config.documents.maxBytes,
        supportedFormats: ['pdf', 'docx', 'txt'],
        recordCount: recordCounts.get(SOURCE_PROVIDERS.DOCUMENT) || 0,
      },
      totalRecords: [...recordCounts.values()].reduce((a, b) => a + b, 0),
    });
  }));

  return router;
}

export default createIngestionRouter();
