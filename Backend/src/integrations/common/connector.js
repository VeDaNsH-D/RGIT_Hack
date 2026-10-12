/**
 * @file connector.js
 * @description Standardized base interface for all external integration adapters.
 */

import { IntegrationError } from './errors.js';
import { createSyncResult, SYNC_STATUS } from './results.js';

/**
 * Abstract BaseConnector class.
 * All provider adapters (Notion, Jira, Slack, etc.) extend this class to provide
 * uniform provider identification, configuration validation, connection verification,
 * and structured sync execution.
 */
export class BaseConnector {
  /**
   * Unique lowercase identifier of the external provider ('notion', 'jira', 'slack').
   * @returns {string}
   */
  get provider() {
    throw new Error(`${this.constructor.name} must implement getter 'provider'.`);
  }

  /**
   * Validates that the provided configuration has all required tokens, hosts, and settings.
   *
   * @param {object} [config={}]
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateConfig(config = {}) {
    throw new Error(`${this.constructor.name} must implement validateConfig().`);
  }

  /**
   * Verifies credentials and connectivity by contacting the provider's API.
   * Must not leak credentials on failure.
   *
   * @returns {Promise<{ ok: boolean, error?: string, details?: object }>}
   */
  async verifyConnection() {
    throw new Error(`${this.constructor.name} must implement verifyConnection().`);
  }

  /**
   * Performs an authorized content sync and returns a standardized SyncResult.
   *
   * @param {object} [options={}]
   * @returns {Promise<ReturnType<typeof createSyncResult>>}
   */
  async sync(options = {}) {
    throw new Error(`${this.constructor.name} must implement sync().`);
  }
}

/**
 * Asserts that an object or class instance satisfies the common connector interface contract.
 *
 * @param {unknown} connector
 * @returns {boolean}
 */
export function isConnector(connector) {
  if (!connector || typeof connector !== 'object') {
    return false;
  }
  const hasProvider = typeof connector.provider === 'string' && connector.provider.trim().length > 0;
  const hasValidate = typeof connector.validateConfig === 'function';
  const hasVerify = typeof connector.verifyConnection === 'function';
  const hasSync = typeof connector.sync === 'function';

  return hasProvider && hasValidate && hasVerify && hasSync;
}
