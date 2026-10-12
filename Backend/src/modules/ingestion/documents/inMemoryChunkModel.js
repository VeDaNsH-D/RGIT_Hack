/**
 * @file inMemoryChunkModel.js
 * @description Test double for the DocumentChunk model's `bulkWrite` (upsert) / `deleteMany` / `find`.
 */

const key = (f) => `${f.projectId}|${f.documentId}|${f.chunkIndex}`;

export class InMemoryChunkModel {
  constructor() {
    /** @type {Map<string, Object>} */
    this.rows = new Map();
    this.failNext = null;
  }

  failNextBulkWrite(error = new Error('connection closed')) { this.failNext = error; }

  all() { return [...this.rows.values()]; }

  async bulkWrite(ops) {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    for (const { updateOne } of ops) {
      const k = key(updateOne.filter);
      this.rows.set(k, { ...(this.rows.get(k) || {}), ...updateOne.filter, ...updateOne.update.$set });
    }
    return { ok: 1 };
  }

  async deleteMany(filter) {
    let deleted = 0;
    for (const [k, r] of [...this.rows]) {
      if (String(r.projectId) !== String(filter.projectId)) continue;
      if (filter.documentId && String(r.documentId) !== String(filter.documentId)) continue;
      if (filter.chunkIndex?.$gte !== undefined && r.chunkIndex < filter.chunkIndex.$gte) continue;
      this.rows.delete(k);
      deleted += 1;
    }
    return { deletedCount: deleted };
  }
}
