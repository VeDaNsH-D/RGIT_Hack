/**
 * Notification Record Contracts
 * 
 * Defines the presentation and delivery record for notifications.
 * The event describes what happened in the system; the notification record
 * describes what is stored, rendered, or delivered to a specific recipient.
 */

export const NOTIFICATION_DELIVERY_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
});

export const NOTIFICATION_RECORD_FIELDS = Object.freeze([
  'id',
  'recipientUserId',
  'eventId',
  'type',
  'title',
  'message',
  'projectId',
  'entityId',
  'readAt',
  'createdAt',
  'deliveryStatus',
]);
