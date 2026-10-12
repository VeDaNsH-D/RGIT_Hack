import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  emitNotificationEvent,
  registerNotificationHandler,
  _resetNotificationHandlers,
} from '../../src/notifications/emitEvent.js';

// These tests avoid touching the DB: they either use an event type the
// default in-app handler no-ops on (no DB access), or an event that fails
// validation/mapping before any DB call is made.

afterEach(() => {
  _resetNotificationHandlers();
});

describe('emitNotificationEvent', () => {
  test('rejects a malformed event synchronously (bad type)', async () => {
    await assert.rejects(() =>
      emitNotificationEvent({ type: 'NOT_A_REAL_EVENT', recipientUserId: '507f1f77bcf86cd799439011' })
    );
  });

  test('rejects an event missing recipientUserId', async () => {
    await assert.rejects(() => emitNotificationEvent({ type: 'TASK_OVERDUE' }));
  });

  test('a type not yet supported by the in-app system no-ops without throwing', async () => {
    await assert.doesNotReject(() =>
      emitNotificationEvent({
        type: 'TASK_OVERDUE',
        recipientUserId: new mongoose.Types.ObjectId().toString(),
        payload: {},
      })
    );
  });

  test('a supported type with a missing entityId is caught, not thrown to the caller', async () => {
    await assert.doesNotReject(() =>
      emitNotificationEvent({
        type: 'HANDOFF_SUBMITTED',
        recipientUserId: new mongoose.Types.ObjectId().toString(),
        projectId: new mongoose.Types.ObjectId().toString(),
        payload: { outgoingUserId: 'user-1' }, // no entityId
      })
    );
  });

  test('one failing extra handler does not prevent other handlers or break the caller', async () => {
    let otherHandlerRan = false;
    registerNotificationHandler(async () => {
      throw new Error('boom');
    });
    registerNotificationHandler(async () => {
      otherHandlerRan = true;
    });

    await assert.doesNotReject(() =>
      emitNotificationEvent({
        type: 'TASK_OVERDUE', // default handler no-ops, no DB touched
        recipientUserId: new mongoose.Types.ObjectId().toString(),
        payload: {},
      })
    );
    assert.equal(otherHandlerRan, true);
  });
});
