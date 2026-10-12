import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { NotionInstallState } from '../models/NotionInstallState.js';
import { NotionConnection } from '../models/NotionConnection.js';
import { encryptTokens, decryptTokens } from '../email/providers.js';

export class NotionConnectError extends Error {
  constructor(reason) { super('Could not authorize Notion. Please reconnect.'); this.reason = reason; }
}
const hash = value => createHash('sha256').update(value).digest('hex');
export const isNotionOAuthConfigured = () => Boolean(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET);
export const notionRedirectUri = () => process.env.NOTION_REDIRECT_URI || `${config.apiBaseUrl.replace(/\/$/, '')}/api/connections/notion/callback`;
export async function createNotionInstallUrl(userId, now = Date.now()) {
  if (!isNotionOAuthConfigured()) throw new NotionConnectError('not_configured');
  const state = randomBytes(32).toString('base64url');
  await NotionInstallState.create({ userId, stateHash: hash(state), expiresAt: new Date(now + 600000) });
  return `https://api.notion.com/v1/oauth/authorize?${new URLSearchParams({ client_id: process.env.NOTION_CLIENT_ID, redirect_uri: notionRedirectUri(), response_type: 'code', owner: 'user', state })}`;
}
export async function consumeNotionState(state, now = Date.now()) {
  if (typeof state !== 'string' || state.length < 20 || state.length > 200) throw new NotionConnectError('invalid_state');
  const row = await NotionInstallState.findOneAndDelete({ stateHash: hash(state) });
  if (!row || row.expiresAt.getTime() <= now) throw new NotionConnectError('invalid_state');
  return String(row.userId);
}
async function tokenRequest(body) {
  if (!isNotionOAuthConfigured()) throw new NotionConnectError('not_configured');
  let response;
  try {
    response = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`).toString('base64')}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch { throw new NotionConnectError('notion_unreachable'); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) throw new NotionConnectError('authorization_failed');
  return data;
}
export async function completeNotionInstall(userId, code) {
  if (typeof code !== 'string' || !code || code.length > 2000) throw new NotionConnectError('missing_code');
  const data = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: notionRedirectUri() });
  return NotionConnection.findOneAndUpdate({ userId }, { $set: { userId, apiKey: '', encryptedTokens: encryptTokens(data), authMethod: 'oauth', workspaceId: data.workspace_id || '', workspaceName: data.workspace_name || 'Notion Workspace', pageId: '', databaseId: '', active: true, connectedAt: new Date() } }, { upsert: true, new: true, setDefaultsOnInsert: true });
}
export async function notionAccessToken(connection) {
  return connection.encryptedTokens ? decryptTokens(connection.encryptedTokens).access_token : connection.apiKey;
}
const refreshes = new Map();
export async function withNotionToken(connection, operation) {
  try { return await operation(await notionAccessToken(connection)); }
  catch (error) {
    if (error.statusCode !== 401 || !connection.encryptedTokens) throw error;
    const id = String(connection._id);
    if (!refreshes.has(id)) {
      const refresh = (async () => {
        const latest = await NotionConnection.findById(id);
        if (!latest?.active) throw new NotionConnectError('not_connected');
        const tokens = decryptTokens(latest.encryptedTokens);
        const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
        const encrypted = encryptTokens({ ...tokens, ...fresh });
        const saved = await NotionConnection.updateOne({ _id: id, active: true, encryptedTokens: latest.encryptedTokens }, { $set: { encryptedTokens: encrypted } });
        if (!saved.modifiedCount) throw new NotionConnectError('reconnect_required');
        return fresh.access_token;
      })();
      refreshes.set(id, refresh);
      refresh.finally(() => refreshes.delete(id)).catch(() => {});
    }
    return operation(await refreshes.get(id));
  }
}
