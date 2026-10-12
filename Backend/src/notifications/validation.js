/**
 * Notification Contract & Record Validation
 * 
 * Provides deterministic, dependency-free validation for notification event
 * payloads and notification records.
 */

import {
  NOTIFICATION_EVENT_TYPES,
  COMMON_ENVELOPE_FIELDS,
  EVENT_SPECIFIC_FIELDS,
} from './events.js';
import {
  NOTIFICATION_DELIVERY_STATUS,
  NOTIFICATION_RECORD_FIELDS,
} from './records.js';

export class NotificationValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'NotificationValidationError';
    this.errors = errors;
  }
}

/**
 * Validates whether a value is a non-empty string.
 * @param {unknown} val
 * @returns {boolean}
 */
export function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

/**
 * Strict ISO 8601 timestamp validation (e.g., 2026-10-12T12:00:00Z or 2026-10-12T12:00:00.000Z).
 * Ensures correct syntax, valid calendar dates, and no JS Date rollover.
 * @param {unknown} val
 * @returns {boolean}
 */
export function isValidIso8601(val) {
  if (typeof val !== 'string') return false;
  const isoRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-]\d{2}):?(\d{2}))$/;
  const match = val.match(isoRegex);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) return false;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;

  // Verify calendar day bounds (e.g. leap years, 30 vs 31 days)
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() + 1 !== month ||
    utcDate.getUTCDate() !== day
  ) {
    return false;
  }

  const parsed = Date.parse(val);
  return !Number.isNaN(parsed);
}

/**
 * Validates a Notification Event against its common envelope and event-specific schema.
 * 
 * @param {unknown} event
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateNotificationEvent(event) {
  const errors = [];

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return {
      valid: false,
      errors: ['Event must be a non-null object.'],
    };
  }

  // Validate common envelope fields presence and type
  for (const field of COMMON_ENVELOPE_FIELDS) {
    if (field === 'occurredAt') {
      if (!isValidIso8601(event[field])) {
        errors.push(`Field 'occurredAt' must be a valid ISO 8601 timestamp string.`);
      }
    } else if (field === 'type') {
      if (!Object.values(NOTIFICATION_EVENT_TYPES).includes(event[field])) {
        errors.push(
          `Field 'type' has unsupported value '${event[field]}'. Must be one of: ${Object.values(
            NOTIFICATION_EVENT_TYPES
          ).join(', ')}.`
        );
      }
    } else {
      if (!isNonEmptyString(event[field])) {
        errors.push(`Envelope field '${field}' is required and must be a non-empty string.`);
      }
    }
  }

  // If type is valid, check event-specific required fields
  const eventType = event.type;
  if (eventType && EVENT_SPECIFIC_FIELDS[eventType]) {
    const specs = EVENT_SPECIFIC_FIELDS[eventType];
    for (const reqField of specs.required) {
      if (!isNonEmptyString(event[reqField])) {
        errors.push(
          `Event-specific field '${reqField}' is required for type '${eventType}' and must be a non-empty string.`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Asserts that a Notification Event is valid, throwing NotificationValidationError if invalid.
 * @param {unknown} event
 */
export function assertValidNotificationEvent(event) {
  const { valid, errors } = validateNotificationEvent(event);
  if (!valid) {
    throw new NotificationValidationError(
      `Invalid notification event: ${errors.join('; ')}`,
      errors
    );
  }
}

/**
 * Validates a Notification Record.
 * 
 * @param {unknown} record
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateNotificationRecord(record) {
  const errors = [];

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return {
      valid: false,
      errors: ['Notification record must be a non-null object.'],
    };
  }

  const stringFields = [
    'id',
    'recipientUserId',
    'eventId',
    'title',
    'message',
    'projectId',
    'entityId',
  ];

  for (const field of stringFields) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`Field '${field}' is required and must be a non-empty string.`);
    }
  }

  // Validate type
  if (!Object.values(NOTIFICATION_EVENT_TYPES).includes(record.type)) {
    errors.push(
      `Field 'type' has unsupported value '${record.type}'. Must be one of: ${Object.values(
        NOTIFICATION_EVENT_TYPES
      ).join(', ')}.`
    );
  }

  // Validate createdAt
  if (!isValidIso8601(record.createdAt)) {
    errors.push(`Field 'createdAt' must be a valid ISO 8601 timestamp string.`);
  }

  // Validate readAt (nullable)
  if (record.readAt !== null && record.readAt !== undefined && !isValidIso8601(record.readAt)) {
    errors.push(`Field 'readAt' must be null or a valid ISO 8601 timestamp string.`);
  }

  // Validate deliveryStatus
  if (!Object.values(NOTIFICATION_DELIVERY_STATUS).includes(record.deliveryStatus)) {
    errors.push(
      `Field 'deliveryStatus' has invalid value '${record.deliveryStatus}'. Must be one of: ${Object.values(
        NOTIFICATION_DELIVERY_STATUS
      ).join(', ')}.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Asserts that a Notification Record is valid, throwing NotificationValidationError if invalid.
 * @param {unknown} record
 */
export function assertValidNotificationRecord(record) {
  const { valid, errors } = validateNotificationRecord(record);
  if (!valid) {
    throw new NotificationValidationError(
      `Invalid notification record: ${errors.join('; ')}`,
      errors
    );
  }
}
