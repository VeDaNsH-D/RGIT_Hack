import { Router } from 'express';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { WhatsAppConnection, JiraConnection, SlackConnection, NotionConnection } from '../models/index.js';
import { JiraConnector } from '../integrations/jira/index.js';
import { SlackClient } from '../modules/ingestion/providers/slack/slackClient.js';
import { SlackConnector } from '../modules/ingestion/providers/slack/slackConnector.js';
import { NotionClient } from '../modules/ingestion/providers/notion/notionClient.js';
import { NotionConnector } from '../modules/ingestion/providers/notion/notionConnector.js';
import { RepositoryError, listAccessibleRepositories, publicRepository } from '../services/githubRepositoryService.js';
import { ConnectError, completeInstall, consumeState, createInstallUrl, getStatus } from '../services/githubConnectionService.js';
import { SlackConnectError, completeSlackInstall, consumeSlackState, createSlackInstallUrl, isSlackAppConfigured } from '../services/slackAppService.js';
import {
  isJiraOAuthConfigured,
  createJiraAuthUrl,
  verifyJiraState,
  exchangeJiraCode,
  fetchAccessibleJiraResources,
  getValidJiraAccessToken,
} from '../services/jiraOAuthService.js';

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

router.get('/github/repositories', requireAuth, needUser, async (req, res, next) => {
  try {
    const one = (v) => (typeof v === 'string' ? v : undefined);
    const q = (one(req.query.q) || '').trim().toLowerCase().slice(0, 100);
    const perPage = Math.min(Math.max(parseInt(one(req.query.perPage), 10) || 20, 1), 50);
    const page = Math.min(Math.max(parseInt(one(req.query.page), 10) || 1, 1), 100);
    const { connected, repositories, truncated } = await listAccessibleRepositories(req.user.id);
    const matches = repositories
      .filter((r) => !q || r.fullName.toLowerCase().includes(q))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    const start = (page - 1) * perPage;
    res.set('Cache-Control', 'no-store').json({
      connected,
      repositories: matches.slice(start, start + perPage).map(publicRepository),
      page, perPage, total: matches.length, hasMore: start + perPage < matches.length, truncated,
    });
  } catch (err) {
    if (err instanceof RepositoryError) return res.status(err.status).json({ error: err.code, message: err.message });
    next(err);
  }
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

router.get('/whatsapp', requireAuth, needUser, async (req, res, next) => {
  try {
    const conn = await WhatsAppConnection.findOne({ userId: req.user.id });
    if (!conn || !conn.active) {
      return res.set('Cache-Control', 'no-store').json({
        connected: false,
        sandboxCode: 'join fear-company',
        sandboxNumber: '+14155238886',
        whatsappUrl: 'https://wa.me/14155238886?text=join%20fear-company',
      });
    }
    return res.set('Cache-Control', 'no-store').json({
      connected: true,
      phone: conn.phone,
      sandboxCode: conn.sandboxCode,
      sandboxNumber: conn.sandboxNumber,
      connectedAt: conn.connectedAt,
      whatsappUrl: `https://wa.me/${conn.sandboxNumber.replace(/\+/g, '')}?text=${encodeURIComponent(conn.sandboxCode)}`,
    });
  } catch (err) { next(err); }
});

router.post('/whatsapp', requireAuth, needUser, async (req, res, next) => {
  try {
    const rawPhone = String(req.body?.phone || '').trim();
    const cleaned = rawPhone.replace(/[\s\-()]/g, '');
    if (!cleaned || !/^\+?[1-9]\d{7,14}$/.test(cleaned)) {
      return res.status(400).json({
        error: 'invalid_phone',
        message: 'Please provide a valid phone number with country code (e.g. +919021875564).',
      });
    }
    const phone = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;

    const conn = await WhatsAppConnection.findOneAndUpdate(
      { userId: req.user.id },
      {
        userId: req.user.id,
        phone,
        sandboxCode: 'join fear-company',
        sandboxNumber: '+14155238886',
        active: true,
        connectedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({
      connected: true,
      phone: conn.phone,
      sandboxCode: conn.sandboxCode,
      sandboxNumber: conn.sandboxNumber,
      connectedAt: conn.connectedAt,
      whatsappUrl: 'https://wa.me/14155238886?text=join%20fear-company',
    });
  } catch (err) { next(err); }
});

router.delete('/whatsapp', requireAuth, needUser, async (req, res, next) => {
  try {
    await WhatsAppConnection.deleteOne({ userId: req.user.id });
    return res.status(200).json({
      connected: false,
      sandboxCode: 'join fear-company',
      sandboxNumber: '+14155238886',
      whatsappUrl: 'https://wa.me/14155238886?text=join%20fear-company',
    });
  } catch (err) { next(err); }
});

function finishJira(res, status, reason) {
  if (status === 'error') console.warn(`[jira-connect] callback failed: ${reason}`);
  res.set('Cache-Control', 'no-store');
  if (!config.frontendUrl) {
    return res.status(status === 'connected' ? 200 : 400).json({ status, ...(reason ? { reason } : {}) });
  }
  const url = new URL('/connections', config.frontendUrl);
  url.searchParams.set('jira', status);
  if (reason) url.searchParams.set('reason', reason);
  return res.redirect(url.toString());
}

router.get('/jira', requireAuth, needUser, async (req, res, next) => {
  try {
    const configured = isJiraOAuthConfigured();
    const conn = await JiraConnection.findOne({ userId: req.user.id });
    if (!conn || !conn.active) {
      return res.set('Cache-Control', 'no-store').json({
        connected: false,
        configured,
      });
    }

    return res.set('Cache-Control', 'no-store').json({
      connected: true,
      configured,
      authType: conn.authType || 'oauth',
      host: conn.siteUrl || conn.host,
      siteUrl: conn.siteUrl || conn.host,
      siteName: conn.siteName || conn.host,
      cloudId: conn.cloudId,
      email: conn.email,
      projectKey: conn.projectKey,
      connectedAt: conn.connectedAt,
      lastSyncAt: conn.lastSyncAt,
      syncedIssueCount: conn.syncedIssueCount,
    });
  } catch (err) { next(err); }
});

router.post('/jira/install', requireAuth, needUser, async (req, res, next) => {
  try {
    if (!isJiraOAuthConfigured()) {
      return res.status(503).json({
        error: 'not_configured',
        message: 'Jira OAuth is not configured on this server. Please set JIRA_CLIENT_ID and JIRA_CLIENT_SECRET.',
      });
    }
    const url = createJiraAuthUrl(req.user.id);
    return res.set('Cache-Control', 'no-store').json({ url });
  } catch (err) { next(err); }
});

router.get('/jira/callback', async (req, res, next) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return finishJira(res, 'error', error_description || error);
    }
    if (!code || !state) {
      return finishJira(res, 'error', 'Missing authorization code or state');
    }

    let userId;
    try {
      userId = verifyJiraState(state);
    } catch (err) {
      return finishJira(res, 'error', 'Invalid or expired state session');
    }

    const tokenData = await exchangeJiraCode(code);
    const resources = await fetchAccessibleJiraResources(tokenData.accessToken);

    if (!resources || resources.length === 0) {
      return finishJira(res, 'error', 'No accessible Jira Cloud sites found for your Atlassian account');
    }

    const primarySite = resources[0];
    const expiresAt = tokenData.expiresIn
      ? new Date(Date.now() + tokenData.expiresIn * 1000)
      : null;

    await JiraConnection.findOneAndUpdate(
      { userId },
      {
        userId,
        authType: 'oauth',
        cloudId: primarySite.id,
        siteUrl: primarySite.url,
        siteName: primarySite.name,
        host: primarySite.url,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        tokenExpiresAt: expiresAt,
        scopes: tokenData.scope ? tokenData.scope.split(' ') : primarySite.scopes || [],
        active: true,
        connectedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return finishJira(res, 'connected');
  } catch (err) {
    console.error('[jira-oauth-callback] Error:', err);
    return finishJira(res, 'error', err.message || 'OAuth exchange failed');
  }
});

router.post('/jira', requireAuth, needUser, async (req, res, next) => {
  try {
    let { host, email, apiToken, projectKey } = req.body || {};
    host = String(host || '').trim();
    email = String(email || '').trim();
    apiToken = String(apiToken || '').trim();
    projectKey = String(projectKey || '').trim().toUpperCase();

    if (!host) {
      return res.status(400).json({
        error: 'invalid_host',
        message: 'Please provide your Jira instance domain (e.g. https://your-domain.atlassian.net).',
      });
    }
    if (!apiToken) {
      return res.status(400).json({
        error: 'invalid_token',
        message: 'Please provide your Jira API token.',
      });
    }

    if (!host.startsWith('http://') && !host.startsWith('https://')) {
      host = `https://${host}`;
    }

    try {
      const connector = new JiraConnector({ host, email, apiToken });
      const check = await connector.verifyConnection();
      if (!check.ok) {
        return res.status(400).json({
          error: 'jira_verification_failed',
          message: check.error || 'Could not verify Jira credentials. Please check your domain and API token.',
        });
      }
    } catch (checkErr) {
      return res.status(400).json({
        error: 'jira_verification_failed',
        message: checkErr.message || 'Verification failed. Please check your Jira host and token.',
      });
    }

    const conn = await JiraConnection.findOneAndUpdate(
      { userId: req.user.id },
      {
        userId: req.user.id,
        authType: 'api_token',
        host,
        siteUrl: host,
        email,
        apiToken,
        projectKey,
        active: true,
        connectedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({
      connected: true,
      authType: 'api_token',
      host: conn.host,
      siteUrl: conn.siteUrl,
      email: conn.email,
      projectKey: conn.projectKey,
      connectedAt: conn.connectedAt,
      lastSyncAt: conn.lastSyncAt,
      syncedIssueCount: conn.syncedIssueCount,
    });
  } catch (err) { next(err); }
});

router.delete('/jira', requireAuth, needUser, async (req, res, next) => {
  try {
    await JiraConnection.deleteOne({ userId: req.user.id });
    return res.status(200).json({
      connected: false,
    });
  } catch (err) { next(err); }
});

router.post('/jira/sync', requireAuth, needUser, async (req, res, next) => {
  try {
    const conn = await JiraConnection.findOne({ userId: req.user.id, active: true });
    if (!conn) {
      return res.status(400).json({ error: 'not_connected', message: 'Jira is not connected.' });
    }

    let connector;
    if (conn.authType === 'oauth' || conn.cloudId) {
      const accessToken = await getValidJiraAccessToken(conn);
      connector = new JiraConnector({
        cloudId: conn.cloudId,
        accessToken,
      });
    } else {
      connector = new JiraConnector({
        host: conn.host,
        email: conn.email,
        apiToken: conn.apiToken,
      });
    }

    const syncResult = await connector.sync({
      projectKey: conn.projectKey || undefined,
      maxPages: 3,
      perPage: 25,
    });

    conn.lastSyncAt = new Date();
    conn.syncedIssueCount = syncResult.recordsCount || 0;
    await conn.save();

    return res.status(200).json({
      ok: true,
      syncedIssueCount: conn.syncedIssueCount,
      lastSyncAt: conn.lastSyncAt,
    });
  } catch (err) { next(err); }
});

function finishSlack(res, status, reason) {
  if (status === 'error') console.warn(`[slack-connect] callback failed: ${reason}`);
  res.set('Cache-Control', 'no-store');
  if (!config.frontendUrl) return res.status(status === 'connected' ? 200 : 400).json({ status, ...(reason ? { reason } : {}) });
  const url = new URL('/connections', config.frontendUrl);
  url.searchParams.set('slack', status);
  if (reason) url.searchParams.set('reason', reason);
  return res.redirect(url.toString());
}

router.get('/slack', requireAuth, needUser, async (req, res, next) => {
  try {
    const conn = await SlackConnection.findOne({ userId: req.user.id });
    const configured = isSlackAppConfigured();
    if (!conn || !conn.active) {
      return res.set('Cache-Control', 'no-store').json({ connected: false, configured });
    }
    return res.set('Cache-Control', 'no-store').json({
      connected: true,
      configured,
      teamDomain: conn.teamDomain,
      teamName: conn.teamName,
      channelId: conn.channelId,
      connectedAt: conn.connectedAt,
      lastSyncAt: conn.lastSyncAt,
      syncedMessageCount: conn.syncedMessageCount,
    });
  } catch (err) { next(err); }
});

router.post('/slack/install', requireAuth, needUser, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json({ url: await createSlackInstallUrl(req.user.id) });
  } catch (err) {
    if (err instanceof SlackConnectError && err.reason === 'not_configured') {
      return res.status(503).json({ error: 'not_configured', message: 'Slack App integration is not configured on this server.' });
    }
    next(err);
  }
});

router.get('/slack/callback', async (req, res, next) => {
  try {
    const q = req.query;
    const one = (v) => (typeof v === 'string' ? v : undefined);
    let userId;
    try {
      userId = await consumeSlackState(one(q.state));
    } catch (err) {
      if (err instanceof SlackConnectError) return finishSlack(res, 'error', err.reason);
      throw err;
    }
    if (one(q.error)) return finishSlack(res, 'cancelled', one(q.error));
    try {
      await completeSlackInstall({ userId, code: one(q.code) });
    } catch (err) {
      if (err instanceof SlackConnectError) return finishSlack(res, 'error', err.reason);
      console.warn(`[slack-connect] unexpected failure: ${err?.name} ${err?.message || ''}`);
      return finishSlack(res, 'error', 'server_error');
    }
    return finishSlack(res, 'connected');
  } catch (err) { next(err); }
});

router.delete('/slack', requireAuth, needUser, async (req, res, next) => {
  try {
    await SlackConnection.deleteOne({ userId: req.user.id });
    return res.status(200).json({ connected: false });
  } catch (err) { next(err); }
});

router.get('/slack/channels', requireAuth, needUser, async (req, res, next) => {
  try {
    const conn = await SlackConnection.findOne({ userId: req.user.id, active: true });
    if (!conn) {
      return res.set('Cache-Control', 'no-store').json({ connected: false, channels: [] });
    }
    const connector = new SlackConnector({
      token: conn.botToken,
      teamDomain: conn.teamDomain,
    });
    const channels = await connector.getChannels();
    return res.set('Cache-Control', 'no-store').json({
      connected: true,
      teamDomain: conn.teamDomain,
      teamName: conn.teamName,
      channels,
    });
  } catch (err) {
    return res.status(400).json({
      error: 'slack_channels_failed',
      message: err.message || 'Failed to fetch Slack channels.',
      channels: [],
    });
  }
});

router.post('/slack/sync', requireAuth, needUser, async (req, res, next) => {
  try {
    const conn = await SlackConnection.findOne({ userId: req.user.id, active: true });
    if (!conn) {
      return res.status(400).json({ error: 'not_connected', message: 'Slack is not connected.' });
    }
    const connector = new SlackConnector({
      token: conn.botToken,
      teamDomain: conn.teamDomain,
    });
    const result = await connector.sync({
      channelId: conn.channelId || undefined,
      maxPages: 3,
      perPage: 25,
    });
    conn.lastSyncAt = new Date();
    conn.syncedMessageCount = result.recordsCount || 0;
    await conn.save();

    return res.status(200).json({
      ok: true,
      syncedMessageCount: conn.syncedMessageCount,
      lastSyncAt: conn.lastSyncAt,
    });
  } catch (err) { next(err); }
});

router.get('/notion', requireAuth, needUser, async (req, res, next) => {
  try {
    const conn = await NotionConnection.findOne({ userId: req.user.id });
    if (!conn || !conn.active) {
      return res.set('Cache-Control', 'no-store').json({ connected: false });
    }
    return res.set('Cache-Control', 'no-store').json({
      connected: true,
      workspaceName: conn.workspaceName,
      pageId: conn.pageId,
      databaseId: conn.databaseId,
      connectedAt: conn.connectedAt,
      lastSyncAt: conn.lastSyncAt,
      syncedPageCount: conn.syncedPageCount,
    });
  } catch (err) { next(err); }
});

router.post('/notion', requireAuth, needUser, async (req, res, next) => {
  try {
    let { apiKey, pageId, databaseId } = req.body || {};
    apiKey = String(apiKey || '').trim();
    pageId = String(pageId || '').trim();
    databaseId = String(databaseId || '').trim();

    if (!apiKey) {
      return res.status(400).json({
        error: 'invalid_token',
        message: 'Please provide your Notion Internal Integration Secret (starts with secret_).',
      });
    }

    try {
      const client = new NotionClient({ apiKey });
      await client.search({ pageSize: 1 });
    } catch (err) {
      return res.status(400).json({
        error: 'notion_verification_failed',
        message: err.message || 'Could not verify Notion token. Check your integration secret and shared pages.',
      });
    }

    const conn = await NotionConnection.findOneAndUpdate(
      { userId: req.user.id },
      {
        userId: req.user.id,
        apiKey,
        pageId,
        databaseId,
        workspaceName: 'Notion Workspace',
        active: true,
        connectedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({
      connected: true,
      workspaceName: conn.workspaceName,
      pageId: conn.pageId,
      databaseId: conn.databaseId,
      connectedAt: conn.connectedAt,
      lastSyncAt: conn.lastSyncAt,
      syncedPageCount: conn.syncedPageCount,
    });
  } catch (err) { next(err); }
});

router.delete('/notion', requireAuth, needUser, async (req, res, next) => {
  try {
    await NotionConnection.deleteOne({ userId: req.user.id });
    return res.status(200).json({ connected: false });
  } catch (err) { next(err); }
});

router.post('/notion/sync', requireAuth, needUser, async (req, res, next) => {
  try {
    const conn = await NotionConnection.findOne({ userId: req.user.id, active: true });
    if (!conn) {
      return res.status(400).json({ error: 'not_connected', message: 'Notion is not connected.' });
    }
    const connector = new NotionConnector({ apiKey: conn.apiKey });
    const result = await connector.sync({
      databaseId: conn.databaseId || undefined,
      pageIds: conn.pageId ? [conn.pageId] : undefined,
      maxPages: 3,
    });
    conn.lastSyncAt = new Date();
    conn.syncedPageCount = result.recordsCount || 0;
    await conn.save();

    return res.status(200).json({
      ok: true,
      syncedPageCount: conn.syncedPageCount,
      lastSyncAt: conn.lastSyncAt,
    });
  } catch (err) { next(err); }
});

export default router;
