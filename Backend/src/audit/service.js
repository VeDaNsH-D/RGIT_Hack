import { ActivityEvent } from '../models/ActivityEvent.js';
import { computeEventHash, GENESIS_HASH, verifyEvents } from './hash.js';

const MAX_SEQ_RACE_ATTEMPTS = 5;

async function attemptLog({ projectId, actorId, actorType, action, targetType, targetId, payload }) {
  const chainKey = projectId ? String(projectId) : 'system';
  const occurredAt = new Date();

  let lastErr;
  for (let attempt = 0; attempt < MAX_SEQ_RACE_ATTEMPTS; attempt++) {
    const last = await ActivityEvent.findOne({ chainKey }).sort({ seq: -1 }).lean();
    const seq = last ? last.seq + 1 : 0;
    const prevHash = last ? last.hash : GENESIS_HASH;
    const eventForHash = { chainKey, seq, actorId, actorType, action, targetType, targetId, payload, occurredAt };
    const hash = computeEventHash(eventForHash, prevHash);

    try {
      return await ActivityEvent.create({
        ...eventForHash,
        projectId: projectId || null,
        prevHash,
        hash,
      });
    } catch (err) {
      lastErr = err;
      // Duplicate (chainKey, seq): another writer won the race for this
      // seq. Retry and recompute against the new tail.
      if (err?.code === 11000) continue;
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Appends one event to the per-project (or 'system') hash chain. Never
 * throws — auditing must never break the calling workflow. Failures are
 * logged and the function resolves to null.
 */
export async function logActivity({
  projectId = null,
  actorId = null,
  actorType = 'user',
  action,
  targetType = '',
  targetId = null,
  payload = {},
}) {
  try {
    return await attemptLog({ projectId, actorId, actorType, action, targetType, targetId, payload });
  } catch (err) {
    console.error('[audit] logActivity failed:', err);
    return null;
  }
}

export async function listActivity(chainKey, { page = 1, limit = 50 } = {}) {
  const skip = (page - 1) * limit;
  return ActivityEvent.find({ chainKey: String(chainKey) })
    .sort({ seq: 1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

export async function verifyProjectChain(projectId) {
  const events = await ActivityEvent.find({ chainKey: String(projectId) }).sort({ seq: 1 }).lean();
  return verifyEvents(events);
}
