import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import { app } from '../../src/app.js';
import { connectDB } from '../../src/db.js';
import { User } from '../../src/models/User.js';
import { signAuthToken } from '../../src/middleware/auth.js';

// Requires a live MongoDB connection (see MONGODB_URI in .env). Run with
// `npm test` from the Backend directory.
//
// Regression test: a malformed :id (not a 24-char hex ObjectId) used to
// make Mongoose throw a CastError, which the generic error handler turned
// into a bare 500 instead of a clean "not found". Every attach*Context
// middleware in src/middleware/access.js now rejects it before querying.
after(async () => {
  await mongoose.connection.close();
});

describe('malformed :id route params are treated as not-found, not a 500', () => {
  let server;
  let baseUrl;
  let user;

  before(async () => {
    await connectDB();
    user = await User.create({ email: `malformed-id-${Date.now()}@example.com`, name: 'Tester' });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await User.deleteOne({ _id: user._id });
  });

  function headers() {
    return { Authorization: `Bearer ${signAuthToken(user)}` };
  }

  // Each uses a method that entity actually supports by id, so the request
  // reaches the relevant attach*Context middleware rather than bouncing
  // off the 404-route-not-found catch-all for an unsupported method.
  const cases = [
    { method: 'GET', path: '/api/projects/not-a-valid-id' },
    { method: 'PATCH', path: '/api/notes/not-a-valid-id' },
    { method: 'PATCH', path: '/api/tasks/not-a-valid-id' },
    { method: 'GET', path: '/api/handoffs/not-a-valid-id' },
    { method: 'POST', path: '/api/conflicts/not-a-valid-id/review' },
  ];

  for (const { method, path } of cases) {
    test(`${method} ${path} returns 404, not 500`, async () => {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({}),
      });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, 'not_found');
    });
  }
});
