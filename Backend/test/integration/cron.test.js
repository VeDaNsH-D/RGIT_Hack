import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import { app } from '../../src/app.js';
import { connectDB } from '../../src/db.js';
import { config } from '../../src/config.js';
import { User } from '../../src/models/User.js';
import { Project } from '../../src/models/Project.js';
import { ProjectMembership } from '../../src/models/ProjectMembership.js';
import { Task } from '../../src/models/Task.js';
import { Handoff } from '../../src/models/Handoff.js';
import { ActivityEvent } from '../../src/models/ActivityEvent.js';
import { NotificationModel } from '../../src/models/Notification.js';

after(async () => {
  await mongoose.connection.close();
});

describe('GET /api/cron/overdue', () => {
  let server;
  let baseUrl;
  let owner;
  let assignee;
  let incoming;
  let project;

  before(async () => {
    await connectDB();
    const suffix = Date.now();
    owner = await User.create({ email: `cron-owner-${suffix}@example.com`, name: 'Owner' });
    assignee = await User.create({ email: `cron-assignee-${suffix}@example.com`, name: 'Assignee' });
    incoming = await User.create({ email: `cron-incoming-${suffix}@example.com`, name: 'Incoming' });

    project = await Project.create({ name: 'Cron Test', ownerId: owner._id, createdBy: owner._id });
    await ProjectMembership.create({ projectId: project._id, userId: owner._id, role: 'owner', invitedBy: owner._id });
    await ProjectMembership.create({ projectId: project._id, userId: assignee._id, role: 'member', invitedBy: owner._id });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Task.deleteMany({ projectId: project._id });
    await Handoff.deleteMany({ projectId: project._id });
    await ActivityEvent.deleteMany({ chainKey: String(project._id) });
    await NotificationModel.deleteMany({
      recipientUserId: { $in: [String(owner._id), String(assignee._id), String(incoming._id)] },
    });
    await ProjectMembership.deleteMany({ projectId: project._id });
    await Project.deleteOne({ _id: project._id });
    await User.deleteMany({ _id: { $in: [owner._id, assignee._id, incoming._id] } });
  });

  function cronHeaders(secret) {
    return secret ? { Authorization: `Bearer ${secret}` } : {};
  }

  describe('auth', () => {
    test('missing Authorization header is rejected with 401', async () => {
      const res = await fetch(`${baseUrl}/api/cron/overdue`);
      assert.equal(res.status, 401);
    });

    test('wrong secret is rejected with 401', async () => {
      const res = await fetch(`${baseUrl}/api/cron/overdue`, { headers: cronHeaders('not-the-real-secret') });
      assert.equal(res.status, 401);
    });

    test('correct secret is accepted', async () => {
      const res = await fetch(`${baseUrl}/api/cron/overdue`, { headers: cronHeaders(config.cronSecret) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(typeof body.processed.overdueTasks === 'number');
      assert.ok(typeof body.processed.overdueHandoffs === 'number');
    });
  });

  describe('overdue tasks: claim-once, assignee vs owner fallback', () => {
    let assignedTask;
    let unassignedTask;

    before(async () => {
      const pastDeadline = new Date(Date.now() - 60 * 60 * 1000);
      assignedTask = await Task.create({
        projectId: project._id,
        title: 'Assigned overdue task',
        origin: 'manual',
        priority: 'high',
        status: 'open',
        assignee: assignee._id,
        deadline: pastDeadline,
        createdBy: owner._id,
      });
      unassignedTask = await Task.create({
        projectId: project._id,
        title: 'Unassigned overdue task',
        origin: 'manual',
        priority: 'high',
        status: 'open',
        deadline: pastDeadline,
        createdBy: owner._id,
      });
    });

    test('a single cron run claims both tasks exactly once', async () => {
      const res = await fetch(`${baseUrl}/api/cron/overdue`, { headers: cronHeaders(config.cronSecret) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.processed.overdueTasks >= 2);

      const refreshedAssigned = await Task.findById(assignedTask._id).lean();
      const refreshedUnassigned = await Task.findById(unassignedTask._id).lean();
      assert.ok(refreshedAssigned.overdueNotifiedAt);
      assert.ok(refreshedUnassigned.overdueNotifiedAt);
    });

    test('notified the assignee for the assigned task, and the project owner for the unassigned one', async () => {
      const assignedNotif = await NotificationModel.findOne({
        eventId: { $regex: `^task-overdue-${assignedTask._id}-` },
      }).lean();
      const unassignedNotif = await NotificationModel.findOne({
        eventId: { $regex: `^task-overdue-${unassignedTask._id}-` },
      }).lean();

      const events = await ActivityEvent.find({ chainKey: String(project._id), action: 'TASK_OVERDUE' }).lean();
      const targetIds = events.map((e) => String(e.targetId));
      assert.ok(targetIds.includes(String(assignedTask._id)));
      assert.ok(targetIds.includes(String(unassignedTask._id)));

      // TASK_OVERDUE gap is closed: in-app Notification rows are delivered
      assert.ok(assignedNotif, 'assigned task should produce an in-app notification for the assignee');
      assert.equal(assignedNotif.recipientUserId, String(assignee._id));
      assert.ok(unassignedNotif, 'unassigned task should produce an in-app notification for the project owner');
      assert.equal(unassignedNotif.recipientUserId, String(owner._id));
    });

    test('an immediate second cron run does not re-claim the same tasks (24h cooldown)', async () => {
      const before1 = await Task.findById(assignedTask._id).lean();
      const res = await fetch(`${baseUrl}/api/cron/overdue`, { headers: cronHeaders(config.cronSecret) });
      await res.json();
      const after1 = await Task.findById(assignedTask._id).lean();
      assert.equal(before1.overdueNotifiedAt.toISOString(), after1.overdueNotifiedAt.toISOString());
    });

    test('two concurrent cron runs claim an overdue task exactly once in total', async () => {
      const raceTask = await Task.create({
        projectId: project._id,
        title: 'Race condition task',
        origin: 'manual',
        priority: 'high',
        status: 'open',
        deadline: new Date(Date.now() - 60 * 60 * 1000),
        createdBy: owner._id,
      });

      const [r1, r2] = await Promise.all([
        fetch(`${baseUrl}/api/cron/overdue`, { headers: cronHeaders(config.cronSecret) }),
        fetch(`${baseUrl}/api/cron/overdue`, { headers: cronHeaders(config.cronSecret) }),
      ]);
      await r1.json();
      await r2.json();

      const events = await ActivityEvent.find({
        chainKey: String(project._id),
        action: 'TASK_OVERDUE',
        targetId: raceTask._id,
      }).lean();
      assert.equal(events.length, 1, 'the race task should only be audited once across both concurrent runs');

      await Task.deleteOne({ _id: raceTask._id });
    });
  });

  describe('overdue handoff acknowledgement', () => {
    let handoff;

    before(async () => {
      const staleSubmittedAt = new Date(Date.now() - (config.ackSlaHours + 1) * 60 * 60 * 1000);
      handoff = await Handoff.create({
        projectId: project._id,
        fromUserId: owner._id,
        toUserId: incoming._id,
        state: 'SUBMITTED',
        isOpen: true,
        submittedAt: staleSubmittedAt,
      });
    });

    after(async () => {
      await Handoff.deleteOne({ _id: handoff._id });
    });

    test('a stale SUBMITTED handoff is claimed and both parties are logged/notified', async () => {
      const res = await fetch(`${baseUrl}/api/cron/overdue`, { headers: cronHeaders(config.cronSecret) });
      const body = await res.json();
      assert.ok(body.processed.overdueHandoffs >= 1);

      const refreshed = await Handoff.findById(handoff._id).lean();
      assert.ok(refreshed.ackReminderSentAt);

      const events = await ActivityEvent.find({
        chainKey: String(project._id),
        action: 'HANDOFF_ACK_OVERDUE',
        targetId: handoff._id,
      }).lean();
      assert.equal(events.length, 1);
      assert.equal(events[0].actorType, 'system');
      assert.equal(events[0].actorId, null);
    });

    test('an immediate second run does not re-claim the same handoff', async () => {
      const before1 = await Handoff.findById(handoff._id).lean();
      const res = await fetch(`${baseUrl}/api/cron/overdue`, { headers: cronHeaders(config.cronSecret) });
      await res.json();
      const after1 = await Handoff.findById(handoff._id).lean();
      assert.equal(before1.ackReminderSentAt.toISOString(), after1.ackReminderSentAt.toISOString());
    });
  });
});
