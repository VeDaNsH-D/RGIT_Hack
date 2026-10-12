import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { app } from '../../src/app.js';
import { connectDB } from '../../src/db.js';
import { User } from '../../src/models/User.js';
import { Project } from '../../src/models/Project.js';
import { ProjectMembership } from '../../src/models/ProjectMembership.js';
import { SourceRecord } from '../../src/models/SourceRecord.js';
import { signAuthToken } from '../../src/middleware/auth.js';

// Requires a live MongoDB connection (see MONGODB_URI in .env). Run with
// `npm test` from the Backend directory.
//
// The connection is closed in the top-level after() below: src/db.js caches
// it for serverless reuse, but an un-closed socket keeps this file's test
// process alive, which hangs `node --test` when multiple files run together.
after(async () => {
  await mongoose.connection.close();
});

describe('notes routes + context endpoint', () => {
  let server;
  let baseUrl;
  let owner;
  let member;
  let outsider;
  let project;
  let otherProject;
  let foreignNote;

  before(async () => {
    await connectDB();

    const suffix = Date.now();
    owner = await User.create({
      email: `owner-${suffix}@example.com`,
      name: 'Owner User',
      passwordHash: await bcrypt.hash('password123', 4),
    });
    member = await User.create({
      email: `member-${suffix}@example.com`,
      name: 'Member User',
      passwordHash: await bcrypt.hash('password123', 4),
    });
    outsider = await User.create({
      email: `outsider-${suffix}@example.com`,
      name: 'Outsider User',
      passwordHash: await bcrypt.hash('password123', 4),
    });

    project = await Project.create({ name: 'Notes Test Project', ownerId: owner._id, createdBy: owner._id });
    await ProjectMembership.create({ projectId: project._id, userId: owner._id, role: 'owner', invitedBy: owner._id });
    await ProjectMembership.create({ projectId: project._id, userId: member._id, role: 'member', invitedBy: owner._id });

    otherProject = await Project.create({ name: 'Other Project', ownerId: owner._id, createdBy: owner._id });
    foreignNote = await SourceRecord.create({
      projectId: otherProject._id,
      provider: 'github',
      externalId: 'pr-1',
      type: 'pull_request',
      title: 'Not a manual note',
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await SourceRecord.deleteMany({ projectId: { $in: [project._id, otherProject._id] } });
    await ProjectMembership.deleteMany({ projectId: { $in: [project._id, otherProject._id] } });
    await Project.deleteMany({ _id: { $in: [project._id, otherProject._id] } });
    await User.deleteMany({ _id: { $in: [owner._id, member._id, outsider._id] } });
  });

  function authHeaders(user) {
    return { Authorization: `Bearer ${signAuthToken(user)}`, 'Content-Type': 'application/json' };
  }

  let decisionId;

  test('member can create a decision note', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/notes`, {
      method: 'POST',
      headers: authHeaders(member),
      body: JSON.stringify({
        recordType: 'decision',
        title: 'Adopt the new migration plan',
        content: 'Chosen because it avoids downtime.',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.note.recordType, 'decision');
    assert.equal(body.note.author, member.name);
    decisionId = body.note.id;
  });

  test('member can create a note (non-decision)', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/notes`, {
      method: 'POST',
      headers: authHeaders(owner),
      body: JSON.stringify({ recordType: 'note', title: 'Status check-in' }),
    });
    assert.equal(res.status, 201);
  });

  test('list filters by recordType', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/notes?recordType=decision`, {
      headers: authHeaders(owner),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.notes.every((n) => n.recordType === 'decision'));
    assert.ok(body.notes.some((n) => n.id === decisionId));
  });

  test('non-member gets 404 (not 403) listing notes', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/notes`, { headers: authHeaders(outsider) });
    assert.equal(res.status, 404);
  });

  test('a different member (not the author, not the owner) cannot edit the note', async () => {
    // member authored decisionId; have a second real member try to edit it.
    const secondMember = await User.create({
      email: `second-member-${Date.now()}@example.com`,
      name: 'Second Member',
      passwordHash: await bcrypt.hash('password123', 4),
    });
    await ProjectMembership.create({
      projectId: project._id,
      userId: secondMember._id,
      role: 'member',
      invitedBy: owner._id,
    });

    const res = await fetch(`${baseUrl}/api/notes/${decisionId}`, {
      method: 'PATCH',
      headers: authHeaders(secondMember),
      body: JSON.stringify({ title: 'Hijacked title' }),
    });
    assert.equal(res.status, 403);

    await ProjectMembership.deleteOne({ projectId: project._id, userId: secondMember._id });
    await User.deleteOne({ _id: secondMember._id });
  });

  test('the owner (not the author) CAN edit the note', async () => {
    const res = await fetch(`${baseUrl}/api/notes/${decisionId}`, {
      method: 'PATCH',
      headers: authHeaders(owner),
      body: JSON.stringify({ title: 'Owner-edited title' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.note.title, 'Owner-edited title');
  });

  test('the original author CAN edit their own note', async () => {
    const res = await fetch(`${baseUrl}/api/notes/${decisionId}`, {
      method: 'PATCH',
      headers: authHeaders(member),
      body: JSON.stringify({ content: 'Updated rationale.' }),
    });
    assert.equal(res.status, 200);
  });

  test('PATCH on a non-manual SourceRecord returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/notes/${foreignNote._id}`, {
      method: 'PATCH',
      headers: authHeaders(owner),
      body: JSON.stringify({ title: 'Should not work' }),
    });
    assert.equal(res.status, 404);
  });

  test('context endpoint includes decisions (with content) and notes (without content)', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/context`, { headers: authHeaders(owner) });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(Array.isArray(body.decisions));
    assert.ok(Array.isArray(body.notes));
    const decision = body.decisions.find((d) => d.id === decisionId);
    assert.ok(decision, 'expected the created decision in context.decisions');
    assert.equal(typeof decision.content, 'string');

    const note = body.notes[0];
    assert.equal(note.content, undefined, 'notes in context should not include content');
  });

  test('author can delete their own note', async () => {
    const res = await fetch(`${baseUrl}/api/notes/${decisionId}`, {
      method: 'DELETE',
      headers: authHeaders(member),
    });
    assert.equal(res.status, 204);

    const check = await fetch(`${baseUrl}/api/notes/${decisionId}`, {
      method: 'PATCH',
      headers: authHeaders(member),
      body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(check.status, 404);
  });
});
