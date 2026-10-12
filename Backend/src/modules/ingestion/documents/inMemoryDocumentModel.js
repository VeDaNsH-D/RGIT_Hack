/**
 * @file inMemoryDocumentModel.js
 * @description Test double for the Document model's `create` / `updateOne`. Every document is
 * built and validated with the REAL Document schema (`validateSync`), so field
 * names, required fields, enums and casting match production.
 */

import { Document } from '../../../models/Document.js';

function setPath(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) node = node[part] ??= {};
  node[parts.at(-1)] = value;
}

export class InMemoryDocumentModel {
  constructor() {
    this.docs = [];
    this.createCalls = 0;
    this.#createError = null;
  }

  #createError;

  /** Make the next create() reject (e.g. database unavailable). */
  failNextCreate(error = new Error('connection closed')) {
    this.#createError = error;
  }

  async create(data) {
    this.createCalls += 1;
    if (this.#createError) {
      const err = this.#createError;
      this.#createError = null;
      throw err;
    }
    const doc = new Document(data);
    const validationError = doc.validateSync();
    if (validationError) throw validationError;
    const now = new Date();
    doc.createdAt = now;
    doc.updatedAt = now;
    this.docs.push(doc);
    return doc;
  }

  /** Supports the `{ _id, projectId, status/processingStartedAt conditions }` filters and $set/$unset/$inc used by indexing. */
  async updateOne(filter, update) {
    const doc = this.docs.find((d) => String(d._id) === String(filter._id) && String(d.projectId) === String(filter.projectId));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (filter.$or) {
      const ok = filter.$or.some((c) => {
        if (c.status?.$ne !== undefined) return doc.status !== c.status.$ne;
        if (c.processingStartedAt?.$lt) return doc.processingStartedAt && doc.processingStartedAt < c.processingStartedAt.$lt;
        if (c.processingStartedAt?.$exists === false) return !doc.processingStartedAt;
        return false;
      });
      if (!ok) return { matchedCount: 1, modifiedCount: 0 };
    }
    for (const [k, v] of Object.entries(update.$set || {})) setPath(doc, k, v);
    for (const k of Object.keys(update.$unset || {})) doc.set(k, undefined);
    for (const [k, v] of Object.entries(update.$inc || {})) doc.set(k, (doc.get(k) || 0) + v);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async findOne(filter) {
    return this.docs.find((d) => String(d._id) === String(filter._id) && String(d.projectId) === String(filter.projectId)) ?? null;
  }
}
