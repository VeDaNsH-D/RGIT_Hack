/**
 * WhatsApp Notification Template Formatter
 * 
 * Maps notification records to concise, clear, and privacy-safe WhatsApp message strings.
 * WhatsApp supports markdown-style formatting:
 *   *bold* for headers/emphasis
 *   _italics_ for context
 */

import { NOTIFICATION_EVENT_TYPES } from '../events.js';

/**
 * Strips potential sensitive keywords or secrets from free-form text.
 * 
 * @param {string} text
 * @returns {string}
 */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  // Redact any patterns resembling API keys, tokens, or passwords
  return text
    .replace(/(?:key|token|secret|password|bearer|auth)[:=]\s*([^\s,;]+)/gi, '$1:[REDACTED]')
    .trim();
}

/**
 * Maps a notification record to a concise WhatsApp message string.
 * 
 * @param {import('../records.js').NotificationRecord} notification
 * @returns {string} Formatted WhatsApp message
 */
export function formatWhatsAppMessage(notification) {
  if (!notification || typeof notification !== 'object') {
    throw new TypeError('Notification must be a non-null object.');
  }

  const { type, entityId, projectId, title, message } = notification;

  switch (type) {
    case NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED:
      return [
        `*Project Handoff Submitted*`,
        `A handoff package (ID: ${entityId}) was submitted for project *${projectId}* and is awaiting your review.`,
        title ? `Title: ${sanitizeText(title)}` : null,
      ]
        .filter(Boolean)
        .join('\n');

    case NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED:
    case NOTIFICATION_EVENT_TYPES.HANDOFF_ACKNOWLEDGED:
      return [
        `*Project Handoff Accepted*`,
        `Handoff *${entityId}* for project *${projectId}* has been acknowledged and accepted.`,
        message ? `Detail: ${sanitizeText(message)}` : null,
      ]
        .filter(Boolean)
        .join('\n');

    case NOTIFICATION_EVENT_TYPES.HANDOFF_NEEDS_CLARIFICATION:
      return [
        `*Handoff Clarification Requested*`,
        `Clarification was requested for handoff *${entityId}* (Project: ${projectId}).`,
        message ? `Details: ${sanitizeText(message)}` : null,
      ]
        .filter(Boolean)
        .join('\n');

    case NOTIFICATION_EVENT_TYPES.HANDOFF_CLARIFICATION_ANSWERED:
      return [
        `*Handoff Clarification Answered*`,
        `Clarification questions for handoff *${entityId}* (Project: ${projectId}) have been answered.`,
        message ? `Response: ${sanitizeText(message)}` : null,
      ]
        .filter(Boolean)
        .join('\n');

    case NOTIFICATION_EVENT_TYPES.HANDOFF_ACK_OVERDUE:
      return [
        `*Attention: Handoff Acknowledgment Overdue*`,
        `Handoff *${entityId}* for project *${projectId}* has exceeded its acknowledgment SLA.`,
        `Please review and acknowledge the handoff as soon as possible.`,
      ].join('\n');

    case NOTIFICATION_EVENT_TYPES.TASK_OVERDUE:
      return [
        `*Attention: Task Milestone Overdue*`,
        `Task *${entityId}* in project *${projectId}* has passed its scheduled due date.`,
        message ? `Note: ${sanitizeText(message)}` : null,
      ]
        .filter(Boolean)
        .join('\n');

    case NOTIFICATION_EVENT_TYPES.CRITICAL_CONFLICT_DETECTED:
      return [
        `*Warning: Critical Conflict Detected*`,
        `A critical conflict (ID: ${entityId}) was detected in project *${projectId}*.`,
        message ? `Summary: ${sanitizeText(message)}` : null,
      ]
        .filter(Boolean)
        .join('\n');

    case NOTIFICATION_EVENT_TYPES.CONFLICT_RESOLVED:
      return [
        `*Conflict Resolved*`,
        `Conflict *${entityId}* in project *${projectId}* has been resolved.`,
        message ? `Resolution: ${sanitizeText(message)}` : null,
      ]
        .filter(Boolean)
        .join('\n');

    default:
      // Fallback for generic or custom notification records
      return [
        title ? `*${sanitizeText(title)}*` : `*Notification (${type || 'System'})*`,
        `Project: ${projectId || 'General'}`,
        message ? sanitizeText(message) : `Entity ID: ${entityId}`,
      ]
        .filter(Boolean)
        .join('\n');
  }
}
