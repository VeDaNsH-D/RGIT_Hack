import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_DELIVERY_STATUS,
  NotificationService,
  InMemoryNotificationRepository,
  renderNotificationTemplate,
  UnsupportedTemplateEventError,
  NotificationValidationError,
  NotificationRepositoryError,
  DuplicateNotificationEventError,
} from '../../src/notifications/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../../fixtures');

function loadFixture(filename) {
  const filePath = path.join(fixturesDir, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('Core Notification Service & Repository Suite', () => {
  let repository;
  let service;

  beforeEach(() => {
    repository = new InMemoryNotificationRepository();
    service = new NotificationService({ repository });
  });

  describe('1. Successful Processing of All 4 Supported Event Types', () => {
    it('should process HANDOFF_SUBMITTED fixture and produce valid record', async () => {
      const event = loadFixture('handoff-submitted.json');
      const notification = await service.processEvent(event);

      assert.ok(notification.id);
      assert.equal(notification.recipientUserId, event.recipientUserId);
      assert.equal(notification.eventId, event.eventId);
      assert.equal(notification.type, NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED);
      assert.equal(notification.projectId, event.projectId);
      assert.equal(notification.entityId, event.entityId);
      assert.equal(notification.readAt, null);
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);
      assert.ok(notification.title.includes('Handoff Submitted'));
      assert.ok(notification.message.includes(event.outgoingUserId));

      const stored = await repository.findById(notification.id);
      assert.deepEqual(stored, notification);
    });

    it('should process HANDOFF_ACCEPTED fixture and produce valid record', async () => {
      const event = loadFixture('handoff-accepted.json');
      const notification = await service.processEvent(event);

      assert.ok(notification.id);
      assert.equal(notification.recipientUserId, event.recipientUserId);
      assert.equal(notification.eventId, event.eventId);
      assert.equal(notification.type, NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED);
      assert.ok(notification.title.includes('Handoff Accepted'));
      assert.ok(notification.message.includes(event.acceptedByUserId));
      assert.equal(notification.readAt, null);
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);
    });

    it('should process HANDOFF_NEEDS_CLARIFICATION fixture and produce valid record', async () => {
      const event = loadFixture('clarification-requested.json');
      const notification = await service.processEvent(event);

      assert.ok(notification.id);
      assert.equal(notification.recipientUserId, event.recipientUserId);
      assert.equal(notification.eventId, event.eventId);
      assert.equal(notification.type, NOTIFICATION_EVENT_TYPES.HANDOFF_NEEDS_CLARIFICATION);
      assert.ok(notification.title.includes('Clarification Requested'));
      assert.ok(notification.message.includes(event.clarificationNote));
      assert.equal(notification.readAt, null);
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);
    });

    it('should process CRITICAL_CONFLICT_DETECTED fixture and produce valid record', async () => {
      const event = loadFixture('conflict-detected.json');
      const notification = await service.processEvent(event);

      assert.ok(notification.id);
      assert.equal(notification.recipientUserId, event.recipientUserId);
      assert.equal(notification.eventId, event.eventId);
      assert.equal(notification.type, NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED);
      assert.ok(notification.title.includes('Conflict Detected'));
      assert.ok(notification.message.includes(event.conflictType));
      assert.ok(notification.message.includes(event.description));
      assert.equal(notification.readAt, null);
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);
    });

    it('should process HANDOFF_ACKNOWLEDGED fixture and produce valid record', async () => {
      const event = loadFixture('handoff-acknowledged.json');
      const notification = await service.processEvent(event);

      assert.ok(notification.id);
      assert.equal(notification.type, NOTIFICATION_EVENT_TYPES.HANDOFF_ACKNOWLEDGED);
      assert.ok(notification.title.includes('Handoff Acknowledged'));
      assert.ok(notification.message.includes(event.acknowledgedByUserId));
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);
    });

    it('should process HANDOFF_CLARIFICATION_ANSWERED fixture and produce valid record', async () => {
      const event = loadFixture('clarification-answered.json');
      const notification = await service.processEvent(event);

      assert.ok(notification.id);
      assert.equal(notification.type, NOTIFICATION_EVENT_TYPES.HANDOFF_CLARIFICATION_ANSWERED);
      assert.ok(notification.title.includes('Clarification Answered'));
      assert.ok(notification.message.includes(event.answeredByUserId));
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);
    });

    it('should process HANDOFF_ACK_OVERDUE fixture and produce valid record', async () => {
      const event = loadFixture('handoff-ack-overdue.json');
      const notification = await service.processEvent(event);

      assert.ok(notification.id);
      assert.equal(notification.type, NOTIFICATION_EVENT_TYPES.HANDOFF_ACK_OVERDUE);
      assert.ok(notification.title.includes('Acknowledgment Overdue'));
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);
    });

    it('should process TASK_OVERDUE fixture and produce valid record', async () => {
      const event = loadFixture('task-overdue.json');
      const notification = await service.processEvent(event);

      assert.ok(notification.id);
      assert.equal(notification.type, NOTIFICATION_EVENT_TYPES.TASK_OVERDUE);
      assert.ok(notification.title.includes('Task Overdue'));
      assert.ok(notification.message.includes(event.taskId));
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);
    });

    it('should process CONFLICT_RESOLVED fixture and produce valid record', async () => {
      const event = loadFixture('conflict-resolved.json');
      const notification = await service.processEvent(event);

      assert.ok(notification.id);
      assert.equal(notification.type, NOTIFICATION_EVENT_TYPES.CONFLICT_RESOLVED);
      assert.ok(notification.title.includes('Conflict Resolved'));
      assert.ok(notification.message.includes(event.resolvedByUserId));
      assert.equal(notification.deliveryStatus, NOTIFICATION_DELIVERY_STATUS.PENDING);
    });

    it('should normalize and process payload-wrapped events from schema adapter', async () => {
      const wrappedEvent = {
        type: 'TASK_OVERDUE',
        recipientUserId: 'usr_task_owner_999',
        projectId: 'proj_relay_101',
        payload: {
          taskId: 'tsk_999',
          taskTitle: 'Database Migration',
          dueDate: '2026-10-12T00:00:00Z',
        },
        dedupeKey: 'dedupe_task_999',
      };

      const notification = await service.processEvent(wrappedEvent);
      assert.ok(notification.id);
      assert.equal(notification.eventId, 'dedupe_task_999');
      assert.equal(notification.entityId, 'tsk_999');
      assert.equal(notification.type, 'TASK_OVERDUE');
      assert.ok(notification.title.includes('Task Overdue'));
    });
  });

  describe('2. Recipient and Event Metadata Integrity', () => {
    it('should accurately preserve all envelope identifiers and metadata', async () => {
      const event = {
        eventId: 'evt_custom_meta_999',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_meta_project_alpha',
        recipientUserId: 'usr_target_recipient_123',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_custom_999',
        outgoingUserId: 'usr_outgoing_sender_456',
      };

      const notification = await service.processEvent(event);
      assert.equal(notification.recipientUserId, 'usr_target_recipient_123');
      assert.equal(notification.projectId, 'proj_meta_project_alpha');
      assert.equal(notification.entityId, 'hnd_custom_999');
      assert.equal(notification.eventId, 'evt_custom_meta_999');
      assert.ok(notification.createdAt);
    });
  });

  describe('3. Template Formatting & Determinism', () => {
    it('should format templates deterministically without fabricating details', () => {
      const event = {
        eventId: 'evt_tmpl_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_core',
        recipientUserId: 'usr_rec',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_1',
        outgoingUserId: 'usr_sender',
        handoffTitle: 'Feature Rollout',
      };

      const { title, message } = renderNotificationTemplate(event);
      assert.equal(title, 'Project Handoff Submitted');
      assert.ok(message.includes("('Feature Rollout')"));
      assert.ok(message.includes('usr_sender'));
      assert.ok(message.includes('proj_core'));
      assert.ok(message.includes('hnd_1'));
    });

    it('should reject unsupported event types in template rendering', () => {
      assert.throws(
        () => renderNotificationTemplate({ type: 'NON_EXISTENT_TYPE' }),
        UnsupportedTemplateEventError
      );
    });
  });

  describe('4. Default Values for readAt and deliveryStatus', () => {
    it('must initialize readAt as null and deliveryStatus as PENDING', async () => {
      const event = loadFixture('handoff-submitted.json');
      const notification = await service.processEvent(event);

      assert.strictEqual(notification.readAt, null);
      assert.strictEqual(notification.deliveryStatus, 'PENDING');
    });
  });

  describe('5. Invalid Event Rejection', () => {
    it('should reject events missing required envelope fields', async () => {
      const badEvent = {
        eventId: 'evt_bad',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        // missing projectId, recipientUserId, occurredAt, entityId
      };

      await assert.rejects(
        () => service.processEvent(badEvent),
        NotificationValidationError
      );
    });

    it('should reject events missing event-specific required fields', async () => {
      const badSubmitted = {
        eventId: 'evt_bad_sub',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_1',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_1',
        // missing outgoingUserId
      };

      await assert.rejects(
        () => service.processEvent(badSubmitted),
        NotificationValidationError
      );
    });
  });

  describe('6. Unsupported Event Rejection', () => {
    it('should reject unknown event types before generating records', async () => {
      const unknownEvent = {
        eventId: 'evt_unk',
        type: 'UNSUPPORTED_RANDOM_TYPE',
        projectId: 'proj_1',
        recipientUserId: 'usr_1',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'ent_1',
      };

      await assert.rejects(
        () => service.processEvent(unknownEvent),
        NotificationValidationError
      );
    });
  });

  describe('7. Repository Failure Handling', () => {
    it('should throw NotificationRepositoryError when repository fails to persist', async () => {
      const failingRepo = {
        async findByEventId() {
          return null;
        },
        async create() {
          throw new Error('Database connection lost');
        },
      };

      const failingService = new NotificationService({ repository: failingRepo });
      const event = loadFixture('handoff-submitted.json');

      await assert.rejects(
        () => failingService.processEvent(event),
        (err) => {
          assert.equal(err.name, 'NotificationRepositoryError');
          assert.ok(err.message.includes('Database connection lost'));
          return true;
        }
      );
    });
  });

  describe('8. Notification Isolation Between Different Recipients', () => {
    it('should only return notifications belonging to the requested recipient', async () => {
      const eventUserA1 = {
        eventId: 'evt_userA_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_alice',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_1',
        outgoingUserId: 'usr_lead',
      };

      const eventUserA2 = {
        eventId: 'evt_userA_2',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_alice',
        occurredAt: '2026-10-12T12:05:00Z',
        entityId: 'hnd_1',
        acceptedByUserId: 'usr_lead',
      };

      const eventUserB = {
        eventId: 'evt_userB_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_2',
        recipientUserId: 'usr_bob',
        occurredAt: '2026-10-12T12:10:00Z',
        entityId: 'hnd_2',
        outgoingUserId: 'usr_lead',
      };

      await service.processEvent(eventUserA1);
      await service.processEvent(eventUserA2);
      await service.processEvent(eventUserB);

      const aliceNotifications = await service.getNotificationsForRecipient('usr_alice');
      const bobNotifications = await service.getNotificationsForRecipient('usr_bob');
      const charlieNotifications = await service.getNotificationsForRecipient('usr_charlie');

      assert.equal(aliceNotifications.length, 2);
      assert.ok(aliceNotifications.every((n) => n.recipientUserId === 'usr_alice'));

      assert.equal(bobNotifications.length, 1);
      assert.ok(bobNotifications.every((n) => n.recipientUserId === 'usr_bob'));

      assert.equal(charlieNotifications.length, 0);
    });
  });

  describe('9. Duplicate Event Processing & Idempotency', () => {
    it('should return existing record idempotently by default when same eventId is received', async () => {
      const event = loadFixture('handoff-submitted.json');
      const first = await service.processEvent(event);
      const second = await service.processEvent(event);

      assert.equal(first.id, second.id);
      assert.equal(first.eventId, second.eventId);

      // Verify no duplicate record was created in repository
      const allForUser = await repository.findByRecipient(event.recipientUserId);
      assert.equal(allForUser.length, 1);
    });

    it('should throw DuplicateNotificationEventError when throwOnDuplicate is true', async () => {
      const event = loadFixture('handoff-accepted.json');
      await service.processEvent(event);

      await assert.rejects(
        () => service.processEvent(event, { throwOnDuplicate: true }),
        (err) => {
          assert.equal(err.name, 'DuplicateNotificationEventError');
          assert.equal(err.eventId, event.eventId);
          assert.ok(err.existingRecord);
          return true;
        }
      );
    });
  });

  describe('10. In-Memory Repository Direct Operations', () => {
    it('should store, retrieve by ID, and query with pagination / unread filtering', async () => {
      const record1 = {
        id: 'rec_001',
        recipientUserId: 'usr_dev_1',
        eventId: 'evt_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        title: 'Title 1',
        message: 'Message 1',
        projectId: 'proj_1',
        entityId: 'ent_1',
        readAt: null,
        createdAt: '2026-10-12T10:00:00Z',
        deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
      };

      const record2 = {
        id: 'rec_002',
        recipientUserId: 'usr_dev_1',
        eventId: 'evt_2',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED,
        title: 'Title 2',
        message: 'Message 2',
        projectId: 'proj_1',
        entityId: 'ent_1',
        readAt: '2026-10-12T10:05:00Z',
        createdAt: '2026-10-12T10:02:00Z',
        deliveryStatus: NOTIFICATION_DELIVERY_STATUS.SENT,
      };

      await repository.create(record1);
      await repository.create(record2);

      // Verify findById
      const retrieved = await repository.findById('rec_001');
      assert.equal(retrieved.id, 'rec_001');

      // Verify mutation prevention: mutating retrieved object must not affect internal storage
      retrieved.title = 'MUTATED TITLE';
      const retrievedAgain = await repository.findById('rec_001');
      assert.equal(retrievedAgain.title, 'Title 1');

      // Verify findByRecipient with unreadOnly
      const unread = await repository.findByRecipient('usr_dev_1', { unreadOnly: true });
      assert.equal(unread.length, 1);
      assert.equal(unread[0].id, 'rec_001');

      // Verify pagination limit
      const paginated = await repository.findByRecipient('usr_dev_1', { limit: 1 });
      assert.equal(paginated.length, 1);
      assert.equal(paginated[0].id, 'rec_002'); // newest first
    });

    it('should reject creating duplicate record IDs in in-memory repository', async () => {
      const record = {
        id: 'rec_dup_id',
        recipientUserId: 'usr_1',
        eventId: 'evt_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        title: 'Title',
        message: 'Message',
        projectId: 'proj_1',
        entityId: 'ent_1',
        readAt: null,
        createdAt: '2026-10-12T10:00:00Z',
        deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
      };

      await repository.create(record);
      await assert.rejects(
        () => repository.create(record),
        NotificationRepositoryError
      );
    });
  });
});
