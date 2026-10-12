import mongoose from 'mongoose';
import { config } from './config.js';

/**
 * Serverless functions can be invoked many times against the same warm
 * process, so the connection (and the "are transactions supported" check)
 * must be cached on globalThis rather than module-local state, which can be
 * re-initialized per bundle in some serverless runtimes.
 */
const cache = globalThis.__relayMongo || { conn: null, promise: null, txWarned: false };
globalThis.__relayMongo = cache;

/**
 * Validates that the MongoDB URI target is an isolated test database.
 * Throws immediately if pointing to Atlas/production or if the database name
 * does not end in "_test".
 */
export function assertTestDatabase(uri, options = {}) {
  if (!uri || typeof uri !== 'string') {
    throw new Error('Refusing to connect: MONGODB_URI is empty or invalid.');
  }

  const lower = uri.toLowerCase();
  if (
    lower.includes('mongodb.net') ||
    lower.includes('atlas') ||
    lower.includes('rgit_hack')
  ) {
    throw new Error(
      'Refusing to connect: Automated tests must never connect to a remote or production database.'
    );
  }

  let dbName = options?.dbName || '';
  if (!dbName) {
    try {
      const parsed = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
      dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
    } catch {
      const match = uri.match(/\/([^/?]+)(\?|$)/);
      if (match) dbName = match[1];
    }
  }

  if (!dbName || !dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to connect: Test database name must end in "_test" (got "${dbName || 'none'}").`
    );
  }
}

export async function connectDB(options = {}) {
  const isTest = (process.env.NODE_ENV || config.nodeEnv) === 'test' ||
                 process.execArgv.includes('--test') ||
                 process.argv.includes('--test');

  const targetUri = isTest && (process.env.MONGODB_URI_TEST || config.mongodbUriTest)
    ? (process.env.MONGODB_URI_TEST || config.mongodbUriTest)
    : (process.env.MONGODB_URI || config.mongodbUri);

  if (cache.conn && mongoose.connection.readyState === 1) {
    return cache.conn;
  }

  if (cache.promise && mongoose.connection.readyState === 2) {
    cache.conn = await cache.promise;
    return cache.conn;
  }

  cache.conn = null;
  cache.promise = null;

  if (isTest) {
    assertTestDatabase(targetUri, options);
  }

  cache.promise = mongoose
    .connect(targetUri, { maxPoolSize: 10, ...options })
    .then((m) => m);

  cache.conn = await cache.promise;

  if (isTest) {
    const connectedName = mongoose.connection.name || '';
    if (!connectedName.endsWith('_test')) {
      throw new Error(
        `Refusing to connect: Connected database name must end in "_test" (got "${connectedName}").`
      );
    }
  }

  return cache.conn;
}

/**
 * Runs `fn` inside a MongoDB transaction. Standalone MongoDB instances
 * (e.g. a local dev `mongod` with no replica set) do not support
 * transactions; in that case we log a warning once and run `fn` without a
 * session so local development still works, at the cost of atomicity.
 */
export async function withTx(fn) {
  const conn = await connectDB();
  const session = await conn.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } catch (err) {
      const unsupported =
        err?.code === 20 ||
        /Transaction numbers are only allowed|replica set|not supported/i.test(err?.message || '');
      if (!unsupported) throw err;

      if (!cache.txWarned) {
        cache.txWarned = true;
        // eslint-disable-next-line no-console
        console.warn(
          '[db] MongoDB transactions are not supported by this deployment (no replica set). ' +
            'Falling back to a non-atomic execution path. Use a MongoDB Atlas replica set in production.'
        );
      }
      return await fn(null);
    }
  } finally {
    await session.endSession();
  }
}
