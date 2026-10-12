/**
 * Notification Delivery Dispatcher
 * 
 * Coordinates delivery across configured providers, enforces delivery state transitions
 * (PENDING -> SENT or FAILED), and protects against partial/cascading batch failures.
 */

import { NOTIFICATION_DELIVERY_STATUS } from '../records.js';
import { withRetry, isTransientError } from './retry.js';
import { logNotification } from './logger.js';

/**
 * @typedef {object} DeliveryProvider
 * @property {string} name Provider name (e.g., 'in-app', 'mock-whatsapp')
 * @property {(notification: import('../records.js').NotificationRecord) => Promise<{ success: boolean, externalId?: string }>} send
 */

export class NotificationDeliveryDispatcher {
  /**
   * @param {object} config
   * @param {object} config.repository Storage repository with updateDeliveryStatus
   * @param {DeliveryProvider[]} [config.providers=[]] Configured delivery providers
   * @param {object} [config.retryOptions={}] Bounded retry options
   */
  constructor({ repository, providers = [], retryOptions = {} } = {}) {
    if (!repository) {
      throw new TypeError('NotificationDeliveryDispatcher requires a repository.');
    }

    this.repository = repository;
    this.providers = providers;
    this.retryOptions = retryOptions;
  }

  /**
   * Registers a delivery provider.
   * @param {DeliveryProvider} provider
   */
  registerProvider(provider) {
    if (!provider || typeof provider.send !== 'function') {
      throw new TypeError("Provider must implement 'send(notification)' method.");
    }
    this.providers.push(provider);
  }

  /**
   * Dispatches a single notification through registered providers with bounded retry
   * and safe state transition recording.
   * 
   * @param {import('../records.js').NotificationRecord} notification
   * @returns {Promise<{ success: boolean, status: string, results: object[] }>}
   */
  async dispatch(notification) {
    if (!notification || !notification.id) {
      throw new TypeError('Cannot dispatch an invalid notification record.');
    }

    if (this.providers.length === 0) {
      // If no external providers configured, notification remains in its initial stored state
      return {
        success: true,
        status: notification.deliveryStatus || NOTIFICATION_DELIVERY_STATUS.PENDING,
        results: [],
      };
    }

    const providerResults = [];
    let hasFailed = false;
    let lastError = null;

    for (const provider of this.providers) {
      try {
        const sendResult = await withRetry(
          () => provider.send(notification),
          {
            ...this.retryOptions,
            onRetry: (attempt, err, delayMs) => {
              logNotification('warn', `Retrying delivery for notification ${notification.id} via ${provider.name}`, {
                notificationId: notification.id,
                eventId: notification.eventId,
                provider: provider.name,
                attempt,
                delayMs,
                error: err.message,
              });
              if (this.retryOptions.onRetry) {
                this.retryOptions.onRetry(attempt, err, delayMs);
              }
            },
          }
        );

        providerResults.push({
          provider: provider.name,
          success: true,
          externalId: sendResult?.externalId,
        });
      } catch (err) {
        hasFailed = true;
        lastError = err;
        providerResults.push({
          provider: provider.name,
          success: false,
          error: err.message,
          isTransient: isTransientError(err),
        });

        logNotification('error', `Delivery failed for notification ${notification.id} via ${provider.name}`, {
          notificationId: notification.id,
          eventId: notification.eventId,
          provider: provider.name,
          error: err.message,
        });
      }
    }

    // Determine finalized state transition
    const finalStatus = hasFailed
      ? NOTIFICATION_DELIVERY_STATUS.FAILED
      : NOTIFICATION_DELIVERY_STATUS.SENT;

    if (typeof this.repository.updateDeliveryStatus === 'function') {
      try {
        await this.repository.updateDeliveryStatus(notification.id, finalStatus, {
          updatedAt: new Date().toISOString(),
          providerResults,
          error: lastError ? lastError.message : undefined,
        });
      } catch (repoErr) {
        logNotification('error', `Failed to update deliveryStatus for ${notification.id}`, {
          notificationId: notification.id,
          error: repoErr.message,
        });
      }
    }

    return {
      success: !hasFailed,
      status: finalStatus,
      results: providerResults,
      error: lastError,
    };
  }

  /**
   * Dispatches a batch of notifications, ensuring partial failure isolation
   * so one failure does not abort processing of other notifications.
   * 
   * @param {import('../records.js').NotificationRecord[]} notifications
   * @returns {Promise<Array<{ notificationId: string, success: boolean, status: string }>>}
   */
  async dispatchBatch(notifications) {
    if (!Array.isArray(notifications)) return [];

    const outcomes = await Promise.allSettled(
      notifications.map(async (n) => {
        const res = await this.dispatch(n);
        return {
          notificationId: n.id,
          success: res.success,
          status: res.status,
          error: res.error,
        };
      })
    );

    return outcomes.map((outcome, idx) => {
      if (outcome.status === 'fulfilled') {
        return outcome.value;
      }
      return {
        notificationId: notifications[idx].id,
        success: false,
        status: NOTIFICATION_DELIVERY_STATUS.FAILED,
        error: outcome.reason,
      };
    });
  }
}
