/**
 * Notification Event Contracts
 * 
 * Defines the supported event types, recipient roles, envelope structure,
 * and event-specific payloads for the Relay notification layer.
 */

export const NOTIFICATION_EVENT_TYPES = Object.freeze({
  HANDOFF_SUBMITTED: 'HANDOFF_SUBMITTED',
  HANDOFF_ACCEPTED: 'HANDOFF_ACCEPTED',
  HANDOFF_NEEDS_CLARIFICATION: 'HANDOFF_NEEDS_CLARIFICATION',
  CRITICAL_CONFLICT_DETECTED: 'CRITICAL_CONFLICT_DETECTED',
});

/**
 * Mapping of event types to their intended recipient roles according to domain logic:
 * - HANDOFF_SUBMITTED: Incoming Owner (must review and accept/clarify)
 * - HANDOFF_ACCEPTED: Outgoing Owner (notified that handoff was accepted and ownership transferred)
 * - HANDOFF_NEEDS_CLARIFICATION: Outgoing Owner (notified that clarifications were requested)
 * - CRITICAL_CONFLICT_DETECTED: Designated Reviewer or Project Owner
 */
export const EVENT_RECIPIENT_ROLES = Object.freeze({
  [NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED]: 'INCOMING_OWNER',
  [NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED]: 'OUTGOING_OWNER',
  [NOTIFICATION_EVENT_TYPES.HANDOFF_NEEDS_CLARIFICATION]: 'OUTGOING_OWNER',
  [NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED]: 'PROJECT_OWNER_OR_REVIEWER',
});

/**
 * Required common envelope fields for all notification events.
 */
export const COMMON_ENVELOPE_FIELDS = Object.freeze([
  'eventId',
  'type',
  'projectId',
  'recipientUserId',
  'occurredAt',
  'entityId',
]);

/**
 * Required and optional event-specific fields per event type.
 */
export const EVENT_SPECIFIC_FIELDS = Object.freeze({
  [NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED]: {
    required: ['outgoingUserId'],
    optional: ['handoffTitle'],
  },
  [NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED]: {
    required: ['acceptedByUserId'],
    optional: ['notes'],
  },
  [NOTIFICATION_EVENT_TYPES.HANDOFF_NEEDS_CLARIFICATION]: {
    required: ['requestedByUserId', 'clarificationNote'],
    optional: ['unresolvedItems'],
  },
  [NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED]: {
    required: ['conflictType', 'description'],
    optional: ['severity', 'competingSources'],
  },
});
