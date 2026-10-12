import { Router } from 'express';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { ConnectError, completeInstall, consumeState, createInstallUrl, getStatus } from '../services/githubConnectionService.js';

/**
 * Workspace = the authenticated Relay user's own workspace (there is no Workspace model).
 *   GET  /api/connections/github            -> safe connection status
 *   POST /api/connections/github/install    -> { url } to start the GitHub App install
 *   GET  /api/connections/github/callback   -> GitHub "Setup URL"; redirects to the frontend
 */
const router = Router();

function needUser(req, res, next) {
  if (!mongoose.isValidObjectId(req.user?.id)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid session' });
  }
  next();
}

router.get('/github', requireAuth, needUser, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json(await getStatus(req.user.id));
  } catch (err) { next(err); }
});

router.post('/github/install', requireAuth, needUser, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json({ url: await createInstallUrl(req.user.id) });
  } catch (err) {
    if (err instanceof ConnectError && err.reason === 'not_configured') {
      return res.status(503).json({ error: 'not_configured', message: 'GitHub integration is not configured on this server.' });
    }
    next(err);
  }
});

function finish(res, status, reason) {
  if (status === 'error') console.warn(`[github-connect] callback failed: ${reason}`);
  res.set('Cache-Control', 'no-store');
  if (!config.frontendUrl) return res.status(status === 'connected' ? 200 : 400).json({ status, ...(reason ? { reason } : {}) });
  const url = new URL('/connections', config.frontendUrl);
  url.searchParams.set('github', status);
  if (reason) url.searchParams.set('reason', reason);
  return res.redirect(url.toString());
}

router.get('/github/callback', async (req, res, next) => {
  try {
    const q = req.query;
    const one = (v) => (typeof v === 'string' ? v : undefined);
    let userId;
    try {
      userId = await consumeState(one(q.state));
    } catch (err) {
      if (err instanceof ConnectError) return finish(res, 'error', err.reason);
      throw err;
    }
    if (one(q.error)) return finish(res, 'cancelled');
    if (one(q.setup_action) === 'request') return finish(res, 'pending');
    try {
      await completeInstall({ userId, installationId: one(q.installation_id), code: one(q.code) });
    } catch (err) {
      if (err instanceof ConnectError) return finish(res, 'error', err.reason);
      // Log only the error class/code, never the message (it could echo config).
      console.warn(`[github-connect] unexpected failure: ${err?.name} ${err?.code || ''}`);
      return finish(res, 'error', 'server_error');
    }
    return finish(res, 'connected');
  } catch (err) { next(err); }
});

export default router;
