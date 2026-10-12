import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, ERROR_CODES, TERMINAL_STATES } from '../../src/handoffs/lifecycle.js';

function assertLifecycleError(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, 'LifecycleError');
    assert.equal(err.code, code);
    return true;
  });
}

describe('happy path', () => {
  test('DRAFT --SUBMIT(ready)--> SUBMITTED --ACKNOWLEDGE--> ACKNOWLEDGED', () => {
    const r1 = applyEvent({ state: 'DRAFT', event: 'SUBMIT', actorRole: 'outgoing', validationReady: true });
    assert.equal(r1.state, 'SUBMITTED');

    const r2 = applyEvent({ state: r1.state, event: 'ACKNOWLEDGE', actorRole: 'incoming' });
    assert.equal(r2.state, 'ACKNOWLEDGED');
  });

  test('DRAFT --SUBMIT(not ready)--> EDITING', () => {
    const r = applyEvent({ state: 'DRAFT', event: 'SUBMIT', actorRole: 'outgoing', validationReady: false });
    assert.equal(r.state, 'EDITING');
  });
});

describe('clarification loop', () => {
  test('SUBMITTED -> CLARIFICATION_REQUESTED -> EDITING -> SUBMITTED -> ACKNOWLEDGED', () => {
    let state = 'SUBMITTED';
    state = applyEvent({ state, event: 'REQUEST_CLARIFICATION', actorRole: 'incoming' }).state;
    assert.equal(state, 'CLARIFICATION_REQUESTED');

    state = applyEvent({ state, event: 'RESPOND', actorRole: 'outgoing' }).state;
    assert.equal(state, 'EDITING');

    state = applyEvent({ state, event: 'SUBMIT', actorRole: 'outgoing', validationReady: true }).state;
    assert.equal(state, 'SUBMITTED');

    state = applyEvent({ state, event: 'ACKNOWLEDGE', actorRole: 'incoming' }).state;
    assert.equal(state, 'ACKNOWLEDGED');
  });
});

describe('cancel from any open state', () => {
  for (const state of ['DRAFT', 'EDITING', 'SUBMITTED', 'CLARIFICATION_REQUESTED']) {
    test(`CANCEL from ${state} by outgoing succeeds`, () => {
      const r = applyEvent({ state, event: 'CANCEL', actorRole: 'outgoing' });
      assert.equal(r.state, 'CANCELLED');
    });
  }
});

describe('wrong actor', () => {
  test('incoming cannot SUBMIT', () => {
    assertLifecycleError(
      () => applyEvent({ state: 'DRAFT', event: 'SUBMIT', actorRole: 'incoming', validationReady: true }),
      ERROR_CODES.WRONG_ACTOR
    );
  });

  test('outgoing cannot ACKNOWLEDGE', () => {
    assertLifecycleError(
      () => applyEvent({ state: 'SUBMITTED', event: 'ACKNOWLEDGE', actorRole: 'outgoing' }),
      ERROR_CODES.WRONG_ACTOR
    );
  });

  test('incoming cannot CANCEL', () => {
    assertLifecycleError(
      () => applyEvent({ state: 'SUBMITTED', event: 'CANCEL', actorRole: 'incoming' }),
      ERROR_CODES.WRONG_ACTOR
    );
  });

  test('incoming cannot RESPOND', () => {
    assertLifecycleError(
      () => applyEvent({ state: 'CLARIFICATION_REQUESTED', event: 'RESPOND', actorRole: 'incoming' }),
      ERROR_CODES.WRONG_ACTOR
    );
  });
});

describe('illegal transitions', () => {
  test('cannot ACKNOWLEDGE from DRAFT', () => {
    assertLifecycleError(
      () => applyEvent({ state: 'DRAFT', event: 'ACKNOWLEDGE', actorRole: 'incoming' }),
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  });

  test('cannot REQUEST_CLARIFICATION from DRAFT', () => {
    assertLifecycleError(
      () => applyEvent({ state: 'DRAFT', event: 'REQUEST_CLARIFICATION', actorRole: 'incoming' }),
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  });

  test('cannot RESPOND from SUBMITTED (must be clarification-requested first)', () => {
    assertLifecycleError(
      () => applyEvent({ state: 'SUBMITTED', event: 'RESPOND', actorRole: 'outgoing' }),
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  });

  test('cannot SUBMIT from CLARIFICATION_REQUESTED directly (must RESPOND first)', () => {
    assertLifecycleError(
      () =>
        applyEvent({
          state: 'CLARIFICATION_REQUESTED',
          event: 'SUBMIT',
          actorRole: 'outgoing',
          validationReady: true,
        }),
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  });
});

describe('terminal states', () => {
  for (const state of TERMINAL_STATES) {
    for (const event of ['SUBMIT', 'ACKNOWLEDGE', 'REQUEST_CLARIFICATION', 'RESPOND', 'CANCEL']) {
      test(`${state} rejects ${event}`, () => {
        assertLifecycleError(
          () => applyEvent({ state, event, actorRole: 'outgoing', validationReady: true }),
          ERROR_CODES.TERMINAL_STATE
        );
      });
    }
  }
});
