import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { GitHubInstallation } from '../models/GitHubInstallation.js';
import { GitHubWebhookDelivery } from '../models/GitHubWebhookDelivery.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { syncConnection } from '../services/githubSyncEngine.js';

/**
 * POST /api/webhooks/github  (configure as the GitHub App's webhook URL, content type application/json)
 *
 * - Disabled (503) until GITHUB_WEBHOOK_SECRET is set; nothing is processed unsigned.
 * - The X-Hub-Signature-256 HMAC is verified over the exact raw body (captured in app.js) with a
 *   constant-time compare BEFORE the payload is parsed or trusted.
 * - X-GitHub-Delivery ids are de-duplicated; a failed handling releases the id so GitHub's retry works.
 * - Relevant events mark matching repository connections stale and start an incremental sync. The sync
 *   is not awaited (GitHub expects a quick reply); on serverless hosts it may be cut short, in which case
 *   the stale flag makes the project page request the sync the next time someone opens it.
 */
const router = Router();
const SYNC_EVENTS = new Set(['push', 'issues', 'pull_request', 'repository']);

export function verifySignature(rawBody, header, secret) {
  if (!rawBody || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

router.post('/github', async (req, res) => {
  const secret = config.githubApp.webhookSecret;
  if (!secret) return res.status(503).json({ error: 'webhooks_disabled', message: 'GitHub webhooks are not configured.' });
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), secret)) {
    return res.status(401).json({ error: 'invalid_signature', message: 'Invalid webhook signature.' });
  }
  const deliveryId = req.get('x-github-delivery');
  const event = req.get('x-github-event');
  if (!deliveryId || !event) return res.status(400).json({ error: 'validation_error', message: 'Missing GitHub delivery headers.' });

  try {
    await GitHubWebhookDelivery.create({ deliveryId });
  } catch (err) {
    if (err?.code === 11000) return res.status(200).json({ ok: true, duplicate: true });
    return res.status(500).json({ error: 'internal_error', message: 'Could not record delivery.' });
  }

  try {
    const payload = req.body || {};
    if (event === 'installation' && ['deleted', 'suspend'].includes(payload.action) && Number.isSafeInteger(payload.installation?.id)) {
      await GitHubInstallation.updateMany({ installationId: payload.installation.id }, { $set: { status: 'suspended' } });
    } else if (event === 'installation' && payload.action === 'unsuspend' && Number.isSafeInteger(payload.installation?.id)) {
      await GitHubInstallation.updateMany({ installationId: payload.installation.id }, { $set: { status: 'active' } });
    } else if (SYNC_EVENTS.has(event) && Number.isSafeInteger(payload.repository?.id) && Number.isSafeInteger(payload.installation?.id)) {
      // Only connections made through THIS installation are touched.
      const connections = await SourceConnection.find({ provider: 'github', 'config.repositoryId': payload.repository.id, 'config.installationId': payload.installation.id }).select('_id').lean();
      await SourceConnection.updateMany({ _id: { $in: connections.map((c) => c._id) } }, { $set: { 'config.sync.staleAt': new Date(), ...(event === 'push' ? { 'config.analysis.staleAt': new Date() } : {}) } });
      for (const c of connections) syncConnection(c._id).catch(() => {}); // outcome is recorded on the connection itself
      return res.status(202).json({ ok: true, connections: connections.length });
    }
    return res.status(202).json({ ok: true });
  } catch {
    await GitHubWebhookDelivery.deleteOne({ deliveryId }).catch(() => {});
    return res.status(500).json({ error: 'internal_error', message: 'Could not process webhook.' });
  }
});

export default router;
