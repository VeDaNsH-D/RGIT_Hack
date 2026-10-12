/**
 * Relay Notifications Module
 * 
 * Re-exports notification contracts, envelope definitions, record schemas,
 * and deterministic validation helpers.
 */

export {
  NOTIFICATION_EVENT_TYPES,
  EVENT_RECIPIENT_ROLES,
  COMMON_ENVELOPE_FIELDS,
  EVENT_SPECIFIC_FIELDS,
} from './events.js';

export {
  NOTIFICATION_DELIVERY_STATUS,
  NOTIFICATION_RECORD_FIELDS,
} from './records.js';

export {
  NotificationValidationError,
  isNonEmptyString,
  isValidIso8601,
  validateNotificationEvent,
  assertValidNotificationEvent,
  validateNotificationRecord,
  assertValidNotificationRecord,
} from './validation.js';

export {
  renderNotificationTemplate,
  UnsupportedTemplateEventError,
} from './templates.js';

export {
  NotificationRepositoryError,
  InMemoryNotificationRepository,
} from './repository.js';

export {
  NotificationService,
  NotificationServiceError,
  DuplicateNotificationEventError,
} from './service.js';

export { MongooseNotificationRepository } from './mongooseRepository.js';

export {
  createNotificationRouter,
  notificationRouter,
} from './routes.js';

export {
  RetryExhaustedError,
  isTransientError,
  withRetry,
} from './reliability/retry.js';

export {
  sanitizeData,
  formatLogEntry,
  logNotification,
} from './reliability/logger.js';

export {
  NotificationDeliveryDispatcher,
} from './reliability/dispatcher.js';

export {
  WhatsAppWebSeleniumAdapter,
  WHATSAPP_ERROR_CODES,
  WhatsAppAdapterError,
  WhatsAppConfigError,
  WhatsAppAdapterDisabledError,
  BrowserStartupError,
  WhatsAppLoginRequiredError,
  InvalidRecipientError,
  RecipientVerificationError,
  WhatsAppUIElementNotFoundError,
  WhatsAppSendFailedError,
  BrowserCrashedError,
  AmbiguousSendOutcomeError,
} from './whatsapp/index.js';



