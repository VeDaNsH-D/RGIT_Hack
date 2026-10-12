import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { app } from '../../src/app.js';
import { connectDB } from '../../src/db.js';
import { config } from '../../src/config.js';
import { User } from '../../src/models/User.js';
import { Project } from '../../src/models/Project.js';
import { ProjectMembership } from '../../src/models/ProjectMembership.js';
import { signAuthToken } from '../../src/middleware/auth.js';

// Requires a live MongoDB connection (see MONGODB_URI in .env). Run with
// `npm test` from the Backend directory.
after(async () => {
  await mongoose.connection.close();
});

describe('access control: unauthenticated / wrong-role / non-member', () => {
  let server;
  let baseUrl;
  let owner;
  let member;
  let outsider;
  let project;

  before(async () => {
    await connectDB();
    const suffix = Date.now();
    owner = await User.create({ email: `ac-owner-${suffix}@example.com`, name: 'Owner' });
    member = await User.create({ email: `ac-member-${suffix}@example.com`, name: 'Member' });
    outsider = await User.create({ email: `ac-outsider-${suffix}@example.com`, name: 'Outsider' });

    project = await Project.create({ name: 'Access Control Test', ownerId: owner._id, createdBy: owner._id });
    await ProjectMembership.create({ projectId: project._id, userId: owner._id, role: 'owner', invitedBy: owner._id });
    await ProjectMembership.create({ projectId: project._id, userId: member._id, role: 'member', invitedBy: owner._id });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await ProjectMembership.deleteMany({ projectId: project._id });
    await Project.deleteOne({ _id: project._id });
    await User.deleteMany({ _id: { $in: [owner._id, member._id, outsider._id] } });
  });

  test('unauthenticated request (no token) is rejected with 401', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/context`);
    assert.equal(res.status, 401);
  });

  test('a valid-looking but garbage token is rejected with 401', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/context`, {
      headers: { Authorization: 'Bearer not.a.valid.jwt' },
    });
    assert.equal(res.status, 401);
  });

  test('a member (not owner) is rejected 403 adding a member', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signAuthToken(member)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'someone@example.com', role: 'viewer' }),
    });
    assert.equal(res.status, 403);
  });

  test('the owner CAN add a member', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signAuthToken(owner)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: outsider.email, role: 'viewer' }),
    });
    assert.equal(res.status, 201);
    await ProjectMembership.deleteOne({ projectId: project._id, userId: outsider._id });
  });

  test('a non-member gets 404 (not 403) on the context endpoint', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${project._id}/context`, {
      headers: { Authorization: `Bearer ${signAuthToken(outsider)}` },
    });
    assert.equal(res.status, 404);
  });

  test('a disabled user is rejected even with a previously-valid token', async () => {
    const disabledUser = await User.create({ email: `ac-disabled-${Date.now()}@example.com`, name: 'Disabled', disabled: true });
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${signAuthToken(disabledUser)}` },
    });
    assert.equal(res.status, 401);
    await User.deleteOne({ _id: disabledUser._id });
  });

  describe('OAuth routing (providers disabled in this env: no client id/secret)', () => {
    let originalGoogleEnabled;
    before(() => {
      originalGoogleEnabled = config.oauth.google.enabled;
      config.oauth.google.enabled = false;
    });
    after(() => {
      config.oauth.google.enabled = originalGoogleEnabled;
    });

    test('disabled provider (no client id/secret configured) returns 404', async () => {
      const res = await fetch(`${baseUrl}/api/auth/oauth/google`, { redirect: 'manual' });
      assert.equal(res.status, 404);
    });

    test('unknown provider name returns 404', async () => {
      const res = await fetch(`${baseUrl}/api/auth/oauth/facebook`, { redirect: 'manual' });
      assert.equal(res.status, 404);
    });
  });

  describe('OAuth state tampering (provider force-enabled in-process for this block, no real network calls made)', () => {
    before(() => {
      config.oauth.github.enabled = true;
    });
    after(() => {
      config.oauth.github.enabled = false;
    });

    test('a garbage (unparseable) state is rejected with 401, not passed through to the provider', async () => {
      const res = await fetch(`${baseUrl}/api/auth/oauth/github/callback?code=abc&state=garbage`, {
        redirect: 'manual',
      });
      assert.equal(res.status, 401);
    });

    test('a state signed for a different provider is rejected with 401', async () => {
      const crossState = jwt.sign({ provider: 'google' }, config.jwtSecret, { expiresIn: '5m' });
      const res = await fetch(`${baseUrl}/api/auth/oauth/github/callback?code=abc&state=${crossState}`, {
        redirect: 'manual',
      });
      assert.equal(res.status, 401);
    });

    test('an expired state is rejected with 401', async () => {
      const expiredState = jwt.sign({ provider: 'github' }, config.jwtSecret, { expiresIn: '-1s' });
      const res = await fetch(`${baseUrl}/api/auth/oauth/github/callback?code=abc&state=${expiredState}`, {
        redirect: 'manual',
      });
      assert.equal(res.status, 401);
    });

    test('a state signed with a different secret is rejected with 401', async () => {
      const forgedState = jwt.sign({ provider: 'github' }, 'a-completely-different-secret-value-xx', {
        expiresIn: '5m',
      });
      const res = await fetch(`${baseUrl}/api/auth/oauth/github/callback?code=abc&state=${forgedState}`, {
        redirect: 'manual',
      });
      assert.equal(res.status, 401);
    });

    test('missing state or code is rejected with 400, before any state check', async () => {
      const res = await fetch(`${baseUrl}/api/auth/oauth/github/callback?code=abc`, { redirect: 'manual' });
      assert.equal(res.status, 400);
    });
  });
});
