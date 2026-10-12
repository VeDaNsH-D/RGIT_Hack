import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDB } from '../../src/db.js';
import { User } from '../../src/models/User.js';
import { NotificationModel } from '../../src/models/Notification.js';
import { emitNotificationEvent, _resetNotificationHandlers } from '../../src/notifications/emitEvent.js';

// Requires a live MongoDB connection (see MONGODB_URI in .env). Run with
// `npm test` from the Backend directory.
after(async () => {
  await mongoose.connection.close();
});

describe('emitNotificationEvent -> Person 4 in-app delivery (real DB)', () => {
  let recipient;
  const projectId = new mongoose.Types.ObjectId().toString();
  const entityId = new mongoose.Types.ObjectId().toString();

  before(async () => {
    await connectDB();
    recipient = await User.create({ email: `notif-${Date.now()}@example.com`, name: 'Notif Recipient' });
  });

  after(async () => {
    await NotificationModel.deleteMany({ recipientUserId: String(recipient._id) });
    await User.deleteOne({ _id: recipient._id });
    _resetNotificationHandlers();
  });

  test('HANDOFF_SUBMITTED is delivered as a real Notification record', async () => {
    const dedupeKey = `test-handoff-submitted-${Date.now()}`;

    await emitNotificationEvent({
      type: 'HANDOFF_SUBMITTED',
      projectId,
      recipientUserId: String(recipient._id),
      dedupeKey,
      payload: { entityId, outgoingUserId: 'user-outgoing', handoffTitle: 'Q1 handoff' },
    });

    const record = await NotificationModel.findOne({ eventId: dedupeKey }).lean();
    assert.ok(record, 'expected a Notification record to be created');
    assert.equal(record.type, 'HANDOFF_SUBMITTED');
    assert.equal(record.recipientUserId, String(recipient._id));
    assert.equal(record.entityId, entityId);
    assert.ok(record.title.length > 0);
    assert.ok(record.message.includes(entityId));
  });

  test('CRITICAL_CONFLICT_DETECTED is delivered with its specific fields rendered', async () => {
    const dedupeKey = `test-conflict-${Date.now()}`;

    await emitNotificationEvent({
      type: 'CRITICAL_CONFLICT_DETECTED',
      projectId,
      recipientUserId: String(recipient._id),
      dedupeKey,
      payload: { entityId, conflictType: 'DEADLINE_MISMATCH', description: 'Two sources disagree', severity: 'critical' },
    });

    const record = await NotificationModel.findOne({ eventId: dedupeKey }).lean();
    assert.ok(record);
    assert.ok(record.message.includes('DEADLINE_MISMATCH'));
    assert.ok(record.message.includes('Two sources disagree'));
  });

  test('re-emitting the same dedupeKey does not create a duplicate record', async () => {
    const dedupeKey = `test-idempotent-${Date.now()}`;
    const event = {
      type: 'HANDOFF_NEEDS_CLARIFICATION',
      projectId,
      recipientUserId: String(recipient._id),
      dedupeKey,
      payload: { entityId, requestedByUserId: 'user-req', clarificationNote: 'Please clarify X' },
    };

    await emitNotificationEvent(event);
    await emitNotificationEvent(event);

    const count = await NotificationModel.countDocuments({ eventId: dedupeKey });
    assert.equal(count, 1);
  });

  test('HANDOFF_ACKNOWLEDGED is delivered as a real Notification record', async () => {
    const dedupeKey = `test-ack-${Date.now()}`;
    await emitNotificationEvent({
      type: 'HANDOFF_ACKNOWLEDGED',
      projectId,
      recipientUserId: String(recipient._id),
      dedupeKey,
      payload: { entityId, acceptedByUserId: 'user-incoming', notes: 'Verified and accepted.' },
    });

    const record = await NotificationModel.findOne({ eventId: dedupeKey }).lean();
    assert.ok(record);
    assert.equal(record.type, 'HANDOFF_ACKNOWLEDGED');
    assert.ok(record.message.includes('user-incoming'));
  });

  test('HANDOFF_CLARIFICATION_ANSWERED is delivered as a real Notification record', async () => {
    const dedupeKey = `test-clar-ans-${Date.now()}`;
    await emitNotificationEvent({
      type: 'HANDOFF_CLARIFICATION_ANSWERED',
      projectId,
      recipientUserId: String(recipient._id),
      dedupeKey,
      payload: { entityId, answeredByUserId: 'user-outgoing', clarificationNote: 'Docs updated.' },
    });

    const record = await NotificationModel.findOne({ eventId: dedupeKey }).lean();
    assert.ok(record);
    assert.equal(record.type, 'HANDOFF_CLARIFICATION_ANSWERED');
    assert.ok(record.message.includes('user-outgoing'));
  });

  test('HANDOFF_ACK_OVERDUE is delivered as a real Notification record', async () => {
    const dedupeKey = `test-ack-overdue-${Date.now()}`;
    await emitNotificationEvent({
      type: 'HANDOFF_ACK_OVERDUE',
      projectId,
      recipientUserId: String(recipient._id),
      dedupeKey,
      payload: { entityId, handoffTitle: 'Backend handoff', hoursOverdue: 12 },
    });

    const record = await NotificationModel.findOne({ eventId: dedupeKey }).lean();
    assert.ok(record);
    assert.equal(record.type, 'HANDOFF_ACK_OVERDUE');
    assert.ok(record.title.includes('Acknowledgment Overdue'));
  });

  test('TASK_OVERDUE is delivered as a real Notification record', async () => {
    const dedupeKey = `test-task-overdue-${Date.now()}`;
    await emitNotificationEvent({
      type: 'TASK_OVERDUE',
      projectId,
      recipientUserId: String(recipient._id),
      dedupeKey,
      payload: { entityId, taskId: entityId, taskTitle: 'Migrate indexes', dueDate: '2026-10-12T00:00:00Z' },
    });

    const record = await NotificationModel.findOne({ eventId: dedupeKey }).lean();
    assert.ok(record);
    assert.equal(record.type, 'TASK_OVERDUE');
    assert.ok(record.title.includes('Task Overdue'));
  });

  test('CONFLICT_RESOLVED is delivered as a real Notification record', async () => {
    const dedupeKey = `test-conflict-res-${Date.now()}`;
    await emitNotificationEvent({
      type: 'CONFLICT_RESOLVED',
      projectId,
      recipientUserId: String(recipient._id),
      dedupeKey,
      payload: { entityId, conflictType: 'DEADLINE_MISMATCH', resolvedByUserId: 'user-lead', resolutionNotes: 'Merged dates.' },
    });

    const record = await NotificationModel.findOne({ eventId: dedupeKey }).lean();
    assert.ok(record);
    assert.equal(record.type, 'CONFLICT_RESOLVED');
    assert.ok(record.title.includes('Conflict Resolved'));
    assert.ok(record.message.includes('user-lead'));
  });
});
