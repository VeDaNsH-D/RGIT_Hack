import { app } from '../src/app.js';
import { connectDB } from '../src/db.js';

/**
 * Vercel serverless entrypoint. The connection is cached across warm
 * invocations by src/db.js, so this only pays the connect cost on cold
 * starts. Must not rely on any in-memory state surviving between
 * invocations beyond that cache.
 */
export default async function handler(req, res) {
  await connectDB();
  return app(req, res);
}
