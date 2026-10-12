import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDB } from '../../src/db.js';
import { Project } from '../../src/models/Project.js';
import { User } from '../../src/models/User.js';
import { SourceRecord } from '../../src/models/SourceRecord.js';
import { assertItemSourceRecordsBelongToProject, ItemReferenceError } from '../../src/handoffs/itemRefs.js';

// Requires a live MongoDB connection (see MONGODB_URI in .env). Run with
// `npm test` from the Backend directory.
//
// This exercises the guard function in isolation since the handoff
// create/update routes themselves (Step 8) are not built yet; that step
// will call this function when applying item updates.
//
// The connection is closed in the top-level after() below: src/db.js caches
// it for serverless reuse, but an un-closed socket keeps this file's test
// process alive, which hangs `node --test` when multiple files run together.
after(async () => {
  await mongoose.connection.close();
});

describe('assertItemSourceRecordsBelongToProject', () => {
  let user;
  let projectA;
  let projectB;
  let recordInB;

  before(async () => {
    await connectDB();
    user = await User.create({ email: `itemrefs-${Date.now()}@example.com`, name: 'Item Refs Tester' });
    projectA = await Project.create({ name: 'Project A', ownerId: user._id, createdBy: user._id });
    projectB = await Project.create({ name: 'Project B', ownerId: user._id, createdBy: user._id });
    recordInB = await SourceRecord.create({
      projectId: projectB._id,
      provider: 'manual',
      externalId: 'standalone-1',
      type: 'decision',
      title: 'A decision that belongs to Project B',
    });
  });

  after(async () => {
    await SourceRecord.deleteOne({ _id: recordInB._id });
    await Project.deleteMany({ _id: { $in: [projectA._id, projectB._id] } });
    await User.deleteOne({ _id: user._id });
  });

  test('passes when items have no sourceRecordId', async () => {
    await assert.doesNotReject(() =>
      assertItemSourceRecordsBelongToProject(projectA._id, [{ type: 'pending', text: 'no ref here' }])
    );
  });

  test('rejects a sourceRecordId belonging to a different project', async () => {
    await assert.rejects(
      () =>
        assertItemSourceRecordsBelongToProject(projectA._id, [
          { type: 'decision', text: 'References another project', sourceRecordId: recordInB._id },
        ]),
      ItemReferenceError
    );
  });

  test('accepts a sourceRecordId belonging to the same project', async () => {
    const ownRecord = await SourceRecord.create({
      projectId: projectA._id,
      provider: 'manual',
      externalId: 'standalone-2',
      type: 'decision',
      title: 'A decision in Project A',
    });
    await assert.doesNotReject(() =>
      assertItemSourceRecordsBelongToProject(projectA._id, [
        { type: 'decision', text: 'References own project', sourceRecordId: ownRecord._id },
      ])
    );
    await SourceRecord.deleteOne({ _id: ownRecord._id });
  });

  test('rejects a sourceRecordId that does not exist at all', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    await assert.rejects(
      () =>
        assertItemSourceRecordsBelongToProject(projectA._id, [
          { type: 'decision', text: 'Dangling reference', sourceRecordId: fakeId },
        ]),
      ItemReferenceError
    );
  });
});
