import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENESIS_HASH,
  stableStringify,
  computeEventHash,
  verifyEvents,
} from '../../src/audit/hash.js';

function buildChain(n) {
  const events = [];
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const event = {
      chainKey: 'project-1',
      seq: i,
      actorId: 'user-A',
      actorType: 'user',
      action: `ACTION_${i}`,
      targetType: 'Task',
      targetId: `task-${i}`,
      payload: { index: i },
      occurredAt: new Date(2026, 0, 1 + i).toISOString(),
    };
    const hash = computeEventHash(event, prevHash);
    events.push({ ...event, prevHash, hash });
    prevHash = hash;
  }
  return events;
}

describe('stableStringify', () => {
  test('key order does not affect output', () => {
    const a = stableStringify({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = stableStringify({ a: 2, c: { x: 2, y: 1 }, b: 1 });
    assert.equal(a, b);
  });
});

describe('genesis and chain construction', () => {
  test('first event in a chain uses the genesis hash as prevHash', () => {
    const events = buildChain(1);
    assert.equal(events[0].prevHash, GENESIS_HASH);
    assert.equal(GENESIS_HASH, '0'.repeat(64));
  });

  test('a valid chain of several events verifies as valid', () => {
    const events = buildChain(5);
    const result = verifyEvents(events);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });
});

describe('tamper detection', () => {
  test('editing an event payload (without updating its hash) is detected', () => {
    const events = buildChain(4);
    events[1] = { ...events[1], payload: { index: 999 } };
    const result = verifyEvents(events);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === 'HASH_MISMATCH' && e.seq === 1));
  });

  test('deleting an event is detected as a seq gap', () => {
    const events = buildChain(4);
    events.splice(1, 1); // remove seq 1
    const result = verifyEvents(events);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === 'SEQ_GAP_OR_DUPLICATE'));
  });

  test('reordering events (swapping array positions) is detected', () => {
    const events = buildChain(4);
    [events[1], events[2]] = [events[2], events[1]];
    const result = verifyEvents(events);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === 'SEQ_GAP_OR_DUPLICATE'));
    assert.ok(result.errors.some((e) => e.code === 'PREV_HASH_MISMATCH'));
  });

  test('rewriting both an event and its own hash is caught by the next link', () => {
    const events = buildChain(4);
    const forged = { ...events[1], payload: { index: 'forged' } };
    forged.hash = computeEventHash(forged, forged.prevHash); // attacker recomputes hash too
    events[1] = forged;

    const result = verifyEvents(events);
    assert.equal(result.valid, false);
    // The forged event's own hash is now internally consistent...
    assert.ok(!result.errors.some((e) => e.seq === 1 && e.code === 'HASH_MISMATCH'));
    // ...but the next event's prevHash still points at the ORIGINAL hash.
    assert.ok(result.errors.some((e) => e.seq === 2 && e.code === 'PREV_HASH_MISMATCH'));
  });

  test('duplicate seq values are flagged', () => {
    const events = buildChain(3);
    events[2] = { ...events[2], seq: 1 };
    const result = verifyEvents(events);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === 'SEQ_GAP_OR_DUPLICATE'));
  });
});
