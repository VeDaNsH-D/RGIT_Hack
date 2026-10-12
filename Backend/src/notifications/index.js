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
