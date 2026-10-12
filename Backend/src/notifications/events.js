/**
 * Notification Event Contracts
 * 
 * Defines the supported event types, recipient roles, envelope structure,
 * and event-specific payloads for the Relay notification layer.
 */

export const NOTIFICATION_EVENT_TYPES = Object.freeze({
  HANDOFF_SUBMITTED: 'HANDOFF_SUBMITTED',
  HANDOFF_ACCEPTED: 'HANDOFF_ACCEPTED',
  HANDOFF_ACKNOWLEDGED: 'HANDOFF_ACKNOWLEDGED',
  HANDOFF_NEEDS_CLARIFICATION: 'HANDOFF_NEEDS_CLARIFICATION',
  HANDOFF_CLARIFICATION_ANSWERED: 'HANDOFF_CLARIFICATION_ANSWERED',
  HANDOFF_ACK_OVERDUE: 'HANDOFF_ACK_OVERDUE',
  TASK_OVERDUE: 'TASK_OVERDUE',
  CRITICAL_CONFLICT_DETECTED: 'CRITICAL_CONFLICT_DETECTED',
  CONFLICT_RESOLVED: 'CONFLICT_RESOLVED',
});

/**
 * Mapping of event types to their intended recipient roles according to domain logic:
 * - HANDOFF_SUBMITTED: Incoming Owner (must review and accept/clarify)
 * - HANDOFF_ACCEPTED / HANDOFF_ACKNOWLEDGED: Outgoing Owner (notified that handoff was accepted and ownership transferred)
 * - HANDOFF_NEEDS_CLARIFICATION: Outgoing Owner (notified that clarifications were requested)
 * - HANDOFF_CLARIFICATION_ANSWERED: Incoming Owner (notified that clarifications have been answered)
 * - HANDOFF_ACK_OVERDUE: Incoming Owner (alerted that handoff acknowledgment deadline has passed)
 * - TASK_OVERDUE: Task Owner (alerted that task milestone deadline has passed)
 * - CRITICAL_CONFLICT_DETECTED: Designated Reviewer or Project Owner
 * - CONFLICT_RESOLVED: Designated Reviewer or Project Owner
 */
export const EVENT_RECIPIENT_ROLES = Object.freeze({
  [NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED]: 'INCOMING_OWNER',
  [NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED]: 'OUTGOING_OWNER',
  [NOTIFICATION_EVENT_TYPES.HANDOFF_ACKNOWLEDGED]: 'OUTGOING_OWNER',
  [NOTIFICATION_EVENT_TYPES.HANDOFF_NEEDS_CLARIFICATION]: 'OUTGOING_OWNER',
  [NOTIFICATION_EVENT_TYPES.HANDOFF_CLARIFICATION_ANSWERED]: 'INCOMING_OWNER',
  [NOTIFICATION_EVENT_TYPES.HANDOFF_ACK_OVERDUE]: 'INCOMING_OWNER',
  [NOTIFICATION_EVENT_TYPES.TASK_OVERDUE]: 'TASK_OWNER',
  [NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED]: 'PROJECT_OWNER_OR_REVIEWER',
  [NOTIFICATION_EVENT_TYPES.CONFLICT_RESOLVED]: 'PROJECT_OWNER_OR_REVIEWER',
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
  [NOTIFICATION_EVENT_TYPES.HANDOFF_ACKNOWLEDGED]: {
    required: ['acceptedByUserId'], // validation accepts acceptedByUserId OR acknowledgedByUserId
    optional: ['notes', 'acknowledgedByUserId'],
  },
  [NOTIFICATION_EVENT_TYPES.HANDOFF_NEEDS_CLARIFICATION]: {
    required: ['requestedByUserId', 'clarificationNote'],
    optional: ['unresolvedItems'],
  },
  [NOTIFICATION_EVENT_TYPES.HANDOFF_CLARIFICATION_ANSWERED]: {
    required: ['answeredByUserId'],
    optional: ['clarificationNote', 'answerNote', 'notes', 'resolvedItems'],
  },
  [NOTIFICATION_EVENT_TYPES.HANDOFF_ACK_OVERDUE]: {
    required: [],
    optional: ['overdueSince', 'dueDate', 'hoursOverdue', 'handoffTitle'],
  },
  [NOTIFICATION_EVENT_TYPES.TASK_OVERDUE]: {
    required: [],
    optional: ['taskId', 'taskTitle', 'dueDate', 'assigneeId'],
  },
  [NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED]: {
    required: ['conflictType', 'description'],
    optional: ['severity', 'competingSources'],
  },
  [NOTIFICATION_EVENT_TYPES.CONFLICT_RESOLVED]: {
    required: [],
    optional: ['conflictType', 'resolvedByUserId', 'resolutionNotes', 'description'],
  },
});
