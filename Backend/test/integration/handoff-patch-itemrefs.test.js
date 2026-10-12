import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import { app } from '../../src/app.js';
import { connectDB } from '../../src/db.js';
import { User } from '../../src/models/User.js';
import { Project } from '../../src/models/Project.js';
import { ProjectMembership } from '../../src/models/ProjectMembership.js';
import { Handoff } from '../../src/models/Handoff.js';
import { SourceRecord } from '../../src/models/SourceRecord.js';
import { signAuthToken } from '../../src/middleware/auth.js';

after(async () => {
  await mongoose.connection.close();
});

describe('PATCH /api/handoffs/:id rejects an item.sourceRecordId from another project', () => {
  let server;
  let baseUrl;
  let owner;
  let incoming;
  let projectA;
  let projectB;
  let foreignRecord;
  let handoffId;

  before(async () => {
    await connectDB();
    const suffix = Date.now();
    owner = await User.create({ email: `hpi-owner-${suffix}@example.com`, name: 'Owner' });
    incoming = await User.create({ email: `hpi-incoming-${suffix}@example.com`, name: 'Incoming' });

    projectA = await Project.create({ name: 'Project A', ownerId: owner._id, createdBy: owner._id });
    projectB = await Project.create({ name: 'Project B', ownerId: owner._id, createdBy: owner._id });
    await ProjectMembership.create({ projectId: projectA._id, userId: owner._id, role: 'owner', invitedBy: owner._id });

    foreignRecord = await SourceRecord.create({
      projectId: projectB._id,
      provider: 'manual',
      externalId: 'standalone-x',
      type: 'decision',
      title: 'Belongs to Project B',
    });

    const handoff = await Handoff.create({
      projectId: projectA._id,
      fromUserId: owner._id,
      toUserId: incoming._id,
      state: 'DRAFT',
      isOpen: true,
    });
    handoffId = handoff._id;

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Handoff.deleteOne({ _id: handoffId });
    await SourceRecord.deleteOne({ _id: foreignRecord._id });
    await ProjectMembership.deleteMany({ projectId: { $in: [projectA._id, projectB._id] } });
    await Project.deleteMany({ _id: { $in: [projectA._id, projectB._id] } });
    await User.deleteMany({ _id: { $in: [owner._id, incoming._id] } });
  });

  test('rejects with 400 when an item references a SourceRecord from a different project', async () => {
    const res = await fetch(`${baseUrl}/api/handoffs/${handoffId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${signAuthToken(owner)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ type: 'decision', text: 'Cross-project ref', sourceRecordId: String(foreignRecord._id) }],
      }),
    });
    assert.equal(res.status, 400);
  });

  test('accepts an item referencing a SourceRecord in the same project', async () => {
    const ownRecord = await SourceRecord.create({
      projectId: projectA._id,
      provider: 'manual',
      externalId: 'standalone-y',
      type: 'decision',
      title: 'Belongs to Project A',
    });

    const res = await fetch(`${baseUrl}/api/handoffs/${handoffId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${signAuthToken(owner)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ type: 'decision', text: 'Same-project ref', sourceRecordId: String(ownRecord._id) }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.handoff.items[0].sourceRecordId, String(ownRecord._id));

    await SourceRecord.deleteOne({ _id: ownRecord._id });
  });
});
