/**
 * @file inMemorySourceRecordModel.js
 * @description Test double for the SourceRecord Mongoose model's `bulkWrite`.
 *
 * Emulates the parts of MongoDB/Mongoose that persistence relies on:
 * - unique identity (projectId, provider, externalId)
 * - `updateOne` upserts with `$set` (dotted paths) and `$setOnInsert`
 * - unordered execution that continues past per-operation errors
 * - MongoBulkWriteError shape: `writeErrors[{ index, code, errmsg }]`, `result.upsertedIds`
 *
 * Fault injection for tests: `failOn`, `raceOn`, `failNextBulkWrite`.
 */

import mongoose from 'mongoose';

function keyOf(filter) {
  const pid = filter.projectId instanceof mongoose.Types.ObjectId ? filter.projectId.toHexString() : String(filter.projectId);
  return `${pid}|${filter.provider}|${filter.externalId}`;
}

// structuredClone drops class prototypes (ObjectId would become a plain object).
function clone(value) {
  if (value instanceof mongoose.Types.ObjectId || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  }
  return value;
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = clone(value);
}

export class InMemorySourceRecordModel {
  constructor() {
    /** @type {Map<string, Object>} */
    this.docs = new Map();
    this.bulkWriteCalls = [];
    this.#failures = new Map();
    this.#races = new Set();
    this.#fatal = null;
  }

  #failures;
  #races;
  #fatal;

  /** Make every write for this externalId fail with the given server error. */
  failOn(externalId, { code = 121, errmsg = 'Document failed validation' } = {}) {
    this.#failures.set(externalId, { code, errmsg });
  }

  /** Simulate a concurrent writer inserting this identity just before our first upsert. */
  raceOn(externalId) {
    this.#races.add(externalId);
  }

  /** Make the next bulkWrite throw a non-write error (e.g. connection loss). */
  failNextBulkWrite(error = new Error('connection closed')) {
    this.#fatal = error;
  }

  all() {
    return [...this.docs.values()];
  }

  find(filter) {
    return this.docs.get(keyOf(filter)) || null;
  }

  /** Seed an existing document (as if persisted earlier). */
  seed(doc) {
    const stored = { _id: new mongoose.Types.ObjectId(), metadata: {}, url: '', isDemo: false, ...clone(doc) };
    this.docs.set(keyOf(stored), stored);
    return stored;
  }

  async bulkWrite(ops, options = {}) {
    this.bulkWriteCalls.push({ ops: clone(ops), options });

    if (this.#fatal) {
      const err = this.#fatal;
      this.#fatal = null;
      throw err;
    }

    const upsertedIds = {};
    const writeErrors = [];
    let matchedCount = 0;

    ops.forEach((op, index) => {
      const { filter, update, upsert } = op.updateOne;
      const key = keyOf(filter);

      const failure = this.#failures.get(filter.externalId);
      if (failure) {
        writeErrors.push({ index, code: failure.code, errmsg: failure.errmsg });
        return;
      }

      if (this.#races.has(filter.externalId) && !this.docs.has(key)) {
        this.#races.delete(filter.externalId);
        this.seed({ ...filter, title: 'inserted by concurrent writer', metadata: { providerMetadata: { racer: true } } });
        writeErrors.push({ index, code: 11000, errmsg: 'E11000 duplicate key error collection: sourcerecords' });
        return;
      }

      let doc = this.docs.get(key);
      if (doc) {
        matchedCount += 1;
      } else if (upsert) {
        doc = { _id: new mongoose.Types.ObjectId(), ...clone(filter), isDemo: false };
        for (const [path, value] of Object.entries(update.$setOnInsert || {})) setPath(doc, path, value);
        this.docs.set(key, doc);
        upsertedIds[index] = doc._id;
      } else {
        return;
      }

      for (const [path, value] of Object.entries(update.$set || {})) setPath(doc, path, value);
    });

    const result = { upsertedIds, matchedCount, upsertedCount: Object.keys(upsertedIds).length };

    if (writeErrors.length > 0) {
      const err = new Error(`${writeErrors.length} write error(s)`);
      err.name = 'MongoBulkWriteError';
      err.writeErrors = writeErrors;
      err.result = result;
      throw err;
    }

    return result;
  }
}
