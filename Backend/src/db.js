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

export async function connectDB() {
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(config.mongodbUri, { maxPoolSize: 10 })
      .then((m) => m);
  }

  cache.conn = await cache.promise;
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
