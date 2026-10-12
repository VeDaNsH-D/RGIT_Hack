import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import { app } from '../../src/app.js';
import { connectDB } from '../../src/db.js';
import { User } from '../../src/models/User.js';
import { Project } from '../../src/models/Project.js';
import { ProjectMembership } from '../../src/models/ProjectMembership.js';
import { Conflict } from '../../src/models/Conflict.js';
import { ConflictEvidence } from '../../src/models/ConflictEvidence.js';
import { NotificationModel } from '../../src/models/Notification.js';
import { signAuthToken } from '../../src/middleware/auth.js';

after(async () => {
  await mongoose.connection.close();
});

describe('conflicts: create/dedupe/review/resolve', () => {
  let server;
  let baseUrl;
  let owner;
  let member;
  let outsider;
  let project;

  before(async () => {
    await connectDB();
    const suffix = Date.now();
    owner = await User.create({ email: `cf-owner-${suffix}@example.com`, name: 'Owner' });
    member = await User.create({ email: `cf-member-${suffix}@example.com`, name: 'Member' });
    outsider = await User.create({ email: `cf-outsider-${suffix}@example.com`, name: 'Outsider' });

    project = await Project.create({ name: 'Conflicts Test', ownerId: owner._id, createdBy: owner._id });
    await ProjectMembership.create({ projectId: project._id, userId: owner._id, role: 'owner', invitedBy: owner._id });
    await ProjectMembership.create({ projectId: project._id, userId: member._id, role: 'member', invitedBy: owner._id });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await ConflictEvidence.deleteMany({ projectId: project._id });
    await Conflict.deleteMany({ projectId: project._id });
    await NotificationModel.deleteMany({ recipientUserId: String(owner._id) });
    await ProjectMembership.deleteMany({ projectId: project._id });
    await Project.deleteOne({ _id: project._id });
    await User.deleteMany({ _id: { $in: [owner._id, member._id, outsider._id] } });
  });

  function h(user) {
    return { Authorization: `Bearer ${signAuthToken(user)}`, 'Content-Type': 'application/json' };
  }

  test('rejects a conflict candidate with fewer than 2 evidence items', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/conflicts`, {
      method: 'POST',
      headers: h(member),
      body: JSON.stringify({
        title: 'Deadline mismatch',
        evidence: [{ sourceType: 'document', excerpt: 'only one' }],
      }),
    });
    assert.equal(res.status, 400);
  });

  test('a non-member cannot create a conflict', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/conflicts`, {
      method: 'POST',
      headers: h(outsider),
      body: JSON.stringify({
        title: 'x',
        evidence: [
          { sourceType: 'document', excerpt: 'a' },
          { sourceType: 'document', excerpt: 'b' },
        ],
      }),
    });
    assert.equal(res.status, 404);
  });

  let conflictId;

  test('a member creates a critical conflict with 2 evidence items and triggers a notification', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/conflicts`, {
      method: 'POST',
      headers: h(member),
      body: JSON.stringify({
        title: 'Conflicting deployment dates',
        description: 'Doc A says March 1, Doc B says March 15',
        severity: 'critical',
        evidence: [
          { sourceType: 'document', excerpt: 'Deploy on March 1' },
          { sourceType: 'document', excerpt: 'Deploy on March 15' },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const parsed = await res.json();
    conflictId = parsed.conflict.id;
    assert.equal(parsed.conflict.severity, 'critical');
    assert.equal(parsed.conflict.evidence.length, 2);
    assert.equal(parsed.deduped, false);

    const notification = await NotificationModel.findOne({ eventId: `conflict-critical-${conflictId}` }).lean();
    assert.ok(notification, 'expected a CRITICAL_CONFLICT_DETECTED notification to be created');
    assert.equal(notification.recipientUserId, String(owner._id));
  });

  test('re-submitting the exact same candidate (same fingerprint) does not create a duplicate', async () => {
    const before = await Conflict.countDocuments({ projectId: project._id });
    const beforeEvidence = await ConflictEvidence.countDocuments({ projectId: project._id });

    const res = await fetch(`${baseUrl}/api/projects/${project._id}/conflicts`, {
      method: 'POST',
      headers: h(member),
      body: JSON.stringify({
        title: 'Conflicting deployment dates',
        description: 'Doc A says March 1, Doc B says March 15',
        severity: 'critical',
        evidence: [
          { sourceType: 'document', excerpt: 'Deploy on March 1' },
          { sourceType: 'document', excerpt: 'Deploy on March 15' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const parsed = await res.json();
    assert.equal(parsed.deduped, true);
    assert.equal(parsed.conflict.id, conflictId);

    const after = await Conflict.countDocuments({ projectId: project._id });
    const afterEvidence = await ConflictEvidence.countDocuments({ projectId: project._id });
    assert.equal(after, before);
    assert.equal(afterEvidence, beforeEvidence);
  });

  test('a non-critical conflict does not trigger a notification', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/conflicts`, {
      method: 'POST',
      headers: h(member),
      body: JSON.stringify({
        title: 'Minor formatting discrepancy',
        severity: 'low',
        evidence: [
          { sourceType: 'document', excerpt: 'uses tabs' },
          { sourceType: 'document', excerpt: 'uses spaces' },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    const notification = await NotificationModel.findOne({ eventId: `conflict-critical-${body.conflict.id}` }).lean();
    assert.equal(notification, null);
  });

  test('GET lists conflicts with their evidence', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/conflicts`, { headers: h(owner) });
    assert.equal(res.status, 200);
    const body = await res.json();
    const found = body.conflicts.find((c) => c.id === conflictId);
    assert.ok(found);
    assert.equal(found.evidence.length, 2);
  });

  test('GET conflicts is 404 for a non-member', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/conflicts`, { headers: h(outsider) });
    assert.equal(res.status, 404);
  });

  test('GET conflicts filters by a valid status and rejects an invalid one', async () => {
    const valid = await fetch(`${baseUrl}/api/projects/${project._id}/conflicts?status=open`, { headers: h(owner) });
    assert.equal(valid.status, 200);
    const validBody = await valid.json();
    assert.ok(validBody.conflicts.every((c) => c.status === 'open'));

    const invalid = await fetch(`${baseUrl}/api/projects/${project._id}/conflicts?status=not-a-status`, {
      headers: h(owner),
    });
    assert.equal(invalid.status, 400);
  });

  test('review marks the conflict reviewed, and a second review is rejected', async () => {
    const res1 = await fetch(`${baseUrl}/api/conflicts/${conflictId}/review`, { method: 'POST', headers: h(owner) });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.conflict.status, 'reviewed');

    const res2 = await fetch(`${baseUrl}/api/conflicts/${conflictId}/review`, { method: 'POST', headers: h(owner) });
    assert.equal(res2.status, 409);
  });

  test('resolve requires a note', async () => {
    const res = await fetch(`${baseUrl}/api/conflicts/${conflictId}/resolve`, {
      method: 'POST',
      headers: h(owner),
      body: JSON.stringify({ outcome: 'resolved', note: '' }),
    });
    assert.equal(res.status, 400);
  });

  test('resolve succeeds with outcome + note, and a second resolve is rejected', async () => {
    const res1 = await fetch(`${baseUrl}/api/conflicts/${conflictId}/resolve`, {
      method: 'POST',
      headers: h(owner),
      body: JSON.stringify({ outcome: 'resolved', note: 'Confirmed March 15 is correct; Doc A is stale.' }),
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.conflict.status, 'resolved');
    assert.equal(body1.conflict.resolvedBy, String(owner._id));

    const res2 = await fetch(`${baseUrl}/api/conflicts/${conflictId}/resolve`, {
      method: 'POST',
      headers: h(owner),
      body: JSON.stringify({ outcome: 'dismissed', note: 'too late' }),
    });
    assert.equal(res2.status, 409);
  });
});
