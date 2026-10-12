import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDB } from '../../src/db.js';
import { User } from '../../src/models/User.js';
import { recordSuccessfulLogin } from '../../src/routes/auth.js';
import { listActivity } from '../../src/audit/service.js';

// Requires a live MongoDB connection (see MONGODB_URI in .env). Run with
// `npm test` from the Backend directory.
//
// The connection is closed in the top-level after() below: src/db.js caches
// it for serverless reuse, but an un-closed socket keeps this file's test
// process alive, which hangs `node --test` when multiple files run together.
after(async () => {
  await mongoose.connection.close();
});

describe('login side effects (lastLoginAt + audit)', () => {
  let user;

  before(async () => {
    await connectDB();
    user = await User.create({
      email: `login-test-${Date.now()}@example.com`,
      name: 'Login Test',
      passwordHash: 'not-a-real-hash',
    });
  });

  after(async () => {
    await User.deleteOne({ _id: user._id });
  });

  test('a successful login updates lastLoginAt and writes a system USER_LOGIN event', async () => {
    const before = await User.findById(user._id);
    assert.equal(before.lastLoginAt, null);

    await recordSuccessfulLogin(user, 'password');

    const after = await User.findById(user._id);
    assert.ok(after.lastLoginAt instanceof Date);

    const events = await listActivity('system', { limit: 1000 });
    const mine = events.filter(
      (e) => e.actorId && String(e.actorId) === String(user._id) && e.action === 'USER_LOGIN'
    );
    assert.ok(mine.length >= 1, 'expected at least one USER_LOGIN event for this user');
    assert.equal(mine[mine.length - 1].payload.method, 'password');
    assert.equal(mine[mine.length - 1].projectId, null);
  });

  test('a failing lastLoginAt update does not block login or throw', async () => {
    const originalUpdateOne = User.updateOne.bind(User);
    User.updateOne = () => {
      throw new Error('simulated DB failure');
    };

    try {
      await assert.doesNotReject(() => recordSuccessfulLogin(user, 'password'));
    } finally {
      User.updateOne = originalUpdateOne;
    }

    // The audit event should still have been written despite the failure.
    const events = await listActivity('system', { limit: 1000 });
    const mine = events.filter(
      (e) => e.actorId && String(e.actorId) === String(user._id) && e.action === 'USER_LOGIN'
    );
    assert.ok(mine.length >= 2, 'expected the login to still be audited after the simulated failure');
  });
});
