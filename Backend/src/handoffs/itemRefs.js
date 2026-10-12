import { SourceRecord } from '../models/SourceRecord.js';

export class ItemReferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ItemReferenceError';
    this.code = 'INVALID_ITEM_SOURCE_RECORD';
  }
}

/**
 * Validates that every item.sourceRecordId referenced by a handoff's items
 * (e.g. a decision) actually belongs to that same project. Throws
 * ItemReferenceError otherwise. This is a DB-dependent check, so it lives
 * outside the pure validation.js — call it from the handoff route/service
 * layer when items are set/updated.
 */
export async function assertItemSourceRecordsBelongToProject(projectId, items) {
  const ids = [...new Set((items || []).filter((i) => i.sourceRecordId).map((i) => String(i.sourceRecordId)))];
  if (ids.length === 0) return;

  const records = await SourceRecord.find({ _id: { $in: ids } }).select('_id projectId').lean();
  const byId = new Map(records.map((r) => [String(r._id), r]));

  for (const id of ids) {
    const record = byId.get(id);
    if (!record) {
      throw new ItemReferenceError(`sourceRecordId ${id} does not exist`);
    }
    if (String(record.projectId) !== String(projectId)) {
      throw new ItemReferenceError(`sourceRecordId ${id} does not belong to this project`);
    }
  }
}
