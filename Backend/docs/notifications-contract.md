# Notification Contracts & Event Specifications

## Overview
This document specifies the notification event contracts, envelope schema, presentation records, and validation utilities for the notification and reliability layer (Person 4).

## Supported Event Types and Recipients

| Event Type | Intended Recipient | Description / Domain Purpose |
| :--- | :--- | :--- |
| `HANDOFF_SUBMITTED` | Incoming Owner | Emitted when an outgoing owner submits a handoff package for review and acceptance. |
| `HANDOFF_ACCEPTED` | Outgoing Owner | Emitted when the incoming owner accepts the handoff and assumes project responsibility. |
| `HANDOFF_NEEDS_CLARIFICATION` | Outgoing Owner | Emitted when the incoming owner requests clarification on specific handoff items or blockers. |
| `CRITICAL_CONFLICT_DETECTED` | Designated Reviewer / Project Owner | Emitted when the conflict detection engine identifies critical discrepancies (e.g., deadline mismatches, conflicting owners). |

---

## Event Envelope and Fields

All events use a consistent envelope structure containing common metadata:

### Common Envelope Fields
- `eventId` (`string`): Unique event identifier (e.g., `evt_handoff_sub_001`).
- `type` (`string`): One of the 4 supported types above.
- `projectId` (`string`): Associated project identifier.
- `recipientUserId` (`string`): Intended recipient user identifier.
- `occurredAt` (`string`): ISO 8601 formatted timestamp (e.g., `2026-10-12T10:30:00Z`).
- `entityId` (`string`): Primary entity ID (e.g., `handoffId` or `conflictId`).

### Event-Specific Fields
- **`HANDOFF_SUBMITTED`**:
  - `outgoingUserId` (`string`, required): Outgoing owner submitting the handoff.
  - `handoffTitle` (`string`, optional): Human-readable handoff title.
- **`HANDOFF_ACCEPTED`**:
  - `acceptedByUserId` (`string`, required): User accepting the handoff.
  - `notes` (`string`, optional): Acceptance notes.
- **`HANDOFF_NEEDS_CLARIFICATION`**:
  - `requestedByUserId` (`string`, required): User requesting clarification.
  - `clarificationNote` (`string`, required): Details of missing or ambiguous items.
  - `unresolvedItems` (`string[]`, optional): Specific item IDs or references.
- **`CRITICAL_CONFLICT_DETECTED`**:
  - `conflictType` (`string`, required): Category of conflict (e.g., `DEADLINE_MISMATCH`, `STATUS_MISMATCH`).
  - `description` (`string`, required): Explanation of the detected contradiction.
  - `severity` (`string`, optional): Severity level (e.g., `CRITICAL`).
  - `competingSources` (`array`, optional): Supporting evidence references.

---

## Events vs. Notification Records

- **Notification Event**: Represents a domain event describing *what happened* in the workflow (immutable event payload).
- **Notification Record**: Represents the persisted recipient-facing state describing *what is delivered and displayed* to a user.

### Notification Record Schema
- `id` (`string`): Unique record ID (e.g., `rec_notif_001`).
- `recipientUserId` (`string`): Recipient user ID.
- `eventId` (`string`): Linked event ID.
- `type` (`string`): Supported event type.
- `title` (`string`): Notification title for display.
- `message` (`string`): Notification message text.
- `projectId` (`string`): Associated project ID.
- `entityId` (`string`): Associated entity ID.
- `readAt` (`string | null`): ISO 8601 timestamp when read by user, or `null` if unread.
- `createdAt` (`string`): ISO 8601 creation timestamp.
- `deliveryStatus` (`string`): Delivery state (`PENDING`, `SENT`, `FAILED`).

---

## Validation & Usage

The validation module is dependency-free and can be imported directly into backend services:

```javascript
import {
  validateNotificationEvent,
  assertValidNotificationEvent,
  validateNotificationRecord,
  assertValidNotificationRecord,
} from './src/notifications/index.js';

// Validate an incoming event
const result = validateNotificationEvent(eventPayload);
if (!result.valid) {
  console.error('Validation failed:', result.errors);
}

// Or assert directly
assertValidNotificationEvent(eventPayload);
```

---

## Running Contract Tests

Run the test suite using Node.js built-in test runner:

```bash
cd Backend
npm test
```

Or directly via Node:

```bash
node --test tests/notifications/contracts.test.js
```

---

## Integration Notes & Assumptions

1. **Identifier Format**: IDs are currently validated as non-empty strings (e.g., string IDs, CUIDs, UUIDs, or MongoDB ObjectIds), keeping integration flexible between team members.
2. **Channel Delivery Decoupling**: External delivery (such as WhatsApp or push notifications) subscribes to these event contracts without altering the core envelope.
3. **Database Independence**: Database schema migrations and persistence remain owned by Person 2; these contracts establish the shared in-memory and serialization contract.
