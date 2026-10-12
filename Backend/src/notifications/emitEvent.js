import crypto from 'node:crypto';
import { notificationEventSchema } from '../contracts/schemas.js';
import { NotificationService } from './service.js';
import { MongooseNotificationRepository } from './mongooseRepository.js';

/**
 * emitNotificationEvent() is the single entrypoint the rest of this
 * backend (handoffs, tasks, conflicts, the cron job) calls to raise one of
 * the 8 event types in src/constants.js's NOTIFICATION_EVENT_TYPES. It:
 *  - validates the event against that full 8-type contract
 *    (src/contracts/schemas.js notificationEventSchema)
 *  - runs every registered handler via Promise.allSettled, so one
 *    handler throwing never breaks another, or the caller
 *  - never throws itself once the event shape is valid
 *
 * Fully supports all 8 event types in the in-app delivery system:
 *   1. HANDOFF_SUBMITTED
 *   2. HANDOFF_ACKNOWLEDGED (and alias HANDOFF_ACCEPTED)
 *   3. HANDOFF_NEEDS_CLARIFICATION
 *   4. HANDOFF_CLARIFICATION_ANSWERED
 *   5. HANDOFF_ACK_OVERDUE
 *   6. TASK_OVERDUE
 *   7. CRITICAL_CONFLICT_DETECTED
 *   8. CONFLICT_RESOLVED
 */

const OUR_TO_THEIR_TYPE = {
  HANDOFF_SUBMITTED: 'HANDOFF_SUBMITTED',
  HANDOFF_ACCEPTED: 'HANDOFF_ACCEPTED',
  HANDOFF_ACKNOWLEDGED: 'HANDOFF_ACKNOWLEDGED',
  HANDOFF_NEEDS_CLARIFICATION: 'HANDOFF_NEEDS_CLARIFICATION',
  HANDOFF_CLARIFICATION_ANSWERED: 'HANDOFF_CLARIFICATION_ANSWERED',
  HANDOFF_ACK_OVERDUE: 'HANDOFF_ACK_OVERDUE',
  TASK_OVERDUE: 'TASK_OVERDUE',
  CRITICAL_CONFLICT_DETECTED: 'CRITICAL_CONFLICT_DETECTED',
  CONFLICT_RESOLVED: 'CONFLICT_RESOLVED',
};

const EVENT_SPECIFIC_PAYLOAD_KEYS = {
  HANDOFF_SUBMITTED: { required: ['outgoingUserId'], optional: ['handoffTitle'] },
  HANDOFF_ACCEPTED: { required: ['acceptedByUserId'], optional: ['notes'] },
  HANDOFF_ACKNOWLEDGED: { required: ['acceptedByUserId'], optional: ['notes', 'acknowledgedByUserId'] },
  HANDOFF_NEEDS_CLARIFICATION: {
    required: ['requestedByUserId', 'clarificationNote'],
    optional: ['unresolvedItems'],
  },
  HANDOFF_CLARIFICATION_ANSWERED: {
    required: ['answeredByUserId'],
    optional: ['clarificationNote', 'answerNote', 'notes', 'resolvedItems'],
  },
  HANDOFF_ACK_OVERDUE: {
    required: [],
    optional: ['overdueSince', 'dueDate', 'hoursOverdue', 'handoffTitle'],
  },
  TASK_OVERDUE: {
    required: [],
    optional: ['taskId', 'taskTitle', 'dueDate', 'assigneeId'],
  },
  CRITICAL_CONFLICT_DETECTED: {
    required: ['conflictType', 'description'],
    optional: ['severity', 'competingSources'],
  },
  CONFLICT_RESOLVED: {
    required: [],
    optional: ['conflictType', 'resolvedByUserId', 'resolutionNotes', 'description'],
  },
};

let cachedService = null;
function getPerson4Service() {
  if (!cachedService) {
    cachedService = new NotificationService({ repository: new MongooseNotificationRepository() });
  }
  return cachedService;
}

/**
 * Default handler: delivers to Person 4's in-app notification system across all 8 supported event types.
 */
async function deliverToInAppSystem(event) {
  const theirType = OUR_TO_THEIR_TYPE[event.type];
  if (!theirType) {
    console.warn(
      `[notifications] event type '${event.type}' is not supported by the in-app delivery system (src/notifications/) — validated and dispatched, but not delivered.`
    );
    return;
  }

  const payload = event.payload || {};
  const entityId = payload.entityId || payload.taskId || payload.handoffId || payload.conflictId;
  if (!entityId) {
    throw new Error(`event.payload.entityId is required to deliver a '${event.type}' notification`);
  }

  const spec = EVENT_SPECIFIC_PAYLOAD_KEYS[event.type];
  const specificFields = {};
  if (spec) {
    for (const key of [...spec.required, ...(spec.optional || [])]) {
      if (payload[key] !== undefined) specificFields[key] = payload[key];
    }
  }

  if (event.type === 'HANDOFF_ACKNOWLEDGED' && payload.acknowledgedByUserId && !specificFields.acceptedByUserId) {
    specificFields.acceptedByUserId = payload.acknowledgedByUserId;
  }

  const envelope = {
    eventId: event.dedupeKey || crypto.randomUUID(),
    type: theirType,
    projectId: String(event.projectId),
    recipientUserId: String(event.recipientUserId),
    occurredAt: new Date().toISOString(),
    entityId: String(entityId),
    ...specificFields,
  };

  await getPerson4Service().processEvent(envelope);
}

const handlers = [deliverToInAppSystem];

/** For tests, or for Person 4 to add additional delivery channels later. */
export function registerNotificationHandler(fn) {
  handlers.push(fn);
}

/** Test-only: reset to just the default in-app handler. */
export function _resetNotificationHandlers() {
  handlers.length = 0;
  handlers.push(deliverToInAppSystem);
}

export async function emitNotificationEvent(event) {
  // Callers naturally pass Mongoose ObjectIds for projectId/recipientUserId
  // (they're reading them straight off a document); coerce to strings here
  // rather than requiring every call site to remember to do it.
  const normalized = {
    ...event,
    projectId: event?.projectId != null ? String(event.projectId) : event?.projectId,
    recipientUserId: event?.recipientUserId != null ? String(event.recipientUserId) : event?.recipientUserId,
  };
  const parsed = notificationEventSchema.parse(normalized);

  const results = await Promise.allSettled(handlers.map((handler) => handler(parsed)));

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[notifications] a notification handler failed:', result.reason);
    }
  }
}
