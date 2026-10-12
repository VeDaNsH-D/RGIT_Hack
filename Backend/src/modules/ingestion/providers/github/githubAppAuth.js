/**
 * @file githubAppAuth.js
 * @description GitHub App authentication service.
 *
 * Responsibilities:
 * 1. Validate GitHub App configuration (App ID, Private Key).
 * 2. Generate short-lived RS256-signed JWTs for GitHub App authentication:
 *    - Issued at: (now - 60 seconds) to prevent clock skew rejection by GitHub.
 *    - Expires: in 9 minutes (max allowed by GitHub is 10 minutes).
 *    - Issuer: GitHub App ID.
 * 3. Validate installation IDs (positive integers).
 * 4. Request GitHub App installation access tokens from:
 *    `POST /app/installations/{installation_id}/access_tokens`.
 * 5. Handle rate limiting, auth failures, timeouts, and network errors safely.
 * 6. Never expose private keys, raw App JWTs, or installation tokens in logs or error messages.
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { GITHUB_ERROR_CODES, GitHubApiError } from './githubErrors.js';
import { GitHubClient } from './githubClient.js';

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 10000;
const GITHUB_API_VERSION = '2022-11-28';
// Cached installation tokens are refreshed once they are within this window of expiry.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const APP_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

/**
 * Read-only installation permissions Relay's GitHub ingestion depends on.
 * - metadata: repository metadata and installation repository listing
 * - issues: GET /repos/{o}/{r}/issues
 * - pull_requests: GET /repos/{o}/{r}/pulls
 * - contents: GET /repos/{o}/{r}/commits
 * @readonly
 */
export const REQUIRED_READ_PERMISSIONS = Object.freeze(['metadata', 'issues', 'pull_requests', 'contents']);

/**
 * Reads GitHub App settings from an environment object without validating or
 * logging them. Kept separate from src/config.js so tooling (e.g. the smoke
 * test) can run without the database/JWT variables config.js requires.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{ appId: string, privateKey: string, appSlug: string, installationId: string }}
 */
export function readGitHubAppEnv(env = process.env) {
  return {
    appId: env.GITHUB_APP_ID || '',
    privateKey: env.GITHUB_APP_PRIVATE_KEY || '',
    appSlug: env.GITHUB_APP_SLUG || '',
    installationId: env.GITHUB_APP_INSTALLATION_ID || '',
  };
}

/**
 * Validates a GitHub App slug (public, non-secret configuration value).
 *
 * @param {string} slug
 * @returns {string}
 * @throws {GitHubApiError} CONFIG_ERROR if malformed.
 */
export function validateAppSlug(slug) {
  const value = typeof slug === 'string' ? slug.trim() : '';
  if (!APP_SLUG_REGEX.test(value)) {
    throw new GitHubApiError('Invalid GitHub App configuration: appSlug must contain only lowercase letters, digits, and hyphens.', {
      code: GITHUB_ERROR_CODES.CONFIG_ERROR,
    });
  }
  return value;
}

/**
 * Compares granted installation permissions against REQUIRED_READ_PERMISSIONS.
 * Write/admin grants are reported so operators can remove them (Relay is read-only).
 *
 * @param {Record<string, string>} [permissions={}]
 * @returns {{ ok: boolean, missing: string[], writeGranted: string[] }}
 */
export function checkInstallationPermissions(permissions = {}) {
  const granted = permissions && typeof permissions === 'object' ? permissions : {};
  const missing = REQUIRED_READ_PERMISSIONS.filter((name) => !['read', 'write', 'admin'].includes(granted[name]));
  const writeGranted = Object.entries(granted)
    .filter(([, level]) => level === 'write' || level === 'admin')
    .map(([name]) => name)
    .sort();
  return { ok: missing.length === 0, missing, writeGranted };
}

/**
 * Validates and normalizes GitHub App configuration.
 *
 * @param {Object} [cfg={}]
 * @param {string|number} [cfg.appId]
 * @param {string} [cfg.privateKey]
 * @param {string} [cfg.baseUrl]
 * @returns {{ appId: string, privateKey: string, baseUrl: string }}
 * @throws {GitHubApiError} If configuration is missing or malformed.
 */
export function validateAppConfig(cfg = {}) {
  const appIdRaw = cfg.appId !== undefined && cfg.appId !== null ? String(cfg.appId).trim() : '';
  if (!appIdRaw || !/^\d+$/.test(appIdRaw)) {
    throw new GitHubApiError('Invalid GitHub App configuration: appId must be a valid numeric App ID.', {
      code: GITHUB_ERROR_CODES.CONFIG_ERROR,
    });
  }

  const privateKey = typeof cfg.privateKey === 'string' ? cfg.privateKey.trim() : '';
  if (!privateKey) {
    throw new GitHubApiError('Invalid GitHub App configuration: privateKey is missing or empty.', {
      code: GITHUB_ERROR_CODES.CONFIG_ERROR,
    });
  }

  // Handle environment variables where newlines in PEM may be formatted as literal "\n"
  const normalizedKey = privateKey.includes('\\n')
    ? privateKey.replace(/\\n/g, '\n')
    : privateKey;

  if (!normalizedKey.includes('-----BEGIN') || !normalizedKey.includes('PRIVATE KEY-----')) {
    throw new GitHubApiError('Invalid GitHub App configuration: privateKey must be a valid PEM-encoded private key.', {
      code: GITHUB_ERROR_CODES.CONFIG_ERROR,
    });
  }

  // Parse the key so a truncated/corrupted PEM fails here with a clear, secret-free error.
  let keyObject;
  try {
    keyObject = crypto.createPrivateKey(normalizedKey);
  } catch {
    throw new GitHubApiError('Invalid GitHub App configuration: privateKey could not be parsed as a PEM private key.', {
      code: GITHUB_ERROR_CODES.CONFIG_ERROR,
    });
  }
  if (keyObject.asymmetricKeyType !== 'rsa') {
    throw new GitHubApiError('Invalid GitHub App configuration: privateKey must be an RSA key (required for RS256).', {
      code: GITHUB_ERROR_CODES.CONFIG_ERROR,
    });
  }

  const baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  return {
    appId: appIdRaw,
    privateKey: normalizedKey,
    baseUrl,
  };
}

/**
 * Validates a GitHub App installation ID.
 *
 * @param {string|number} installationId
 * @returns {number} Validated numeric installation ID.
 * @throws {GitHubApiError} If installationId is missing or non-positive.
 */
export function validateInstallationId(installationId) {
  if (installationId === undefined || installationId === null || installationId === '') {
    throw new GitHubApiError('Invalid installation ID: value is required.', {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  const num = typeof installationId === 'number' ? installationId : Number(String(installationId).trim());
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new GitHubApiError(`Invalid installation ID "${installationId}": must be a positive integer.`, {
      code: GITHUB_ERROR_CODES.INVALID_INPUT,
    });
  }

  return num;
}

/**
 * Generates an RS256-signed JWT for authenticating as the GitHub App.
 *
 * @param {Object} options
 * @param {string|number} options.appId - The GitHub App ID.
 * @param {string} options.privateKey - PEM-encoded RSA private key.
 * @param {number} [options.nowInSeconds] - Optional override for current timestamp (useful for unit tests).
 * @returns {string} Signed RS256 JWT string.
 * @throws {GitHubApiError} If signing fails or key is invalid.
 */
export function generateAppJwt({ appId, privateKey, nowInSeconds }) {
  const validated = validateAppConfig({ appId, privateKey });

  const now = typeof nowInSeconds === 'number' ? Math.floor(nowInSeconds) : Math.floor(Date.now() / 1000);
  // GitHub recommendation: iat = now - 60 to prevent clock drift issues
  const issuedAt = now - 60;
  // GitHub maximum token lifetime is 10 minutes (600s). We use 9 minutes (540s) from issuedAt for safety.
  const expiresAt = issuedAt + 540;

  const payload = {
    iat: issuedAt,
    exp: expiresAt,
    iss: validated.appId,
  };

  try {
    return jwt.sign(payload, validated.privateKey, {
      algorithm: 'RS256',
    });
  } catch (err) {
    throw new GitHubApiError('Failed to generate GitHub App JWT: RSA signing failed.', {
      code: GITHUB_ERROR_CODES.CONFIG_ERROR,
    });
  }
}

/**
 * Service that negotiates GitHub App authentication and exchanges App JWTs
 * for installation-scoped access tokens.
 */
export class GitHubAppAuthService {
  /**
   * @param {Object} [config={}]
   * @param {string|number} [config.appId] - GitHub App ID.
   * @param {string} [config.privateKey] - GitHub App RSA private key (PEM).
   * @param {string} [config.baseUrl] - Base GitHub API URL (defaults to https://api.github.com).
   * @param {number} [config.timeoutMs] - Request timeout in ms (default 10000).
   * @param {typeof fetch} [config.fetchFn] - Custom fetch function (for mocking/testing).
   */
  // Private so the private key never appears in console.log/util.inspect/JSON output.
  #rawConfig;
  #tokenCache = new Map();

  constructor(config = {}) {
    this.#rawConfig = { ...config };
    this.fetchFn = config.fetchFn || globalThis.fetch;
    this.timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : DEFAULT_TIMEOUT_MS;

    if (typeof this.fetchFn !== 'function') {
      throw new TypeError('A valid fetch implementation must be available.');
    }
  }

  /**
   * Returns validated config or throws CONFIG_ERROR.
   *
   * @private
   * @returns {{ appId: string, privateKey: string, baseUrl: string }}
   */
  #getConfig() {
    return validateAppConfig(this.#rawConfig);
  }

  /**
   * Generates a fresh App JWT for authenticating as the GitHub App.
   *
   * @returns {string} RS256 JWT.
   */
  createAppJwt() {
    const cfg = this.#getConfig();
    return generateAppJwt({ appId: cfg.appId, privateKey: cfg.privateKey });
  }

  /**
   * Requests an installation access token for the specified installation ID.
   *
   * @param {string|number} installationId - GitHub App installation ID.
   * @param {Object} [options={}]
   * @param {Array<string>} [options.repositories] - Specific repositories to scope the token to.
   * @param {Object} [options.permissions] - Specific permissions to request (must be subset of app permissions).
   * @returns {Promise<{ token: string, expiresAt: Date, permissions: Object, repositorySelection: string }>}
   * @throws {GitHubApiError} If request fails or authentication is rejected.
   */
  async createInstallationToken(installationId, options = {}) {
    const validInstallationId = validateInstallationId(installationId);
    const cfg = this.#getConfig();
    const appJwt = this.createAppJwt();

    const endpoint = `/app/installations/${validInstallationId}/access_tokens`;
    const targetUrl = `${cfg.baseUrl}${endpoint}`;

    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'Relay-Ingestion-GitHubApp',
      Authorization: `Bearer ${appJwt}`,
    };

    const bodyPayload = {};
    if (Array.isArray(options.repositories) && options.repositories.length > 0) {
      bodyPayload.repositories = options.repositories;
    }
    if (options.permissions && typeof options.permissions === 'object') {
      bodyPayload.permissions = options.permissions;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await this.fetchFn(targetUrl, {
        method: 'POST',
        headers,
        body: Object.keys(bodyPayload).length > 0 ? JSON.stringify(bodyPayload) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new GitHubApiError(`GitHub App installation token request timed out after ${this.timeoutMs}ms.`, {
          code: GITHUB_ERROR_CODES.TIMEOUT,
          endpoint,
        });
      }

      throw new GitHubApiError(`Network error requesting GitHub installation token: ${err.message}`, {
        code: GITHUB_ERROR_CODES.NETWORK_ERROR,
        endpoint,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const status = response.status;
      const apiMessage = parsed && typeof parsed === 'object' && parsed.message
        ? parsed.message
        : response.statusText;

      let code = GITHUB_ERROR_CODES.HTTP_ERROR;
      if (status === 401) {
        code = GITHUB_ERROR_CODES.AUTH_FAILED;
      } else if (status === 403) {
        const rateLimited = response.headers?.get?.('x-ratelimit-remaining') === '0'
          || (typeof apiMessage === 'string' && apiMessage.toLowerCase().includes('rate limit'));
        code = rateLimited ? GITHUB_ERROR_CODES.RATE_LIMITED : GITHUB_ERROR_CODES.FORBIDDEN;
      } else if (status === 404) {
        code = GITHUB_ERROR_CODES.NOT_FOUND;
      } else if (status === 422) {
        // Usually a requested permission/repository the installation was not granted.
        code = GITHUB_ERROR_CODES.FORBIDDEN;
      } else if (status === 429) {
        code = GITHUB_ERROR_CODES.RATE_LIMITED;
      } else if (status >= 500) {
        code = GITHUB_ERROR_CODES.SERVER_ERROR;
      }

      throw new GitHubApiError(`GitHub API Error [${status}] requesting installation token: ${apiMessage}`, {
        code,
        status,
        endpoint,
        data: parsed,
      });
    }

    if (!parsed || typeof parsed.token !== 'string' || !parsed.token.trim()) {
      throw new GitHubApiError('GitHub API returned an invalid or missing installation token.', {
        code: GITHUB_ERROR_CODES.HTTP_ERROR,
        endpoint,
      });
    }

    const expiresAt = parsed.expires_at ? new Date(parsed.expires_at) : null;

    return {
      token: parsed.token.trim(),
      expiresAt: expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt : null,
      permissions: parsed.permissions || {},
      repositorySelection: parsed.repository_selection || 'all',
    };
  }

  /**
   * Returns an unscoped installation token, reusing a cached one until it is
   * within TOKEN_REFRESH_MARGIN_MS of expiry. Tokens never leave server memory.
   *
   * @param {string|number} installationId
   * @param {Object} [options]
   * @param {boolean} [options.forceRefresh=false]
   * @param {() => number} [options.now] - Clock override for tests.
   * @returns {Promise<{ token: string, expiresAt: Date|null, permissions: Object, repositorySelection: string }>}
   */
  async getInstallationToken(installationId, options = {}) {
    const id = validateInstallationId(installationId);
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const cached = this.#tokenCache.get(id);

    if (!options.forceRefresh && cached && cached.expiresAt
      && cached.expiresAt.getTime() - now > TOKEN_REFRESH_MARGIN_MS) {
      return cached;
    }

    const fresh = await this.createInstallationToken(id);
    this.#tokenCache.set(id, fresh);
    return fresh;
  }

  /**
   * Builds a GitHubClient authenticated strictly with an installation token.
   * The token is always passed explicitly, so the client can never fall back
   * to process.env.GITHUB_TOKEN.
   *
   * @param {string|number} installationId
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @param {boolean} [options.forceRefresh]
   * @returns {Promise<{ client: GitHubClient, expiresAt: Date|null, permissions: Object, repositorySelection: string }>}
   */
  async createInstallationClient(installationId, options = {}) {
    const auth = await this.getInstallationToken(installationId, { forceRefresh: options.forceRefresh });
    const cfg = this.#getConfig();

    const client = new GitHubClient({
      token: auth.token,
      baseUrl: cfg.baseUrl,
      timeoutMs: typeof options.timeoutMs === 'number' ? options.timeoutMs : this.timeoutMs,
      fetchFn: this.fetchFn,
    });

    return {
      client,
      expiresAt: auth.expiresAt,
      permissions: auth.permissions,
      repositorySelection: auth.repositorySelection,
    };
  }
}
