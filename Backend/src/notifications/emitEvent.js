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
 * Person 4 already built a complete in-app notification system
 * (src/notifications/service.js + mongooseRepository.js + routes.js) with
 * its OWN 4-type event contract (src/notifications/events.js) and its own
 * stricter envelope. The default handler below is an adapter into that
 * system, not a second implementation of it.
 *
 * IMPORTANT GAP: their contract currently only covers 4 of our 8 types:
 *   HANDOFF_SUBMITTED, HANDOFF_ACCEPTED (= our HANDOFF_ACKNOWLEDGED),
 *   HANDOFF_NEEDS_CLARIFICATION, CRITICAL_CONFLICT_DETECTED.
 * For the other 4 (HANDOFF_CLARIFICATION_ANSWERED, HANDOFF_ACK_OVERDUE,
 * TASK_OVERDUE, CONFLICT_RESOLVED), the adapter logs a warning and no-ops
 * rather than silently dropping the event or throwing. Person 4 should
 * extend their event type list to close this gap; until then, those 4
 * event types are validated and dispatched but not actually delivered
 * in-app.
 *
 * For the 4 supported types, event.payload must include:
 *   HANDOFF_SUBMITTED:           { entityId, outgoingUserId, handoffTitle? }
 *   HANDOFF_ACKNOWLEDGED:        { entityId, acceptedByUserId, notes? }
 *   HANDOFF_NEEDS_CLARIFICATION: { entityId, requestedByUserId, clarificationNote, unresolvedItems? }
 *   CRITICAL_CONFLICT_DETECTED:  { entityId, conflictType, description, severity?, competingSources? }
 */

const OUR_TO_THEIR_TYPE = {
  HANDOFF_SUBMITTED: 'HANDOFF_SUBMITTED',
  HANDOFF_ACKNOWLEDGED: 'HANDOFF_ACCEPTED',
  HANDOFF_NEEDS_CLARIFICATION: 'HANDOFF_NEEDS_CLARIFICATION',
  CRITICAL_CONFLICT_DETECTED: 'CRITICAL_CONFLICT_DETECTED',
};

const EVENT_SPECIFIC_PAYLOAD_KEYS = {
  HANDOFF_SUBMITTED: { required: ['outgoingUserId'], optional: ['handoffTitle'] },
  HANDOFF_ACKNOWLEDGED: { required: ['acceptedByUserId'], optional: ['notes'] },
  HANDOFF_NEEDS_CLARIFICATION: {
    required: ['requestedByUserId', 'clarificationNote'],
    optional: ['unresolvedItems'],
  },
  CRITICAL_CONFLICT_DETECTED: {
    required: ['conflictType', 'description'],
    optional: ['severity', 'competingSources'],
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
 * Default handler: delivers to Person 4's in-app notification system for
 * the 4 event types it supports; no-ops with a warning for the rest.
 */
async function deliverToInAppSystem(event) {
  const theirType = OUR_TO_THEIR_TYPE[event.type];
  if (!theirType) {
    console.warn(
      `[notifications] event type '${event.type}' is not yet supported by the in-app delivery system (src/notifications/) — validated and dispatched, but not delivered.`
    );
    return;
  }

  const payload = event.payload || {};
  const entityId = payload.entityId;
  if (!entityId) {
    throw new Error(`event.payload.entityId is required to deliver a '${event.type}' notification`);
  }

  const spec = EVENT_SPECIFIC_PAYLOAD_KEYS[event.type];
  const specificFields = {};
  for (const key of [...spec.required, ...(spec.optional || [])]) {
    if (payload[key] !== undefined) specificFields[key] = payload[key];
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
