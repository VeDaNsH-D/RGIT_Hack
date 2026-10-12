import crypto from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic JSON stringify: object keys are sorted recursively so the
 * same logical payload always serializes to the same bytes regardless of
 * key insertion order.
 */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The exact fields that are hashed for an event, with consistent typing
 * (dates as ISO strings, missing optionals normalized to null/defaults) so
 * hashing is stable across serialization boundaries (e.g. a Mongo document
 * vs. a plain object built right before insert).
 */
export function canonicalEventPayload(event) {
  return {
    chainKey: event.chainKey,
    seq: event.seq,
    actorId: event.actorId ? String(event.actorId) : null,
    actorType: event.actorType ?? 'user',
    action: event.action,
    targetType: event.targetType ?? '',
    targetId: event.targetId ? String(event.targetId) : null,
    payload: event.payload ?? {},
    occurredAt:
      event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
  };
}

/**
 * hash(i) = SHA-256(stableStringify({ prevHash, payload: canonical(event) }))
 * The genesis hash (seq 0's prevHash) is 64 zeros.
 */
export function computeEventHash(event, prevHash) {
  const data = stableStringify({ prevHash, payload: canonicalEventPayload(event) });
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Verifies a hash chain. `events` is checked in the exact array order
 * given — callers pass the list in the order it is meant to represent
 * (e.g. fetched from the DB ordered by seq). This is deliberate: it means
 * a reordering tamper (swapping two events' positions while leaving their
 * seq/hash fields alone) is caught as a seq/prevHash mismatch rather than
 * silently "fixed" by re-sorting here. Detects:
 *  - edits: recomputed hash != stored hash for that event
 *  - deletions: a gap in the seq sequence
 *  - reordering: seq out of order and/or prevHash no longer matches the
 *    preceding event's hash
 *  - rewrites of both event and hash: caught at the NEXT event, whose
 *    prevHash was captured against the original hash and so no longer
 *    matches the tampered one. A rewrite of only the single most recent
 *    event (nothing downstream references its hash yet) is undetectable
 *    by the chain alone — that is an inherent limit of hash chains without
 *    an external anchor, not a bug in this implementation.
 */
export function verifyEvents(events) {
  const errors = [];

  let expectedSeq = 0;
  let expectedPrevHash = GENESIS_HASH;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    if (ev.seq !== expectedSeq) {
      errors.push({
        index: i,
        seq: ev.seq,
        code: 'SEQ_GAP_OR_DUPLICATE',
        message: `Expected seq ${expectedSeq}, found ${ev.seq}`,
      });
    }

    if (ev.prevHash !== expectedPrevHash) {
      errors.push({
        index: i,
        seq: ev.seq,
        code: 'PREV_HASH_MISMATCH',
        message: 'prevHash does not match the preceding event hash (reordered or missing link)',
      });
    }

    const recomputed = computeEventHash(ev, ev.prevHash);
    if (recomputed !== ev.hash) {
      errors.push({
        index: i,
        seq: ev.seq,
        code: 'HASH_MISMATCH',
        message: 'Stored hash does not match the recomputed hash of this event',
      });
    }

    expectedSeq = ev.seq + 1;
    expectedPrevHash = ev.hash;
  }

  return { valid: errors.length === 0, errors };
}
