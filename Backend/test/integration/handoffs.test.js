import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import { app } from '../../src/app.js';
import { connectDB } from '../../src/db.js';
import { User } from '../../src/models/User.js';
import { Project } from '../../src/models/Project.js';
import { ProjectMembership } from '../../src/models/ProjectMembership.js';
import { Task } from '../../src/models/Task.js';
import { Handoff } from '../../src/models/Handoff.js';
import { signAuthToken } from '../../src/middleware/auth.js';

// Requires a live MongoDB connection (see MONGODB_URI in .env). Run with
// `npm test` from the Backend directory.
after(async () => {
  await mongoose.connection.close();
});

describe('handoff lifecycle: full flow, ownership, wrong-actor/wrong-state', () => {
  let server;
  let baseUrl;
  let owner; // outgoing
  let incoming;
  let thirdUser;
  let project;
  let unassignedTask;

  before(async () => {
    await connectDB();
    const suffix = Date.now();
    owner = await User.create({ email: `ho-owner-${suffix}@example.com`, name: 'Outgoing Owner' });
    incoming = await User.create({ email: `ho-incoming-${suffix}@example.com`, name: 'Incoming Owner' });
    thirdUser = await User.create({ email: `ho-third-${suffix}@example.com`, name: 'Third User' });

    project = await Project.create({ name: 'Handoff Flow Test', ownerId: owner._id, createdBy: owner._id });
    await ProjectMembership.create({ projectId: project._id, userId: owner._id, role: 'owner', invitedBy: owner._id });

    unassignedTask = await Task.create({
      projectId: project._id,
      title: 'Unassigned high-priority task',
      origin: 'manual',
      priority: 'high',
      createdBy: owner._id,
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Handoff.deleteMany({ projectId: project._id });
    await Task.deleteMany({ projectId: project._id });
    await ProjectMembership.deleteMany({ projectId: project._id });
    await Project.deleteOne({ _id: project._id });
    await User.deleteMany({ _id: { $in: [owner._id, incoming._id, thirdUser._id] } });
  });

  function h(user) {
    return { Authorization: `Bearer ${signAuthToken(user)}`, 'Content-Type': 'application/json' };
  }

  async function post(path, user, body) {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: h(user), body: JSON.stringify(body || {}) });
    return { status: res.status, body: await res.json() };
  }
  async function patch(path, user, body) {
    const res = await fetch(`${baseUrl}${path}`, { method: 'PATCH', headers: h(user), body: JSON.stringify(body || {}) });
    return { status: res.status, body: await res.json() };
  }
  async function get(path, user) {
    const res = await fetch(`${baseUrl}${path}`, { headers: h(user) });
    return { status: res.status, body: await res.json() };
  }

  let handoffId;

  test('a non-owner member cannot create a handoff', async () => {
    await ProjectMembership.create({ projectId: project._id, userId: incoming._id, role: 'member', invitedBy: owner._id });
    const r = await post(`/api/projects/${project._id}/handoffs`, incoming, { toUserId: String(owner._id) });
    assert.equal(r.status, 403);
    await ProjectMembership.deleteOne({ projectId: project._id, userId: incoming._id });
  });

  test('the owner creates a DRAFT handoff', async () => {
    const r = await post(`/api/projects/${project._id}/handoffs`, owner, { toUserId: String(incoming._id) });
    assert.equal(r.status, 201);
    assert.equal(r.body.handoff.state, 'DRAFT');
    assert.equal(r.body.handoff.fromUserId, String(owner._id));
    handoffId = r.body.handoff.id;
  });

  test('a second open handoff for the same project is rejected with 409', async () => {
    const r = await post(`/api/projects/${project._id}/handoffs`, owner, { toUserId: String(thirdUser._id) });
    assert.equal(r.status, 409);
  });

  test('a non-outgoing user (toUserId, but not a project member yet) cannot PATCH: 404', async () => {
    // incoming isn't a project member until the handoff is submitted, so
    // this correctly 404s rather than 403 — non-member existence is never
    // leaked. The 403 wrong-actor path is covered below once incoming is
    // a real member (post-submit, on acknowledge/cancel).
    const r = await patch(`/api/handoffs/${handoffId}`, incoming, { currentStatus: 'hijack' });
    assert.equal(r.status, 404);
  });

  test('VALIDATE on a mostly-empty draft reports several failing checks', async () => {
    const r = await post(`/api/handoffs/${handoffId}/validate`, owner);
    assert.equal(r.status, 200);
    assert.equal(r.body.validation.ready, false);
    assert.ok(r.body.validation.missingFields.includes('current_status_documented'));
    // pending_actions_listed is already satisfied here by the pre-existing
    // open task (unassignedTask) — "pending actions" doesn't require an
    // explicit items[] entry if there's at least one open task.
    assert.ok(!r.body.validation.missingFields.includes('pending_actions_listed'));
    assert.ok(r.body.validation.missingFields.includes('supporting_links_provided'));
    assert.ok(r.body.validation.missingFields.includes('task_owners_assigned'));
    assert.ok(r.body.validation.missingFields.includes('mandatory_deadlines_present'));
  });

  test('SUBMIT while blocked moves DRAFT -> EDITING, not SUBMITTED', async () => {
    const r = await post(`/api/handoffs/${handoffId}/submit`, owner);
    assert.equal(r.status, 200);
    assert.equal(r.body.validation.ready, false);
    assert.equal(r.body.handoff.state, 'EDITING');
  });

  test('ownership has NOT changed while blocked', async () => {
    const p = await Project.findById(project._id).lean();
    assert.equal(String(p.ownerId), String(owner._id));
  });

  test('a non-waivable check cannot get an exception', async () => {
    const r = await post(`/api/handoffs/${handoffId}/exceptions`, owner, {
      checkName: 'incoming_owner_specified',
      reason: 'please waive',
    });
    assert.equal(r.status, 400);
  });

  test('a waivable, currently-failing check accepts a documented exception', async () => {
    const r = await post(`/api/handoffs/${handoffId}/exceptions`, owner, {
      checkName: 'supporting_links_provided',
      reason: 'Docs will be attached after the migration window',
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.handoff.exceptions.length, 1);
  });

  test('fix the task (assignee + deadline) and the remaining handoff fields', async () => {
    const taskRes = await fetch(`${baseUrl}/api/tasks/${unassignedTask._id}`, {
      method: 'PATCH',
      headers: h(owner),
      body: JSON.stringify({ assignee: String(owner._id), deadline: '2027-01-01T00:00:00.000Z' }),
    });
    assert.equal(taskRes.status, 200);

    const r = await patch(`/api/handoffs/${handoffId}`, owner, {
      currentStatus: 'Migration is 90% complete.',
      noPendingActionsConfirmed: true,
    });
    assert.equal(r.status, 200);
  });

  test('RESUBMIT now succeeds: DRAFT/EDITING -> SUBMITTED, ownership still unchanged', async () => {
    const r = await post(`/api/handoffs/${handoffId}/submit`, owner);
    assert.equal(r.status, 200);
    assert.equal(r.body.validation.ready, true);
    assert.equal(r.body.handoff.state, 'SUBMITTED');

    const p = await Project.findById(project._id).lean();
    assert.equal(String(p.ownerId), String(owner._id), 'ownership must not change until acknowledgement');

    const membership = await ProjectMembership.findOne({ projectId: project._id, userId: incoming._id }).lean();
    assert.ok(membership, 'the recipient should have been added as a member on submit');
  });

  test('wrong actor: the outgoing owner cannot acknowledge their own handoff', async () => {
    const r = await post(`/api/handoffs/${handoffId}/acknowledge`, owner);
    assert.equal(r.status, 403);
  });

  test('wrong actor: the incoming owner cannot cancel the handoff', async () => {
    const r = await post(`/api/handoffs/${handoffId}/cancel`, incoming);
    assert.equal(r.status, 403);
  });

  test('the incoming owner requests clarification', async () => {
    const r = await post(`/api/handoffs/${handoffId}/clarify`, incoming, { note: 'What happened to the index rebuild?' });
    assert.equal(r.status, 200);
    assert.equal(r.body.handoff.state, 'CLARIFICATION_REQUESTED');
    assert.equal(r.body.handoff.clarifications.length, 1);
  });

  test('illegal transition: cannot acknowledge from CLARIFICATION_REQUESTED', async () => {
    const r = await post(`/api/handoffs/${handoffId}/acknowledge`, incoming);
    assert.equal(r.status, 409);
  });

  test('the outgoing owner responds, moving back to EDITING', async () => {
    const r = await post(`/api/handoffs/${handoffId}/respond`, owner, { note: 'It finished at 2am, updating now.' });
    assert.equal(r.status, 200);
    assert.equal(r.body.handoff.state, 'EDITING');
    assert.equal(r.body.handoff.clarifications.length, 2);
  });

  test('RESUBMIT after responding succeeds again', async () => {
    const r = await post(`/api/handoffs/${handoffId}/submit`, owner);
    assert.equal(r.status, 200);
    assert.equal(r.body.handoff.state, 'SUBMITTED');
  });

  test('ACKNOWLEDGE transfers ownership atomically', async () => {
    const r = await post(`/api/handoffs/${handoffId}/acknowledge`, incoming);
    assert.equal(r.status, 200);
    assert.equal(r.body.handoff.state, 'ACKNOWLEDGED');
    assert.equal(r.body.handoff.isOpen, false);

    const p = await Project.findById(project._id).lean();
    assert.equal(String(p.ownerId), String(incoming._id), 'ownership must change after acknowledgement');
    assert.equal(p.ownershipHistory.length, 1);
    assert.equal(String(p.ownershipHistory[0].fromUserId), String(owner._id));
    assert.equal(String(p.ownershipHistory[0].toUserId), String(incoming._id));

    const oldOwnerMembership = await ProjectMembership.findOne({ projectId: project._id, userId: owner._id }).lean();
    const newOwnerMembership = await ProjectMembership.findOne({ projectId: project._id, userId: incoming._id }).lean();
    assert.equal(oldOwnerMembership.role, 'member');
    assert.equal(newOwnerMembership.role, 'owner');
  });

  test('open task assignee is unchanged after acknowledgement', async () => {
    const task = await Task.findById(unassignedTask._id).lean();
    assert.equal(String(task.assignee), String(owner._id));
  });

  test('double-acknowledge is rejected (terminal state)', async () => {
    const r = await post(`/api/handoffs/${handoffId}/acknowledge`, incoming);
    assert.equal(r.status, 409);
  });

  test('GET activity shows the full audit trail for this handoff', async () => {
    const r = await get(`/api/handoffs/${handoffId}/activity`, incoming);
    assert.equal(r.status, 200);
    const actions = r.body.activity.map((e) => e.action);
    for (const expected of [
      'HANDOFF_CREATED',
      'HANDOFF_SUBMIT_BLOCKED',
      'HANDOFF_EXCEPTION_ADDED',
      'HANDOFF_UPDATED',
      'HANDOFF_SUBMITTED',
      'HANDOFF_CLARIFICATION_REQUESTED',
      'HANDOFF_CLARIFICATION_RESPONDED',
      'HANDOFF_ACKNOWLEDGED',
    ]) {
      assert.ok(actions.includes(expected), `expected ${expected} in activity log`);
    }
  });

  test('cancel: the new owner creates and then cancels a handoff', async () => {
    const created = await post(`/api/projects/${project._id}/handoffs`, incoming, { toUserId: String(thirdUser._id) });
    assert.equal(created.status, 201);

    const cancelled = await post(`/api/handoffs/${created.body.handoff.id}/cancel`, incoming);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.handoff.state, 'CANCELLED');
    assert.equal(cancelled.body.handoff.isOpen, false);

    const after = await post(`/api/handoffs/${created.body.handoff.id}/submit`, incoming);
    assert.equal(after.status, 409); // terminal state
  });
});
