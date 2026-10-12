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
import { SourceRecord } from '../../src/models/SourceRecord.js';
import { signAuthToken } from '../../src/middleware/auth.js';

// Requires a live MongoDB connection (see MONGODB_URI in .env). Run with
// `npm test` from the Backend directory.
after(async () => {
  await mongoose.connection.close();
});

describe('projects: GET/PATCH /:id, ownership-history, source-records', () => {
  let server;
  let baseUrl;
  let owner;
  let member;
  let outsider;
  let project;

  before(async () => {
    await connectDB();
    const suffix = Date.now();
    owner = await User.create({ email: `pt-owner-${suffix}@example.com`, name: 'Owner' });
    member = await User.create({ email: `pt-member-${suffix}@example.com`, name: 'Member' });
    outsider = await User.create({ email: `pt-outsider-${suffix}@example.com`, name: 'Outsider' });

    project = await Project.create({
      name: 'Projects+Tasks Test',
      ownerId: owner._id,
      createdBy: owner._id,
      ownershipHistory: [
        {
          fromUserId: outsider._id, // arbitrary prior owner for history test
          toUserId: owner._id,
          handoffId: new mongoose.Types.ObjectId(),
          changedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });
    await ProjectMembership.create({ projectId: project._id, userId: owner._id, role: 'owner', invitedBy: owner._id });
    await ProjectMembership.create({ projectId: project._id, userId: member._id, role: 'member', invitedBy: owner._id });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Task.deleteMany({ projectId: project._id });
    await SourceRecord.deleteMany({ projectId: project._id });
    await ProjectMembership.deleteMany({ projectId: project._id });
    await Project.deleteOne({ _id: project._id });
    await User.deleteMany({ _id: { $in: [owner._id, member._id, outsider._id] } });
  });

  function authHeaders(user) {
    return { Authorization: `Bearer ${signAuthToken(user)}`, 'Content-Type': 'application/json' };
  }

  test('GET /:id returns the project for a member', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}`, { headers: authHeaders(member) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.project.name, 'Projects+Tasks Test');
  });

  test('GET /:id returns 404 for a non-member', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}`, { headers: authHeaders(outsider) });
    assert.equal(res.status, 404);
  });

  test('PATCH /:id is rejected for a member (owner-only)', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}`, {
      method: 'PATCH',
      headers: authHeaders(member),
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    assert.equal(res.status, 403);
  });

  test('PATCH /:id succeeds for the owner', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}`, {
      method: 'PATCH',
      headers: authHeaders(owner),
      body: JSON.stringify({ description: 'Updated description' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.project.description, 'Updated description');
  });

  test('PATCH /:id rejects an empty body', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}`, {
      method: 'PATCH',
      headers: authHeaders(owner),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test('GET /:id/ownership-history returns resolved user info', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/ownership-history`, {
      headers: authHeaders(member),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ownershipHistory.length, 1);
    assert.equal(body.ownershipHistory[0].toUser.id, String(owner._id));
    assert.equal(body.ownershipHistory[0].toUser.name, owner.name);
  });

  let taskId;

  test('POST /:id/tasks creates a manual task', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/tasks`, {
      method: 'POST',
      headers: authHeaders(member),
      body: JSON.stringify({ title: 'Migrate the DB', priority: 'high' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.task.origin, 'manual');
    assert.equal(body.task.status, 'open');
    taskId = body.task.id;
  });

  test('POST /:id/tasks rejects an assignee who is not a project member', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/tasks`, {
      method: 'POST',
      headers: authHeaders(member),
      body: JSON.stringify({ title: 'Bad assignee', assignee: String(outsider._id) }),
    });
    assert.equal(res.status, 400);
  });

  test('GET /:id/tasks lists tasks and filters by status', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/tasks?status=open`, {
      headers: authHeaders(owner),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.tasks.some((t) => t.id === taskId));
    assert.ok(body.tasks.every((t) => t.status === 'open'));
  });

  test('GET /:id/tasks?overdue=true excludes a task with no deadline', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/tasks?overdue=true`, {
      headers: authHeaders(owner),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(!body.tasks.some((t) => t.id === taskId));
  });

  test('PATCH /tasks/:id completing a task sets completedAt', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: authHeaders(member),
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.task.status, 'completed');
    assert.ok(body.task.completedAt);
  });

  test('PATCH /tasks/:id reopening clears completedAt', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: authHeaders(member),
      body: JSON.stringify({ status: 'open' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.task.completedAt, null);
  });

  test('PATCH /tasks/:id for a non-member is 404', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: authHeaders(outsider),
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(res.status, 404);
  });

  test('GET /:id/source-records returns metadata and full content, member+', async () => {
    const record = await SourceRecord.create({
      projectId: project._id,
      provider: 'github',
      externalId: 'pr-99',
      type: 'pull_request',
      title: 'Add retry logic',
      content: 'Full PR body content here',
    });

    const res = await fetch(`${baseUrl}/api/projects/${project._id}/source-records?provider=github`, {
      headers: authHeaders(member),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const found = body.sourceRecords.find((r) => r.id === String(record._id));
    assert.ok(found);
    assert.equal(found.content, 'Full PR body content here');
  });

  test('GET /:id/source-records is 404 for a non-member', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/source-records`, {
      headers: authHeaders(outsider),
    });
    assert.equal(res.status, 404);
  });
});
