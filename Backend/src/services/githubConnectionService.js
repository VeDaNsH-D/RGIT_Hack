import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { GitHubInstallation } from '../models/GitHubInstallation.js';
import { GitHubInstallState } from '../models/GitHubInstallState.js';
import { GitHubAppAuthService, validateInstallationId } from '../modules/ingestion/providers/github/githubAppAuth.js';

export const STATE_TTL_MS = 10 * 60 * 1000;
const API = 'https://api.github.com';
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Relay-GitHub-Connect' };

export class ConnectError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason;
  }
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
const gh = async (url, init = {}) => {
  let res;
  try {
    res = await globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  } catch {
    throw new ConnectError('github_unreachable');
  }
  return res;
};

export function isInstallConfigured() {
  const app = config.githubApp;
  return Boolean(app.enabled && app.appSlug && app.clientId && app.clientSecret);
}

export async function createInstallUrl(userId, now = Date.now()) {
  if (!isInstallConfigured()) throw new ConnectError('not_configured');
  const state = randomBytes(32).toString('base64url');
  await GitHubInstallState.deleteMany({ userId });
  await GitHubInstallState.create({ stateHash: hash(state), userId, expiresAt: new Date(now + STATE_TTL_MS) });
  const slug = encodeURIComponent(config.githubApp.appSlug);
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
}

/** Atomically consumes the state; returns the bound userId or throws. */
export async function consumeState(state, now = Date.now()) {
  if (typeof state !== 'string' || state.length < 20 || state.length > 200) throw new ConnectError('invalid_state');
  const row = await GitHubInstallState.findOneAndDelete({ stateHash: hash(state) });
  if (!row) throw new ConnectError('invalid_state');
  if (row.expiresAt.getTime() <= now) throw new ConnectError('expired_state');
  return String(row.userId);
}

async function userTokenFromCode(code) {
  const res = await gh('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': HEADERS['User-Agent'] },
    body: JSON.stringify({ client_id: config.githubApp.clientId, client_secret: config.githubApp.clientSecret, code }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) throw new ConnectError('authorization_failed');
  return data.access_token;
}

async function userCanAccess(userToken, installationId) {
  for (let page = 1; page <= 5; page += 1) {
    const res = await gh(`${API}/user/installations?per_page=100&page=${page}`, { headers: { ...HEADERS, Authorization: `Bearer ${userToken}` } });
    if (!res.ok) throw new ConnectError('authorization_failed');
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.installations) ? data.installations : [];
    if (list.some((i) => i?.id === installationId)) return true;
    if (list.length < 100) return false;
  }
  return false;
}

async function fetchInstallation(installationId) {
  const { appId, privateKey } = config.githubApp;
  const jwtToken = new GitHubAppAuthService({ appId, privateKey, fetchFn: globalThis.fetch }).createAppJwt();
  const res = await gh(`${API}/app/installations/${installationId}`, { headers: { ...HEADERS, Authorization: `Bearer ${jwtToken}` } });
  if (res.status === 404) throw new ConnectError('installation_not_found');
  if (!res.ok) throw new ConnectError('installation_unverified');
  const data = await res.json().catch(() => null);
  const login = data?.account?.login;
  if (data?.id !== installationId || String(data?.app_id) !== String(appId) || typeof login !== 'string') {
    throw new ConnectError('installation_unverified');
  }
  if (data.suspended_at) throw new ConnectError('installation_suspended');
  return {
    accountLogin: login,
    accountType: data.account.type === 'Organization' ? 'Organization' : 'User',
    repositorySelection: data.repository_selection === 'all' ? 'all' : 'selected',
  };
}

/** Verifies the installation with GitHub and persists it for the state's user. */
export async function completeInstall({ userId, installationId: rawId, code, now = new Date() }) {
  let installationId;
  try { installationId = validateInstallationId(rawId); } catch { throw new ConnectError('invalid_installation'); }
  if (typeof code !== 'string' || !code) throw new ConnectError('authorization_required');
  // Prove the installing user can see this installation; the id alone is attacker-controllable.
  if (!(await userCanAccess(await userTokenFromCode(code), installationId))) throw new ConnectError('installation_forbidden');
  const info = await fetchInstallation(installationId);
  await GitHubInstallation.findOneAndUpdate(
    { userId, installationId },
    { $set: { ...info, status: 'active' }, $setOnInsert: { connectedAt: now } },
    { upsert: true }
  );
}

export async function getStatus(userId) {
  const rows = await GitHubInstallation.find({ userId, status: 'active' }).sort({ connectedAt: 1 }).lean();
  return {
    provider: 'github',
    configured: isInstallConfigured(),
    connected: rows.length > 0,
    accounts: rows.map((r) => ({ id: String(r._id), login: r.accountLogin, type: r.accountType, repositorySelection: r.repositorySelection, connectedAt: r.connectedAt })),
    repositoryAssociationRequired: rows.length > 0,
  };
}
