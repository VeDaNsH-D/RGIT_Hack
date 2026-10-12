import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_DELIVERY_STATUS,
  NotificationService,
  InMemoryNotificationRepository,
  withRetry,
  RetryExhaustedError,
  isTransientError,
  sanitizeData,
  formatLogEntry,
  NotificationDeliveryDispatcher,
  NotificationValidationError,
  DuplicateNotificationEventError,
} from '../../src/notifications/index.js';

describe('Notification Reliability & Failure Handling Suite', () => {
  let repository;
  let service;

  beforeEach(() => {
    repository = new InMemoryNotificationRepository();
    service = new NotificationService({ repository });
  });

  describe('1. Repeated Event Processing Idempotency', () => {
    it('should not create duplicate notifications when same eventId is processed sequentially', async () => {
      const event = {
        eventId: 'evt_idempotent_001',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_rel_1',
        recipientUserId: 'usr_owner_1',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_rel_1',
        outgoingUserId: 'usr_sender_1',
      };

      const first = await service.processEvent(event);
      const second = await service.processEvent(event);
      const third = await service.processEvent(event);

      assert.equal(first.id, second.id);
      assert.equal(first.id, third.id);

      const all = await repository.findByRecipient('usr_owner_1');
      assert.equal(all.length, 1);
    });
  });

  describe('2. Concurrent Processing of the Same Event', () => {
    it('should handle concurrent attempts gracefully, returning the single winning record', async () => {
      const event = {
        eventId: 'evt_concurrent_002',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED,
        projectId: 'proj_rel_1',
        recipientUserId: 'usr_owner_1',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_rel_1',
        acceptedByUserId: 'usr_incoming_2',
      };

      // Launch multiple concurrent attempts to simulate race conditions
      const results = await Promise.all([
        service.processEvent(event),
        service.processEvent(event),
        service.processEvent(event),
      ]);

      const [res1, res2, res3] = results;
      assert.equal(res1.id, res2.id);
      assert.equal(res2.id, res3.id);
      assert.equal(res1.eventId, 'evt_concurrent_002');

      const stored = await repository.findByRecipient('usr_owner_1');
      assert.equal(stored.length, 1);
    });
  });

  describe('3. Distinct Events Processed Independently', () => {
    it('should isolate distinct events and assign unique records per event', async () => {
      const eventA = {
        eventId: 'evt_distinct_A',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_user_1',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_A',
        outgoingUserId: 'usr_lead',
      };

      const eventB = {
        eventId: 'evt_distinct_B',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_user_1',
        occurredAt: '2026-10-12T12:05:00Z',
        entityId: 'hnd_B',
        outgoingUserId: 'usr_lead',
      };

      const recordA = await service.processEvent(eventA);
      const recordB = await service.processEvent(eventB);

      assert.notEqual(recordA.id, recordB.id);
      assert.equal(recordA.eventId, 'evt_distinct_A');
      assert.equal(recordB.eventId, 'evt_distinct_B');

      const all = await repository.findByRecipient('usr_user_1');
      assert.equal(all.length, 2);
    });
  });

  describe('4. Invalid Events Not Retried', () => {
    it('should immediately fail permanent validation errors without retrying', async () => {
      let attempts = 0;
      const invalidEvent = {
        eventId: 'evt_invalid_envelope',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        // missing required fields
      };

      await assert.rejects(
        () =>
          withRetry(
            async () => {
              attempts++;
              return service.processEvent(invalidEvent);
            },
            {
              maxRetries: 3,
              sleepFn: async () => {}, // Instant mock sleep
            }
          ),
        NotificationValidationError
      );

      // Must fail immediately on attempt 1 without wastefully retrying
      assert.equal(attempts, 1);
    });
  });

  describe('5. Transient Failures and Recovery via withRetry', () => {
    it('should retry transient errors and succeed upon recovery', async () => {
      let attempts = 0;
      const transientError = new Error('Socket timeout ECONNRESET');
      transientError.code = 'ECONNRESET';

      const result = await withRetry(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw transientError;
          }
          return 'RECOVERED_SUCCESS';
        },
        {
          maxRetries: 3,
          initialDelayMs: 10,
          sleepFn: async () => {}, // Instant mock sleep
        }
      );

      assert.equal(result, 'RECOVERED_SUCCESS');
      assert.equal(attempts, 3);
    });
  });

  describe('6. Retry Exhaustion Handling', () => {
    it('should throw RetryExhaustedError with full attempt history when retries are exhausted', async () => {
      let attempts = 0;
      const persistentTransientError = new Error('ETIMEDOUT to cluster');
      persistentTransientError.code = 'ETIMEDOUT';

      await assert.rejects(
        () =>
          withRetry(
            async () => {
              attempts++;
              throw persistentTransientError;
            },
            {
              maxRetries: 2,
              sleepFn: async () => {}, // Instant mock sleep
            }
          ),
        (err) => {
          assert.equal(err.name, 'RetryExhaustedError');
          assert.equal(err.attempts, 3); // initial + 2 retries
          assert.equal(err.errors.length, 3);
          assert.equal(err.lastError.code, 'ETIMEDOUT');
          return true;
        }
      );

      assert.equal(attempts, 3);
    });
  });

  describe('7. Permanent Provider Failures in Dispatcher', () => {
    it('should transition deliveryStatus to FAILED on permanent provider failure', async () => {
      const permanentError = new Error('Invalid destination recipient account');
      permanentError.statusCode = 400; // Permanent 4xx error

      const failingProvider = {
        name: 'mock-external-provider',
        async send() {
          throw permanentError;
        },
      };

      const dispatcher = new NotificationDeliveryDispatcher({
        repository,
        providers: [failingProvider],
        retryOptions: { sleepFn: async () => {} },
      });

      const event = {
        eventId: 'evt_provider_fail_001',
        type: NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_lead',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'cnf_1',
        conflictType: 'DEADLINE_MISMATCH',
        description: 'Document conflict',
      };

      const notification = await service.processEvent(event);
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);

      const dispatchResult = await dispatcher.dispatch(notification);
      assert.equal(dispatchResult.success, false);
      assert.equal(dispatchResult.status, NOTIFICATION_DELIVERY_STATUS.FAILED);

      const updatedRecord = await repository.findById(notification.id);
      assert.equal(updatedRecord.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.FAILED);
    });
  });

  describe('8. Database Failures Handled Safely', () => {
    it('should bubble database repository errors predictably without leaking sensitive data', async () => {
      const failingRepo = {
        async findByEventId() {
          const err = new Error('MongoDB primary stepped down');
          err.code = 'ECONNREFUSED';
          throw err;
        },
        async create() {
          throw new Error('Write failed');
        },
      };

      const failingService = new NotificationService({ repository: failingRepo });
      const event = {
        eventId: 'evt_db_fail_001',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_lead',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_1',
        outgoingUserId: 'usr_out',
      };

      await assert.rejects(
        () => failingService.processEvent(event),
        (err) => {
          assert.equal(err.name, 'NotificationRepositoryError');
          assert.ok(err.message.includes('MongoDB primary stepped down'));
          return true;
        }
      );
    });
  });

  describe('9. Delivery-State Transitions (PENDING -> SENT / FAILED)', () => {
    it('should transition PENDING to SENT upon successful provider confirmation', async () => {
      const successfulProvider = {
        name: 'mock-channel-provider',
        async send() {
          return { success: true, externalId: 'ext_msg_98765' };
        },
      };

      const dispatcher = new NotificationDeliveryDispatcher({
        repository,
        providers: [successfulProvider],
      });

      const event = {
        eventId: 'evt_state_transition_001',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_out_1',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_1',
        acceptedByUserId: 'usr_in_1',
      };

      const notification = await service.processEvent(event);
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);

      const dispatchResult = await dispatcher.dispatch(notification);
      assert.equal(dispatchResult.success, true);
      assert.equal(dispatchResult.status, NOTIFICATION_DELIVERY_STATUS.SENT);

      const updated = await repository.findById(notification.id);
      assert.equal(updated.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.SENT);
    });
  });

  describe('10. No Duplicate Notifications Created After a Retry', () => {
    it('should ensure retry attempts do not duplicate notifications in repository', async () => {
      const event = {
        eventId: 'evt_retry_nodupe_001',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_rec_1',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_1',
        outgoingUserId: 'usr_out_1',
      };

      let attempt = 0;
      await withRetry(
        async () => {
          attempt++;
          // First attempt creates it, but simulates network drop on return
          const record = await service.processEvent(event);
          if (attempt === 1) {
            const simulatedDrop = new Error('Simulated network timeout');
            simulatedDrop.code = 'ETIMEDOUT';
            throw simulatedDrop;
          }
          return record;
        },
        {
          maxRetries: 2,
          sleepFn: async () => {},
        }
      );

      // Verify that after retry, only exactly one record was persisted
      const records = await repository.findByRecipient('usr_rec_1');
      assert.equal(records.length, 1);
    });
  });

  describe('11. Safe Logging and Redaction of Secrets', () => {
    it('should redact authorization headers, tokens, and passwords in structured logs', () => {
      const sensitiveContext = {
        eventId: 'evt_log_safe_001',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitivePayload',
        password: 'mySecretPassword123',
        authorization: 'Bearer super_secret_token',
        apiKey: 'sk_live_123456789',
        safeMetadata: 'public-data',
        nested: {
          jwtSecret: 'very_secret_key_long_string_here',
          normalField: 42,
        },
      };

      const sanitized = sanitizeData(sensitiveContext);

      assert.equal(sanitized.token, '[REDACTED]');
      assert.equal(sanitized.password, '[REDACTED]');
      assert.equal(sanitized.authorization, '[REDACTED]');
      assert.equal(sanitized.apiKey, '[REDACTED]');
      assert.equal(sanitized.nested.jwtSecret, '[REDACTED]');

      assert.equal(sanitized.eventId, 'evt_log_safe_001');
      assert.equal(sanitized.safeMetadata, 'public-data');
      assert.equal(sanitized.nested.normalField, 42);

      const logEntry = formatLogEntry('info', 'Test log message', sensitiveContext);
      assert.equal(logEntry.token, '[REDACTED]');
      assert.equal(logEntry.message, 'Test log message');
    });
  });

  describe('12. Batch Dispatch Partial Failure Isolation', () => {
    it('should ensure failure of one notification does not prevent other notifications from being dispatched', async () => {
      let callCount = 0;
      const flappyProvider = {
        name: 'flappy-provider',
        async send(n) {
          callCount++;
          if (n.id === 'rec_fail_item') {
            const err = new Error('Invalid channel address');
            err.statusCode = 400;
            throw err;
          }
          return { success: true, externalId: `ext_${n.id}` };
        },
      };

      const dispatcher = new NotificationDeliveryDispatcher({
        repository,
        providers: [flappyProvider],
        retryOptions: { sleepFn: async () => {} },
      });

      const notif1 = await service.processEvent({
        eventId: 'evt_batch_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_1',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_1',
        outgoingUserId: 'usr_out',
      });

      const notif2 = await service.processEvent({
        eventId: 'evt_batch_2',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_2',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_2',
        acceptedByUserId: 'usr_in',
      });
      notif2.id = 'rec_fail_item'; // Set to fail item

      const notif3 = await service.processEvent({
        eventId: 'evt_batch_3',
        type: NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_3',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'cnf_3',
        conflictType: 'STATUS_MISMATCH',
        description: 'Status disagreement',
      });

      const batchResults = await dispatcher.dispatchBatch([notif1, notif2, notif3]);

      assert.equal(batchResults.length, 3);
      assert.equal(batchResults[0].success, true);
      assert.equal(batchResults[0].status, NOTIFICATION_DELIVERY_STATUS.SENT);

      assert.equal(batchResults[1].success, false);
      assert.equal(batchResults[1].status, NOTIFICATION_DELIVERY_STATUS.FAILED);

      assert.equal(batchResults[2].success, true);
      assert.equal(batchResults[2].status, NOTIFICATION_DELIVERY_STATUS.SENT);
    });
  });
});
