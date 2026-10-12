/**
 * @file index.js
 * @description Ingestion Slack provider public exports.
 */

export { SlackConnector } from './slackConnector.js';
export { SlackClient } from './slackClient.js';
export {
  SlackClientError,
  SlackError,
  SlackAuthenticationError,
  SlackPermissionError,
  SlackRateLimitError,
  SlackNotFoundError,
  SlackValidationError,
} from './slackErrors.js';
export {
  formatSlackText,
  extractTextFromBlocks,
  extractMessageText,
  parseSlackTs,
  constructMessageUrl,
} from './slackExtractor.js';
export {
  normalizeSlackMessageCandidate,
  normalizeSlackMessage,
} from './slackNormalizer.js';
