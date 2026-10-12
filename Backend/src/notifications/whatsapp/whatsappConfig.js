/**
 * WhatsApp Web Configuration Resolver and Validator
 */

import path from 'node:path';
import { WhatsAppConfigError } from './whatsappErrors.js';

export const SUPPORTED_BROWSERS = Object.freeze(['chrome', 'firefox', 'edge']);

/**
 * Resolves and validates WhatsApp Web configuration.
 * 
 * @param {object} [rawConfig={}]
 * @returns {object} Validated config object
 */
export function resolveWhatsAppConfig(rawConfig = {}) {
  const env = process.env;

  const enabled = rawConfig.enabled !== undefined
    ? Boolean(rawConfig.enabled)
    : env.WHATSAPP_WEB_ENABLED === 'true';

  const browser = (rawConfig.browser || env.WHATSAPP_WEB_BROWSER || 'chrome').toLowerCase();

  const profileDir = rawConfig.profileDir || env.WHATSAPP_WEB_PROFILE_DIR || '.whatsapp-sessions';

  const headless = rawConfig.headless !== undefined
    ? Boolean(rawConfig.headless)
    : env.WHATSAPP_WEB_HEADLESS === 'true';

  const navigationTimeoutMs = Number(
    rawConfig.navigationTimeoutMs ?? env.WHATSAPP_WEB_NAVIGATION_TIMEOUT_MS ?? 30000
  );

  const actionTimeoutMs = Number(
    rawConfig.actionTimeoutMs ?? env.WHATSAPP_WEB_ACTION_TIMEOUT_MS ?? 15000
  );

  const authCheckTimeoutMs = Number(
    rawConfig.authCheckTimeoutMs ?? env.WHATSAPP_WEB_AUTH_CHECK_TIMEOUT_MS ?? 10000
  );

  const resolved = {
    enabled,
    browser,
    profileDir: path.isAbsolute(profileDir) ? profileDir : path.resolve(process.cwd(), profileDir),
    headless,
    navigationTimeoutMs,
    actionTimeoutMs,
    authCheckTimeoutMs,
  };

  validateWhatsAppConfig(resolved);

  return {
    ...resolved,
    navigationTimeoutMs: Math.max(1000, navigationTimeoutMs),
    actionTimeoutMs: Math.max(1000, actionTimeoutMs),
    authCheckTimeoutMs: Math.max(1000, authCheckTimeoutMs),
  };
}

/**
 * Validates the WhatsApp configuration.
 * 
 * @param {object} config
 */
export function validateWhatsAppConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new WhatsAppConfigError('WhatsApp configuration must be a non-null object.');
  }

  // When disabled, relaxed validation
  if (!config.enabled) {
    return;
  }

  if (!SUPPORTED_BROWSERS.includes(config.browser)) {
    throw new WhatsAppConfigError(
      `Unsupported browser '${config.browser}'. Supported browsers are: ${SUPPORTED_BROWSERS.join(', ')}.`
    );
  }

  if (!config.profileDir || typeof config.profileDir !== 'string') {
    throw new WhatsAppConfigError('WHATSAPP_WEB_PROFILE_DIR must be a non-empty directory path.');
  }

  if (typeof config.navigationTimeoutMs !== 'number' || config.navigationTimeoutMs <= 0) {
    throw new WhatsAppConfigError('WHATSAPP_WEB_NAVIGATION_TIMEOUT_MS must be a positive integer.');
  }

  if (typeof config.actionTimeoutMs !== 'number' || config.actionTimeoutMs <= 0) {
    throw new WhatsAppConfigError('WHATSAPP_WEB_ACTION_TIMEOUT_MS must be a positive integer.');
  }
}
