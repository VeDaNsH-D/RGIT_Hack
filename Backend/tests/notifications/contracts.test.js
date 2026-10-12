import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_DELIVERY_STATUS,
  validateNotificationEvent,
  assertValidNotificationEvent,
  validateNotificationRecord,
  assertValidNotificationRecord,
  NotificationValidationError,
} from '../../src/notifications/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../../fixtures');

function loadFixture(filename) {
  const filePath = path.join(fixturesDir, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('Notification Event Contracts & Validation Suite', () => {
  describe('Valid Event Fixtures', () => {
    it('should validate handoff-submitted fixture successfully', () => {
      const fixture = loadFixture('handoff-submitted.json');
      const result = validateNotificationEvent(fixture);
      assert.equal(result.valid, true, `Errors: ${result.errors.join(', ')}`);
      assert.equal(result.errors.length, 0);
      assert.doesNotThrow(() => assertValidNotificationEvent(fixture));
      assert.equal(fixture.type, NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED);
      assert.ok(fixture.outgoingUserId);
    });

    it('should validate handoff-accepted fixture successfully', () => {
      const fixture = loadFixture('handoff-accepted.json');
      const result = validateNotificationEvent(fixture);
      assert.equal(result.valid, true, `Errors: ${result.errors.join(', ')}`);
      assert.equal(result.errors.length, 0);
      assert.doesNotThrow(() => assertValidNotificationEvent(fixture));
      assert.equal(fixture.type, NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED);
      assert.ok(fixture.acceptedByUserId);
    });

    it('should validate clarification-requested fixture successfully', () => {
      const fixture = loadFixture('clarification-requested.json');
      const result = validateNotificationEvent(fixture);
      assert.equal(result.valid, true, `Errors: ${result.errors.join(', ')}`);
      assert.equal(result.errors.length, 0);
      assert.doesNotThrow(() => assertValidNotificationEvent(fixture));
      assert.equal(fixture.type, NOTIFICATION_EVENT_TYPES.HANDOFF_NEEDS_CLARIFICATION);
      assert.ok(fixture.requestedByUserId);
      assert.ok(fixture.clarificationNote);
    });

    it('should validate conflict-detected fixture successfully', () => {
      const fixture = loadFixture('conflict-detected.json');
      const result = validateNotificationEvent(fixture);
      assert.equal(result.valid, true, `Errors: ${result.errors.join(', ')}`);
      assert.equal(result.errors.length, 0);
      assert.doesNotThrow(() => assertValidNotificationEvent(fixture));
      assert.equal(fixture.type, NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED);
      assert.ok(fixture.conflictType);
      assert.ok(fixture.description);
    });
  });

  describe('Unsupported Event Types', () => {
    it('should reject non-standard or unsupported event types', () => {
      const invalidEvent = {
        eventId: 'evt_invalid_001',
        type: 'CUSTOM_UNKNOWN_TYPE',
        projectId: 'proj_001',
        recipientUserId: 'usr_001',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'ent_001',
      };
      const result = validateNotificationEvent(invalidEvent);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes('unsupported value')));
      assert.throws(
        () => assertValidNotificationEvent(invalidEvent),
        NotificationValidationError
      );
    });

    it('should reject events with empty type', () => {
      const invalidEvent = {
        eventId: 'evt_invalid_002',
        type: '',
        projectId: 'proj_001',
        recipientUserId: 'usr_001',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'ent_001',
      };
      const result = validateNotificationEvent(invalidEvent);
      assert.equal(result.valid, false);
    });
  });

  describe('Missing Required Envelope Identifiers', () => {
    const validBase = {
      eventId: 'evt_001',
      type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
      projectId: 'proj_001',
      recipientUserId: 'usr_002',
      occurredAt: '2026-10-12T12:00:00Z',
      entityId: 'ent_001',
      outgoingUserId: 'usr_001',
    };

    it('should reject missing eventId', () => {
      const event = { ...validBase };
      delete event.eventId;
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'eventId' is required")));
    });

    it('should reject missing projectId', () => {
      const event = { ...validBase, projectId: '   ' };
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'projectId' is required")));
    });

    it('should reject missing recipientUserId', () => {
      const event = { ...validBase };
      delete event.recipientUserId;
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'recipientUserId' is required")));
    });

    it('should reject missing entityId', () => {
      const event = { ...validBase, entityId: '' };
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'entityId' is required")));
    });
  });

  describe('Timestamp Validation & Malformed Formats', () => {
    const validBase = {
      eventId: 'evt_001',
      type: NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED,
      projectId: 'proj_001',
      recipientUserId: 'usr_001',
      entityId: 'ent_001',
      acceptedByUserId: 'usr_002',
    };

    it('should reject non-ISO timestamp string', () => {
      const event = { ...validBase, occurredAt: 'October 12, 2026' };
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'occurredAt' must be a valid ISO 8601")));
    });

    it('should reject numeric timestamp', () => {
      const event = { ...validBase, occurredAt: 1760265600000 };
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'occurredAt' must be a valid ISO 8601")));
    });

    it('should reject impossible calendar dates', () => {
      const event = { ...validBase, occurredAt: '2026-02-31T12:00:00Z' };
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
    });
  });

  describe('Missing Event-Specific Required Fields', () => {
    const envelope = {
      eventId: 'evt_specific_001',
      projectId: 'proj_001',
      recipientUserId: 'usr_recipient',
      occurredAt: '2026-10-12T12:00:00Z',
      entityId: 'ent_001',
    };

    it('HANDOFF_SUBMITTED should require outgoingUserId', () => {
      const event = {
        ...envelope,
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
      };
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'outgoingUserId' is required")));
    });

    it('HANDOFF_ACCEPTED should require acceptedByUserId', () => {
      const event = {
        ...envelope,
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED,
      };
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'acceptedByUserId' is required")));
    });

    it('HANDOFF_NEEDS_CLARIFICATION should require requestedByUserId and clarificationNote', () => {
      const event = {
        ...envelope,
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_NEEDS_CLARIFICATION,
        requestedByUserId: 'usr_req_001',
      };
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'clarificationNote' is required")));
    });

    it('CRITICAL_CONFLICT_DETECTED should require conflictType and description', () => {
      const event = {
        ...envelope,
        type: NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED,
        conflictType: 'DEADLINE_MISMATCH',
      };
      const result = validateNotificationEvent(event);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'description' is required")));
    });
  });

  describe('Notification Record Validation', () => {
    const validRecord = {
      id: 'rec_notif_001',
      recipientUserId: 'usr_recipient_001',
      eventId: 'evt_handoff_sub_001',
      type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
      title: 'Handoff Submitted for Review',
      message: 'Payment Service transition package has been submitted by outgoing lead.',
      projectId: 'proj_relay_alpha_101',
      entityId: 'hnd_payment_service_001',
      readAt: null,
      createdAt: '2026-10-12T10:30:05Z',
      deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
    };

    it('should validate a valid pending notification record', () => {
      const result = validateNotificationRecord(validRecord);
      assert.equal(result.valid, true, `Errors: ${result.errors.join(', ')}`);
      assert.equal(result.errors.length, 0);
      assert.doesNotThrow(() => assertValidNotificationRecord(validRecord));
    });

    it('should validate a delivered notification record with readAt populated', () => {
      const readRecord = {
        ...validRecord,
        readAt: '2026-10-12T10:35:00Z',
        deliveryStatus: NOTIFICATION_DELIVERY_STATUS.SENT,
      };
      const result = validateNotificationRecord(readRecord);
      assert.equal(result.valid, true);
    });

    it('should reject invalid delivery-status values', () => {
      const badStatusRecord = {
        ...validRecord,
        deliveryStatus: 'IN_TRANSIT',
      };
      const result = validateNotificationRecord(badStatusRecord);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'deliveryStatus' has invalid value")));
      assert.throws(
        () => assertValidNotificationRecord(badStatusRecord),
        NotificationValidationError
      );
    });

    it('should reject malformed readAt timestamp when not null', () => {
      const badReadAtRecord = {
        ...validRecord,
        readAt: 'invalid-date-string',
      };
      const result = validateNotificationRecord(badReadAtRecord);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'readAt' must be null or a valid ISO 8601")));
    });

    it('should reject missing presentation fields like title or message', () => {
      const badRecord = {
        ...validRecord,
        title: '',
        message: '   ',
      };
      const result = validateNotificationRecord(badRecord);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((err) => err.includes("'title' is required")));
      assert.ok(result.errors.some((err) => err.includes("'message' is required")));
    });
  });
});
