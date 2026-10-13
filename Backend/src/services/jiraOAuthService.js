import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { JiraConnection } from '../models/JiraConnection.js';

export class JiraOAuthError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'JiraOAuthError';
    this.details = details;
  }
}

/**
 * Returns whether Jira OAuth 2.0 (3LO) credentials are configured.
 */
export function isJiraOAuthConfigured() {
  return Boolean(
    config.oauth?.jira?.enabled ||
    (process.env.JIRA_CLIENT_ID && process.env.JIRA_CLIENT_SECRET)
  );
}

/**
 * Returns the effective redirect URI for Jira OAuth callback.
 */
export function getJiraRedirectUri() {
  return (
    process.env.JIRA_REDIRECT_URI ||
    config.oauth?.jira?.redirectUri ||
    `${config.apiBaseUrl.replace(/\/$/, '')}/api/connections/jira/callback`
  );
}

/**
 * Generates the Atlassian OAuth 2.0 authorization URL for the user.
 *
 * @param {string} userId - MongoDB User ID
 * @returns {string} Fully qualified Atlassian authorization URL
 */
export function createJiraAuthUrl(userId) {
  if (!isJiraOAuthConfigured()) {
    throw new JiraOAuthError('Jira OAuth is not configured on this server.', {
      code: 'JIRA_NOT_CONFIGURED',
    });
  }

  const clientId = process.env.JIRA_CLIENT_ID || config.oauth.jira.clientId;
  const redirectUri = getJiraRedirectUri();
  const scopes = process.env.JIRA_SCOPES || config.oauth?.jira?.scopes || 'read:jira-work read:jira-user offline_access';

  // Securely sign the state containing the userId and purpose
  const state = jwt.sign(
    { userId: String(userId), purpose: 'jira_oauth' },
    config.jwtSecret,
    { expiresIn: '15m' }
  );

  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: scopes,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  });

  return `https://auth.atlassian.com/authorize?${params.toString()}`;
}

/**
 * Verifies and decodes the Jira OAuth state token.
 *
 * @param {string} state - The signed JWT state token returned by Atlassian
 * @returns {string} The verified userId
 */
export function verifyJiraState(state) {
  if (!state || typeof state !== 'string') {
    throw new JiraOAuthError('Missing or invalid state parameter.', { code: 'INVALID_STATE' });
  }

  try {
    const decoded = jwt.verify(state, config.jwtSecret);
    if (decoded.purpose !== 'jira_oauth' || !decoded.userId) {
      throw new JiraOAuthError('Invalid state token purpose.', { code: 'INVALID_STATE' });
    }
    return String(decoded.userId);
  } catch (err) {
    throw new JiraOAuthError(`State verification failed: ${err.message}`, {
      code: 'STATE_EXPIRED_OR_INVALID',
      original: err.message,
    });
  }
}

/**
 * Exchanges the authorization code for Atlassian OAuth tokens.
 *
 * @param {string} code - The authorization code returned by Atlassian
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number, scope: string }>}
 */
export async function exchangeJiraCode(code) {
  const clientId = process.env.JIRA_CLIENT_ID || config.oauth.jira.clientId;
  const clientSecret = process.env.JIRA_CLIENT_SECRET || config.oauth.jira.clientSecret;
  const redirectUri = getJiraRedirectUri();

  const res = await globalThis.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    const errorMsg = data.error_description || data.error || `HTTP ${res.status} token exchange failure`;
    throw new JiraOAuthError(`Atlassian token exchange failed: ${errorMsg}`, {
      status: res.status,
      details: data,
    });
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresIn: data.expires_in || 3600,
    scope: data.scope || '',
  };
}

/**
 * Fetches the user's accessible Jira Cloud sites.
 *
 * @param {string} accessToken - Atlassian access token
 * @returns {Promise<Array<{ id: string, name: string, url: string, scopes: string[], avatarUrl: string }>>}
 */
export async function fetchAccessibleJiraResources(accessToken) {
  const res = await globalThis.fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new JiraOAuthError(`Failed to fetch accessible Jira resources: HTTP ${res.status}`, {
      status: res.status,
      body: errText,
    });
  }

  const resources = await res.json();
  if (!Array.isArray(resources)) {
    return [];
  }

  return resources.map((site) => ({
    id: site.id, // cloudId
    name: site.name,
    url: site.url,
    scopes: site.scopes || [],
    avatarUrl: site.avatarUrl || '',
  }));
}

/**
 * Refreshes an expired Atlassian access token using the refresh token.
 *
 * @param {string} refreshToken - The stored refresh token
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>}
 */
export async function refreshJiraAccessToken(refreshToken) {
  const clientId = process.env.JIRA_CLIENT_ID || config.oauth.jira.clientId;
  const clientSecret = process.env.JIRA_CLIENT_SECRET || config.oauth.jira.clientSecret;

  const res = await globalThis.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    throw new JiraOAuthError(`Failed to refresh Atlassian access token: ${data.error_description || data.error || res.status}`, {
      status: res.status,
      details: data,
    });
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 3600,
  };
}

/**
 * Ensures the Jira connection has a valid access token, refreshing if necessary.
 *
 * @param {object} connection - JiraConnection mongoose document
 * @returns {Promise<string>} Valid access token
 */
export async function getValidJiraAccessToken(connection) {
  if (!connection) {
    throw new JiraOAuthError('Connection document is required.');
  }

  // If using legacy API token
  if (connection.authType === 'api_token' || !connection.accessToken) {
    return connection.apiToken || '';
  }

  // Check if access token is still fresh (buffer of 5 minutes)
  const isExpiringSoon = connection.tokenExpiresAt &&
    (new Date(connection.tokenExpiresAt).getTime() - Date.now() < 5 * 60 * 1000);

  if (!isExpiringSoon) {
    return connection.accessToken;
  }

  if (!connection.refreshToken) {
    return connection.accessToken;
  }

  try {
    const refreshed = await refreshJiraAccessToken(connection.refreshToken);
    connection.accessToken = refreshed.accessToken;
    if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
    connection.tokenExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
    if (typeof connection.save === 'function') {
      await connection.save();
    } else if (connection._id) {
      await JiraConnection.updateOne(
        { _id: connection._id },
        {
          $set: {
            accessToken: connection.accessToken,
            refreshToken: connection.refreshToken,
            tokenExpiresAt: connection.tokenExpiresAt,
          },
        }
      );
    }
    return connection.accessToken;
  } catch (err) {
    console.warn('[jira-oauth] Token refresh failed, falling back to existing token:', err.message);
    return connection.accessToken;
  }
}
