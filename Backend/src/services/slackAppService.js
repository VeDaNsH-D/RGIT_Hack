import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { SlackConnection } from '../models/SlackConnection.js';
import { SlackInstallState } from '../models/SlackInstallState.js';

export const STATE_TTL_MS = 10 * 60 * 1000;

export class SlackConnectError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason;
  }
}

const hash = (value) => createHash('sha256').update(value).digest('hex');

export function isSlackAppConfigured() {
  const app = config.slackApp;
  return Boolean(app && app.clientId && app.clientSecret);
}

export async function createSlackInstallUrl(userId, now = Date.now()) {
  if (!isSlackAppConfigured()) {
    throw new SlackConnectError('not_configured', 'Slack App OAuth is not configured on this server.');
  }

  const state = randomBytes(32).toString('base64url');
  await SlackInstallState.deleteMany({ userId });
  await SlackInstallState.create({
    stateHash: hash(state),
    userId,
    expiresAt: new Date(now + STATE_TTL_MS),
  });

  const clientId = encodeURIComponent(config.slackApp.clientId);
  const scopes = encodeURIComponent(config.slackApp.scopes || 'channels:read,channels:history,groups:read,groups:history');
  const redirectUri = encodeURIComponent(config.slackApp.redirectUri);

  return `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}&state=${encodeURIComponent(state)}`;
}

export async function consumeSlackState(state, now = Date.now()) {
  if (typeof state !== 'string' || state.length < 20 || state.length > 200) {
    throw new SlackConnectError('invalid_state', 'Invalid OAuth state.');
  }
  const row = await SlackInstallState.findOneAndDelete({ stateHash: hash(state) });
  if (!row) throw new SlackConnectError('invalid_state', 'OAuth state not found or already consumed.');
  if (row.expiresAt.getTime() <= now) throw new SlackConnectError('expired_state', 'OAuth state expired.');
  return String(row.userId);
}

export async function completeSlackInstall({ userId, code }) {
  if (!code || typeof code !== 'string') {
    throw new SlackConnectError('missing_code', 'No authorization code returned from Slack.');
  }

  const redirectUri = config.slackApp.redirectUri;

  const params = new URLSearchParams({
    client_id: config.slackApp.clientId,
    client_secret: config.slackApp.clientSecret,
    code: code.trim(),
    redirect_uri: redirectUri,
  });

  let res;
  try {
    res = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new SlackConnectError('slack_unreachable', 'Could not reach Slack API.');
  }

  const data = await res.json().catch(() => null);

  if (!res.ok || !data?.ok) {
    const errorMsg = data?.error || 'Slack OAuth authorization failed.';
    throw new SlackConnectError(data?.error || 'authorization_failed', errorMsg);
  }

  const botToken = data.access_token;
  const teamName = data.team?.name || 'Slack Workspace';
  const teamId = data.team?.id || '';
  const teamDomain = data.team?.name ? data.team.name.toLowerCase().replace(/[^a-z0-9]/g, '-') : '';

  const connection = await SlackConnection.findOneAndUpdate(
    { userId },
    {
      userId,
      botToken,
      teamName,
      teamDomain,
      teamId,
      authedUserId: data.authed_user?.id || '',
      appId: data.app_id || '',
      active: true,
      connectedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return connection;
}
