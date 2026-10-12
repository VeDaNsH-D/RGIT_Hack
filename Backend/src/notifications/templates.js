/**
 * Notification Templates Engine
 * 
 * Centralized, deterministic mapping from supported event types to presentation
 * title and message strings without fabricating details.
 */

import { NOTIFICATION_EVENT_TYPES } from './events.js';

export class UnsupportedTemplateEventError extends Error {
  constructor(eventType) {
    super(`Unsupported event type for notification template: '${eventType}'`);
    this.name = 'UnsupportedTemplateEventError';
    this.eventType = eventType;
  }
}

/**
 * Deterministic template generators per event type.
 */
const TEMPLATE_GENERATORS = Object.freeze({
  [NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED]: (event) => {
    const title = 'Project Handoff Submitted';
    const titleSuffix = event.handoffTitle ? ` ('${event.handoffTitle}')` : '';
    const message = `Project handoff${titleSuffix} (ID: ${event.entityId}) was submitted by ${event.outgoingUserId} for project ${event.projectId} and is awaiting review.`;
    return { title, message };
  },

  [NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED]: (event) => {
    const title = 'Project Handoff Accepted';
    const noteSuffix = event.notes ? ` Note: "${event.notes}".` : '';
    const message = `Handoff ${event.entityId} for project ${event.projectId} was accepted by ${event.acceptedByUserId}.${noteSuffix} Ownership transfer is complete.`;
    return { title, message };
  },

  [NOTIFICATION_EVENT_TYPES.HANDOFF_NEEDS_CLARIFICATION]: (event) => {
    const title = 'Handoff Clarification Requested';
    const message = `Clarification requested by ${event.requestedByUserId} on handoff ${event.entityId} for project ${event.projectId}: "${event.clarificationNote}".`;
    return { title, message };
  },

  [NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED]: (event) => {
    const title = 'Critical Conflict Detected';
    const severityPrefix = event.severity ? `[${event.severity}] ` : '';
    const message = `${severityPrefix}Conflict (${event.conflictType}) detected in project ${event.projectId} (ID: ${event.entityId}): ${event.description}`;
    return { title, message };
  },
});

/**
 * Renders the presentation title and message for a validated notification event.
 * 
 * @param {import('./events.js').NotificationEvent} event
 * @returns {{ title: string, message: string }}
 * @throws {UnsupportedTemplateEventError} if event.type is not supported
 */
export function renderNotificationTemplate(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('Event payload must be a non-null object.');
  }

  const generator = TEMPLATE_GENERATORS[event.type];
  if (!generator) {
    throw new UnsupportedTemplateEventError(event.type);
  }

  return generator(event);
}
