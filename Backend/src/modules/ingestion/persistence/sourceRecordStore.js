/**
 * @file sourceRecordStore.js
 * @description Persists normalized SourceRecordCandidates into Person 2's
 * canonical SourceRecord model (src/models/SourceRecord.js) with idempotent upserts.
 *
 * Identity / deduplication: the model's unique index (projectId, provider, externalId).
 * Each candidate becomes one `updateOne` upsert keyed on that identity, so
 * re-ingesting a source updates the existing document (same `_id`) instead of
 * inserting a duplicate.
 *
 * Merge semantics on update:
 * - `type`, `title`, `content` are always set (required by the contract).
 * - `url` is set only when the candidate has one (an omitted URL never blanks a stored one).
 * - Metadata is written with dotted `$set` paths (`metadata.author`,
 *   `metadata.providerMetadata.<key>`), so keys a provider omits are left intact.
 *   Explicit `null` values in provider metadata are written; `undefined` is skipped.
 * - `isDemo` and `_id` are never touched on update.
 *
 * Accepted input: SourceRecordCandidates (contracts/sourceRecord.js) only. Jira and Slack
 * connectors produce them with `asCandidate: true`; Notion and GitHub always do.
 *
 * Security: provider metadata is scrubbed before writing. Keys that look like
 * credentials are dropped and token-like string values are redacted. Errors carry
 * only codes, record identity, and sanitized messages.
 */

import mongoose from 'mongoose';
import { SourceRecord } from '../../../models/SourceRecord.js';
import {
  INGESTION_STATUS,
  validateSourceRecordCandidate,
  toSourceRecordDocument,
} from '../contracts/sourceRecord.js';
import { redactSecrets } from '../providers/github/githubErrors.js';

/** @readonly @enum {string} */
export const PERSISTENCE_ERROR_CODES = Object.freeze({
  INVALID_PROJECT_ID: 'INVALID_PROJECT_ID',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_RECORD: 'INVALID_RECORD',
  UNSUPPORTED_RECORD_FORMAT: 'UNSUPPORTED_RECORD_FORMAT',
  PROJECT_MISMATCH: 'PROJECT_MISMATCH',
  RECORD_TOO_LARGE: 'RECORD_TOO_LARGE',
  DUPLICATE_IN_BATCH: 'DUPLICATE_IN_BATCH',
  WRITE_FAILED: 'WRITE_FAILED',
  DATABASE_ERROR: 'DATABASE_ERROR',
});

export const DEFAULT_CHUNK_SIZE = 500;
export const MAX_CONTENT_LENGTH = 1_000_000;
export const MAX_EXTERNAL_ID_LENGTH = 1024;
const MAX_ERRORS = 100;
const MAX_METADATA_DEPTH = 10;
const DUPLICATE_KEY_CODE = 11000;

// Normalized (lowercase, alphanumeric-only) key fragments that indicate a credential.
const SECRET_KEY_FRAGMENTS = [
  'token', 'secret', 'password', 'passwd', 'privatekey', 'apikey',
  'authorization', 'credential', 'cookie', 'clientsecret',
];

/**
 * Whether a metadata key name looks like it holds a credential.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Returns a deep copy of provider metadata that is safe to persist:
 * credential-like keys are dropped, token-like strings are redacted,
 * empty and `$`-prefixed keys are dropped and `.` in keys becomes `_` (MongoDB path safety),
 * `undefined` values are omitted, and depth is bounded.
 *
 * @param {unknown} value
 * @param {number} [depth=0]
 * @returns {unknown}
 */
export function sanitizeMetadata(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  if (value instanceof Date) return value;
  if (depth >= MAX_METADATA_DEPTH) return undefined;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadata(item, depth + 1)).filter((item) => item !== undefined);
  }

  const out = {};
  for (const [rawKey, rawVal] of Object.entries(value)) {
    // Empty keys would become an invalid update path (`metadata.providerMetadata.`).
    if (rawKey === '' || rawKey.startsWith('$') || isSecretKey(rawKey)) continue;
    const clean = sanitizeMetadata(rawVal, depth + 1);
    if (clean !== undefined) out[rawKey.replace(/\./g, '_')] = clean;
  }
  return out;
}

/**
 * Validates and casts the authoritative Relay project ID.
 *
 * @param {unknown} projectId
 * @returns {mongoose.Types.ObjectId}
 */
function castProjectId(projectId) {
  const raw = projectId instanceof mongoose.Types.ObjectId ? projectId.toHexString() : projectId;
  if (typeof raw !== 'string' || !/^[a-f0-9]{24}$/i.test(raw.trim())) {
    const err = new Error('A valid Relay projectId (24-character ObjectId) is required for persistence.');
    err.code = PERSISTENCE_ERROR_CODES.INVALID_PROJECT_ID;
    throw err;
  }
  return new mongoose.Types.ObjectId(raw.trim());
}

/**
 * Truncates an external ID for inclusion in error reports.
 */
function safeExternalId(record) {
  if (!record || typeof record !== 'object' || typeof record.externalId !== 'string') return null;
  return redactSecrets(record.externalId.slice(0, 200));
}

/**
 * Checks a single record and returns either an error descriptor or null.
 *
 * @param {unknown} record
 * @param {string} projectIdHex
 * @returns {{ code: string, message: string } | null}
 */
function checkRecord(record, projectIdHex) {
  // Legacy integrations/common/types.js records (id, type, observedAt, ISO-string dates).
  if (record && typeof record === 'object' && ('id' in record || 'type' in record || 'observedAt' in record)) {
    return {
      code: PERSISTENCE_ERROR_CODES.UNSUPPORTED_RECORD_FORMAT,
      message: 'Record is not a SourceRecordCandidate (has id/type/observedAt). Use the provider\'s candidate output, e.g. asCandidate: true for Jira/Slack.',
    };
  }

  const validation = validateSourceRecordCandidate(record);
  if (!validation.valid) {
    return {
      code: PERSISTENCE_ERROR_CODES.INVALID_RECORD,
      message: redactSecrets(validation.errors.join('; ')),
    };
  }

  if (record.projectId.trim() !== projectIdHex) {
    return {
      code: PERSISTENCE_ERROR_CODES.PROJECT_MISMATCH,
      message: 'Record projectId does not match the project being ingested into.',
    };
  }

  if (record.externalId.length > MAX_EXTERNAL_ID_LENGTH) {
    return { code: PERSISTENCE_ERROR_CODES.RECORD_TOO_LARGE, message: `externalId exceeds ${MAX_EXTERNAL_ID_LENGTH} characters.` };
  }

  if (record.content.length > MAX_CONTENT_LENGTH) {
    return { code: PERSISTENCE_ERROR_CODES.RECORD_TOO_LARGE, message: `content exceeds ${MAX_CONTENT_LENGTH} characters.` };
  }

  return null;
}

/**
 * Builds the bulkWrite `updateOne` upsert for a validated candidate.
 * All values are pre-cast so Mongoose casting cannot drop the operation.
 *
 * @param {import('../contracts/sourceRecord.js').SourceRecordCandidate} candidate
 * @param {mongoose.Types.ObjectId} projectObjectId
 * @returns {{ updateOne: { filter: Object, update: Object, upsert: true } }}
 */
export function buildUpsertOperation(candidate, projectObjectId) {
  const doc = toSourceRecordDocument(candidate);

  const $set = {
    type: doc.type,
    title: doc.title,
    content: doc.content,
  };
  const $setOnInsert = {};

  if (doc.url) $set.url = doc.url;
  else $setOnInsert.url = '';

  const { providerMetadata, ...ingestionMeta } = doc.metadata;
  // Candidate-level strings (author, authorId, passageReference, ...) land in metadata too,
  // so they get the same token redaction as provider metadata.
  for (const [key, value] of Object.entries(ingestionMeta)) {
    if (value !== undefined && value !== null) {
      $set[`metadata.${key}`] = typeof value === 'string' ? redactSecrets(value) : value;
    }
  }

  const cleanProviderMeta = sanitizeMetadata(providerMetadata || {});
  const providerKeys = Object.keys(cleanProviderMeta);
  if (providerKeys.length === 0) {
    $setOnInsert['metadata.providerMetadata'] = {};
  }
  for (const key of providerKeys) {
    $set[`metadata.providerMetadata.${key}`] = cleanProviderMeta[key];
  }

  const update = { $set };
  if (Object.keys($setOnInsert).length > 0) update.$setOnInsert = $setOnInsert;

  return {
    updateOne: {
      filter: { projectId: projectObjectId, provider: doc.provider, externalId: doc.externalId },
      update,
      upsert: true,
    },
  };
}

/**
 * Normalizes the outcome of a bulkWrite (success or MongoBulkWriteError) into
 * per-operation results keyed by the index into `ops`.
 *
 * @returns {{ created: Set<number>, writeErrors: Map<number, { code: number|null, message: string }>, fatal: Error|null }}
 */
async function executeBulk(model, ops) {
  let res = null;
  let error = null;
  try {
    res = await model.bulkWrite(ops, { ordered: false });
  } catch (err) {
    error = err;
  }

  const payload = res || error;
  const writeErrorsRaw = error ? (Array.isArray(error.writeErrors) ? error.writeErrors : error.writeErrors ? [error.writeErrors] : []) : [];

  // A failure that is not a per-operation write error (connection loss, auth, timeout)
  // means we cannot know what was written for this chunk.
  if (error && writeErrorsRaw.length === 0) {
    return { created: new Set(), writeErrors: new Map(), fatal: error };
  }

  // Mongoose (unordered) drops ops that fail casting and re-indexes the rest; map
  // driver indexes back to our op indexes if that ever happens.
  const mongooseResults = payload?.mongoose?.results;
  const castFailed = new Set();
  if (Array.isArray(mongooseResults) && mongooseResults.length === ops.length) {
    mongooseResults.forEach((r, i) => {
      if (r && (r.name === 'ValidationError' || r.name === 'CastError' || r.name === 'StrictModeError')) castFailed.add(i);
    });
  }
  const validIndexes = ops.map((_, i) => i).filter((i) => !castFailed.has(i));
  const toOpIndex = (driverIndex) => validIndexes[driverIndex];

  const writeErrors = new Map();
  for (const i of castFailed) writeErrors.set(i, { code: null, message: 'Record could not be cast to the SourceRecord schema.' });
  for (const we of writeErrorsRaw) {
    const driverIndex = typeof we.index === 'number' ? we.index : we.err?.index;
    const opIndex = toOpIndex(driverIndex);
    if (opIndex === undefined) continue;
    writeErrors.set(opIndex, { code: we.code ?? we.err?.code ?? null, message: we.errmsg || we.err?.errmsg || we.message || 'Write failed.' });
  }

  const upserted = (error ? error.result?.upsertedIds ?? error.upsertedIds : res?.upsertedIds) || {};
  const created = new Set();
  for (const key of Object.keys(upserted)) {
    const opIndex = toOpIndex(Number(key));
    if (opIndex !== undefined) created.add(opIndex);
  }

  return { created, writeErrors, fatal: null };
}

/**
 * Persists SourceRecordCandidates for one Relay project with idempotent upserts.
 *
 * Never throws for record-level or database problems: they are reported in the
 * result. Throws only for programmer errors (invalid projectId / records not an array).
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.projectId - Authoritative Relay project ID
 *   (from an authorized project association, never from provider data).
 * @param {import('../contracts/sourceRecord.js').SourceRecordCandidate[]} params.records
 * @param {{ bulkWrite: Function }} [params.model=SourceRecord] - Injectable for tests.
 * @param {number} [params.chunkSize=500]
 * @param {() => Date} [params.now]
 * @returns {Promise<{
 *   provider: string|null, projectId: string, status: string, persisted: boolean,
 *   receivedCount: number, createdCount: number, updatedCount: number,
 *   skippedCount: number, failedCount: number,
 *   errors: Array<{ index: number, provider: string|null, externalId: string|null, code: string, message: string }>,
 *   startedAt: string, completedAt: string
 * }>}
 */
export async function persistSourceRecordCandidates({
  projectId,
  records,
  model = SourceRecord,
  chunkSize = DEFAULT_CHUNK_SIZE,
  now = () => new Date(),
} = {}) {
  const projectObjectId = castProjectId(projectId);
  const projectIdHex = projectObjectId.toHexString();

  if (!Array.isArray(records)) {
    const err = new Error('records must be an array of SourceRecordCandidates.');
    err.code = PERSISTENCE_ERROR_CODES.INVALID_INPUT;
    throw err;
  }
  if (!model || typeof model.bulkWrite !== 'function') {
    const err = new Error('A model exposing bulkWrite() is required.');
    err.code = PERSISTENCE_ERROR_CODES.INVALID_INPUT;
    throw err;
  }

  const startedAt = now();
  const providers = new Set();
  const result = {
    provider: null,
    projectId: projectIdHex,
    status: INGESTION_STATUS.SUCCEEDED,
    persisted: false,
    receivedCount: records.length,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    errors: [],
    startedAt: startedAt.toISOString(),
    completedAt: null,
  };

  let errorTotal = 0;
  const pushError = (index, record, code, message) => {
    errorTotal += 1;
    if (result.errors.length < MAX_ERRORS) {
      result.errors.push({
        index,
        provider: record && typeof record.provider === 'string' ? record.provider : null,
        externalId: safeExternalId(record),
        code,
        message: redactSecrets(message),
      });
    }
  };

  // 1. Validate and dedupe (last occurrence of an identity wins; earlier ones are skipped).
  const lastIndexByKey = new Map();
  const valid = [];
  records.forEach((record, index) => {
    const problem = checkRecord(record, projectIdHex);
    if (problem) {
      result.failedCount += 1;
      pushError(index, record, problem.code, problem.message);
      return;
    }
    providers.add(record.provider);
    lastIndexByKey.set(`${record.provider}\u0000${record.externalId}`, index);
    valid.push(index);
  });

  const pending = [];
  for (const index of valid) {
    const record = records[index];
    if (lastIndexByKey.get(`${record.provider}\u0000${record.externalId}`) !== index) {
      result.skippedCount += 1;
      pushError(index, record, PERSISTENCE_ERROR_CODES.DUPLICATE_IN_BATCH, 'Duplicate identity later in the same batch; the later record was persisted.');
      continue;
    }
    pending.push({ index, record, op: buildUpsertOperation(record, projectObjectId) });
  }

  // 2. Write in chunks; retry duplicate-key races once.
  const size = Math.max(1, Math.min(Number(chunkSize) || DEFAULT_CHUNK_SIZE, 1000));
  for (let start = 0; start < pending.length; start += size) {
    let batch = pending.slice(start, start + size);

    for (let attempt = 0; attempt < 2 && batch.length > 0; attempt += 1) {
      const { created, writeErrors, fatal } = await executeBulk(model, batch.map((p) => p.op));

      if (fatal) {
        for (const p of batch) {
          result.failedCount += 1;
          pushError(p.index, p.record, PERSISTENCE_ERROR_CODES.DATABASE_ERROR, 'Database write failed; record was not persisted.');
        }
        batch = [];
        break;
      }

      const retry = [];
      batch.forEach((p, i) => {
        const writeError = writeErrors.get(i);
        if (!writeError) {
          if (created.has(i)) result.createdCount += 1;
          else result.updatedCount += 1;
          return;
        }
        // E11000 on an upsert means a concurrent writer inserted the same identity first;
        // retrying turns it into an update of that document.
        if (writeError.code === DUPLICATE_KEY_CODE && attempt === 0) {
          retry.push(p);
          return;
        }
        result.failedCount += 1;
        pushError(p.index, p.record, PERSISTENCE_ERROR_CODES.WRITE_FAILED, `Write failed${writeError.code ? ` (code ${writeError.code})` : ''}: ${writeError.message}`);
      });
      batch = retry;
    }
  }

  if (errorTotal > result.errors.length) {
    result.errors.push({
      index: -1,
      provider: null,
      externalId: null,
      code: 'ERRORS_TRUNCATED',
      message: `${errorTotal - result.errors.length} additional record errors omitted.`,
    });
  }

  const written = result.createdCount + result.updatedCount;
  result.persisted = written > 0;
  result.provider = providers.size === 1 ? [...providers][0] : providers.size > 1 ? 'mixed' : null;
  if (result.failedCount === 0) result.status = INGESTION_STATUS.SUCCEEDED;
  else if (written > 0) result.status = INGESTION_STATUS.PARTIAL;
  else result.status = INGESTION_STATUS.FAILED;
  result.completedAt = now().toISOString();

  return result;
}
