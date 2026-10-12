/**
 * Core Notification Service
 * 
 * Processes validated domain events, applies deterministic presentation templates,
 * produces standardized notification records, and coordinates with the repository.
 */

import crypto from 'node:crypto';
import { NOTIFICATION_DELIVERY_STATUS } from './records.js';
import {
  assertValidNotificationEvent,
  assertValidNotificationRecord,
} from './validation.js';
import { renderNotificationTemplate } from './templates.js';
import { NotificationRepositoryError } from './repository.js';

export class NotificationServiceError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NotificationServiceError';
    if (cause) this.cause = cause;
  }
}

export class DuplicateNotificationEventError extends NotificationServiceError {
  constructor(eventId, existingRecord) {
    super(`Notification event with eventId '${eventId}' has already been processed.`);
    this.name = 'DuplicateNotificationEventError';
    this.eventId = eventId;
    this.existingRecord = existingRecord;
  }
}

/**
 * Core Notification Service implementation.
 */
export class NotificationService {
  /**
   * @param {object} config
   * @param {object} config.repository Storage-agnostic notification repository
   * @param {() => string} [config.idGenerator] Custom notification ID generator function
   */
  constructor({ repository, idGenerator } = {}) {
    if (!repository || typeof repository.create !== 'function') {
      throw new TypeError("NotificationService requires a repository implementing 'create(record)'.");
    }

    this.repository = repository;
    this.idGenerator = idGenerator || (() => `notif_${crypto.randomUUID()}`);
  }

  /**
   * Processes a notification event, renders presentation content, validates the record,
   * and persists it to the configured repository.
   * 
   * @param {import('./events.js').NotificationEvent} event
   * @param {object} [options={}]
   * @param {boolean} [options.throwOnDuplicate=false] If true, throws DuplicateNotificationEventError when eventId exists
   * @returns {Promise<import('./records.js').NotificationRecord>}
   */
  async processEvent(event, options = {}) {
    // 1. Deterministic validation of the incoming domain event
    assertValidNotificationEvent(event);

    // 2. Check for duplicate event processing if repository supports eventId lookup
    if (typeof this.repository.findByEventId === 'function') {
      try {
        const existingRecord = await this.repository.findByEventId(event.eventId);
        if (existingRecord) {
          if (options.throwOnDuplicate) {
            throw new DuplicateNotificationEventError(event.eventId, existingRecord);
          }
          // Idempotent return of the already generated notification
          return existingRecord;
        }
      } catch (err) {
        if (err instanceof DuplicateNotificationEventError) {
          throw err;
        }
        throw new NotificationRepositoryError(
          `Failed to check duplicate eventId '${event.eventId}': ${err.message}`,
          err
        );
      }
    }

    // 3. Centralized presentation template rendering
    const { title, message } = renderNotificationTemplate(event);

    // 4. Construct standard notification record
    const notificationId = this.idGenerator();
    const nowIso = new Date().toISOString();

    const record = {
      id: notificationId,
      recipientUserId: event.recipientUserId,
      eventId: event.eventId,
      type: event.type,
      title,
      message,
      projectId: event.projectId,
      entityId: event.entityId,
      readAt: null,
      createdAt: nowIso,
      deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
    };

    // 5. Strict contract validation of the generated notification record
    assertValidNotificationRecord(record);

    // 6. Persist through the storage abstraction
    try {
      const savedRecord = await this.repository.create(record);
      return savedRecord;
    } catch (err) {
      if (err instanceof NotificationRepositoryError) {
        throw err;
      }
      throw new NotificationRepositoryError(
        `Failed to persist notification record '${record.id}': ${err.message}`,
        err
      );
    }
  }

  /**
   * Retrieves a notification record by ID.
   * 
   * @param {string} id
   * @returns {Promise<import('./records.js').NotificationRecord | null>}
   */
  async getNotificationById(id) {
    if (typeof this.repository.findById !== 'function') {
      throw new NotificationServiceError("Configured repository does not support 'findById'.");
    }
    return this.repository.findById(id);
  }

  /**
   * Retrieves notifications intended for a specific recipient user.
   * 
   * @param {string} recipientUserId
   * @param {object} [options]
   * @returns {Promise<import('./records.js').NotificationRecord[]>}
   */
  async getNotificationsForRecipient(recipientUserId, options = {}) {
    if (typeof this.repository.findByRecipient !== 'function') {
      throw new NotificationServiceError("Configured repository does not support 'findByRecipient'.");
    }
    return this.repository.findByRecipient(recipientUserId, options);
  }
}
