import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { app } from '../../src/app.js';
import { User } from '../../src/models/User.js';
import { Project } from '../../src/models/Project.js';
import { ProjectMembership } from '../../src/models/ProjectMembership.js';
import { Task } from '../../src/models/Task.js';
import { Conflict } from '../../src/models/Conflict.js';
import { ConflictEvidence } from '../../src/models/ConflictEvidence.js';
import { signAuthToken } from '../../src/middleware/auth.js';
import { verifyProjectChain } from '../../src/audit/service.js';

/**
 * Full end-to-end "Project Atlas" flow against a real, isolated MongoDB
 * replica set spun up in-memory by mongodb-memory-server (not the shared
 * dev Atlas cluster used by the other integration tests) — chosen
 * specifically as a *replica set* (not a standalone instance) so the
 * acknowledge step's withTx() transaction runs for real, not through the
 * no-replica-set fallback path.
 *
 * Flow covered: blocked by failed checks -> fixed (task owners/deadlines,
 * supporting links) and waived (one check via a documented exception) ->
 * submitted -> clarification requested -> responded -> resubmitted ->
 * acknowledged -> ownership moved -> audit hash chain verifies as valid.
 */

let replSet;
let server;
let baseUrl;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const conn = await mongoose.connect(replSet.getUri());
  // Prime src/db.js's cache so connectDB()/withTx() reuse this connection
  // instead of trying to connect to the real MONGODB_URI from .env.
  // Must mutate the existing object (db.js already captured it by
  // reference when `app.js` imported it above) rather than replace
  // globalThis.__relayMongo outright, or db.js's internal `cache` const
  // keeps pointing at the original, now-stale object.
  Object.assign(globalThis.__relayMongo, { conn, promise: Promise.resolve(conn), txWarned: false });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await replSet.stop();
});

describe('Project Atlas end-to-end flow', () => {
  let alex; // outgoing owner
  let priya; // incoming owner
  let project;
  let unassignedTask;
  let conflict;
  let handoffId;

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

  test('seed-equivalent Atlas demo data is created directly against the isolated DB', async () => {
    alex = await User.create({ email: 'alex@atlas-demo.example', name: 'Alex Morgan (Demo)', passwordHash: 'x' });
    priya = await User.create({ email: 'priya@atlas-demo.example', name: 'Priya Shah (Demo)', passwordHash: 'x' });

    project = await Project.create({
      name: 'Project Atlas',
      description: '(Demo) Payment processing service.',
      ownerId: alex._id,
      createdBy: alex._id,
      isDemo: true,
    });
    await ProjectMembership.create({ projectId: project._id, userId: alex._id, role: 'owner', invitedBy: alex._id });
    await ProjectMembership.create({ projectId: project._id, userId: priya._id, role: 'member', invitedBy: alex._id });

    unassignedTask = await Task.create({
      projectId: project._id,
      title: '(Demo) Investigate duplicate charge reports',
      origin: 'manual',
      priority: 'high',
      createdBy: alex._id,
    });

    conflict = await Conflict.create({
      projectId: project._id,
      fingerprint: 'demo-atlas-deploy-freeze-conflict',
      title: '(Demo) Conflicting deploy-freeze dates',
      severity: 'critical',
      status: 'open',
      createdBy: alex._id,
    });
    await ConflictEvidence.create([
      { conflictId: conflict._id, projectId: project._id, sourceType: 'document', excerpt: '(Demo) Freeze begins March 1.' },
      { conflictId: conflict._id, projectId: project._id, sourceType: 'document', excerpt: '(Demo) Freeze begins March 15.' },
    ]);

    assert.ok(project._id);
  });

  test('BLOCKED: outgoing owner creates a handoff and submit fails validation', async () => {
    const created = await post(`/api/projects/${project._id}/handoffs`, alex, { toUserId: String(priya._id) });
    assert.equal(created.status, 201);
    handoffId = created.body.handoff.id;

    const submitted = await post(`/api/handoffs/${handoffId}/submit`, alex);
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.validation.ready, false);
    assert.equal(submitted.body.handoff.state, 'EDITING');
    assert.ok(submitted.body.validation.missingFields.includes('task_owners_assigned'));
    assert.ok(submitted.body.validation.missingFields.includes('critical_conflicts_reviewed'));
    assert.ok(submitted.body.validation.missingFields.includes('supporting_links_provided'));
  });

  test('FIXED: assign the unassigned, high-priority task and give it a deadline', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${unassignedTask._id}`, {
      method: 'PATCH',
      headers: h(alex),
      body: JSON.stringify({ assignee: String(alex._id), deadline: '2027-01-01T00:00:00.000Z' }),
    });
    assert.equal(res.status, 200);
  });

  test('FIXED: resolve the open critical conflict', async () => {
    const res = await post(`/api/conflicts/${conflict._id}/resolve`, alex, {
      outcome: 'resolved',
      note: '(Demo) Confirmed March 15 is correct; stale doc deleted.',
    });
    assert.equal(res.status, 200);
  });

  test('WAIVED: a documented exception covers supporting_links_provided', async () => {
    const res = await post(`/api/handoffs/${handoffId}/exceptions`, alex, {
      checkName: 'supporting_links_provided',
      reason: '(Demo) Runbook link will be added after the retro.',
    });
    assert.equal(res.status, 201);
  });

  test('FIXED: current status documented and pending actions confirmed', async () => {
    const res = await patch(`/api/handoffs/${handoffId}`, alex, {
      currentStatus: '(Demo) Migration complete except for runbook documentation.',
      noPendingActionsConfirmed: true,
    });
    assert.equal(res.status, 200);
  });

  test('SUBMITTED: resubmit now succeeds', async () => {
    const res = await post(`/api/handoffs/${handoffId}/submit`, alex);
    assert.equal(res.status, 200);
    assert.equal(res.body.validation.ready, true);
    assert.equal(res.body.handoff.state, 'SUBMITTED');
  });

  test('CLARIFICATION: incoming requests it, outgoing responds, resubmits', async () => {
    const clarify = await post(`/api/handoffs/${handoffId}/clarify`, priya, {
      note: '(Demo) Who owns the PCI logging patch now?',
    });
    assert.equal(clarify.status, 200);
    assert.equal(clarify.body.handoff.state, 'CLARIFICATION_REQUESTED');

    const respond = await post(`/api/handoffs/${handoffId}/respond`, alex, {
      note: '(Demo) Reassigned to Alex, deadline added.',
    });
    assert.equal(respond.status, 200);
    assert.equal(respond.body.handoff.state, 'EDITING');

    const resubmit = await post(`/api/handoffs/${handoffId}/submit`, alex);
    assert.equal(resubmit.status, 200);
    assert.equal(resubmit.body.handoff.state, 'SUBMITTED');
  });

  test('ACKNOWLEDGED: ownership moves to Priya atomically', async () => {
    const res = await post(`/api/handoffs/${handoffId}/acknowledge`, priya);
    assert.equal(res.status, 200);
    assert.equal(res.body.handoff.state, 'ACKNOWLEDGED');

    const refreshedProject = await Project.findById(project._id).lean();
    assert.equal(String(refreshedProject.ownerId), String(priya._id));
    assert.equal(refreshedProject.ownershipHistory.length, 1);
    assert.equal(String(refreshedProject.ownershipHistory[0].fromUserId), String(alex._id));
    assert.equal(String(refreshedProject.ownershipHistory[0].toUserId), String(priya._id));

    const alexMembership = await ProjectMembership.findOne({ projectId: project._id, userId: alex._id }).lean();
    const priyaMembership = await ProjectMembership.findOne({ projectId: project._id, userId: priya._id }).lean();
    assert.equal(alexMembership.role, 'member');
    assert.equal(priyaMembership.role, 'owner');
  });

  test('AUDIT: the project hash chain verifies as valid end-to-end', async () => {
    const result = await verifyProjectChain(project._id);
    assert.equal(result.valid, true, `expected a valid chain, got errors: ${JSON.stringify(result.errors)}`);
  });
});
