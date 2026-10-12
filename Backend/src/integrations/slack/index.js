/**
 * @file index.js
 * @description Slack Integration Module Barrel Export
 */

export { SlackConnector } from './connector.js';
export {
  SlackClient,
  SlackError,
  SlackClientError,
  SlackAuthenticationError,
  SlackPermissionError,
  SlackRateLimitError,
  SlackNotFoundError,
  SlackValidationError,
} from './client.js';
export {
  formatSlackText,
  extractTextFromBlocks,
  extractMessageText,
  parseSlackTs,
  constructMessageUrl,
} from './extractor.js';
export {
  normalizeSlackMessage,
  normalizeSlackMessageCandidate,
} from './normalizer.js';
