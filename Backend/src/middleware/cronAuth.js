import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Protects /api/cron/* routes with a shared secret (Authorization: Bearer
 * CRON_SECRET), compared in constant time to avoid leaking the secret via
 * a timing side-channel. config.js already fails the whole app fast at
 * boot if CRON_SECRET is unset, but this is checked defensively anyway so
 * this middleware never has a path that compares against an empty secret.
 */
export function requireCronAuth(req, res, next) {
  if (!config.cronSecret) {
    return res.status(500).json({ error: 'server_misconfigured', message: 'CRON_SECRET is not configured' });
  }

  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing bearer token' });
  }

  const expected = Buffer.from(config.cronSecret);
  const provided = Buffer.from(token);
  const valid = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  if (!valid) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid cron secret' });
  }

  next();
}
