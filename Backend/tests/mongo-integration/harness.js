/**
 * Disposable-MongoDB harness for the integration suite (`npm run test:integration`).
 *
 * - Starts an in-process mongod via mongodb-memory-server on an ephemeral port.
 * - The database name must end in "_test"; anything else is refused.
 * - It NEVER reads MONGODB_URI / MONGODB_URI_TEST, so dev/production data can't be touched.
 * - If the binary cannot be downloaded or started, startup THROWS so the tests fail
 *   loudly. Nothing here skips tests, so a missing mongod can never count as a pass.
 */

import mongoose from 'mongoose';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_DB_NAME = 'relay_ingest_test';

// config.js validates these at import time; the app under test uses test-only values.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/never_used_test';
process.env.JWT_SECRET = 'integration-test-jwt-secret-at-least-32-chars';
process.env.CRON_SECRET = 'integration-test-cron-secret';
process.env.NODE_ENV = 'test';
// Uploads in the real app write here (removed in stopMongo), never to a shared directory.
export const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-itest-docs-'));
process.env.DOCUMENT_STORAGE_DIR = STORAGE_DIR;

export function assertTestDatabase(name) {
  if (typeof name !== 'string' || !name.endsWith('_test')) {
    throw new Error(`Refusing to connect: database name must end in "_test" (got "${String(name).slice(0, 40)}").`);
  }
}

let server = null;

export async function startMongo() {
  assertTestDatabase(TEST_DB_NAME);
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = await import('mongodb-memory-server'));
    server = await MongoMemoryServer.create({ instance: { dbName: TEST_DB_NAME } });
  } catch (err) {
    throw new Error(
      `Integration tests need a MongoDB binary and could not start one (${err.message}). `
      + 'mongodb-memory-server downloads mongod on first use; check network access or its cache. '
      + 'These tests are NOT skipped and will not be reported as passing.',
    );
  }
  const uri = server.getUri(TEST_DB_NAME);
  process.env.MONGODB_URI = uri;
  try {
    const { config } = await import('../../src/config.js');
    if (config) config.mongodbUri = uri;
  } catch { /* config not yet loaded */ }
  const conn = await mongoose.connect(uri, { dbName: TEST_DB_NAME });
  assertTestDatabase(mongoose.connection.name);
  if (globalThis.__relayMongo) {
    Object.assign(globalThis.__relayMongo, { conn, promise: Promise.resolve(conn), txWarned: false });
  }
  await import('../../src/models/index.js');
  // Build the indexes declared by the canonical schemas (no schema changes).
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  return mongoose.connection;
}

export async function resetCollections() {
  assertTestDatabase(mongoose.connection.name);
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
}

export async function stopMongo() {
  try {
    if (globalThis.__relayMongo) {
      Object.assign(globalThis.__relayMongo, { conn: null, promise: null });
    }
    await mongoose.disconnect();
  } finally {
    if (server) await server.stop({ doCleanup: true, force: true });
    server = null;
    fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
  }
}
