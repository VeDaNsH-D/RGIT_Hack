/**
 * TypeScript Type Definitions for Relay Notifications Module
 */

export type NotificationEventType =
  | 'HANDOFF_SUBMITTED'
  | 'HANDOFF_ACCEPTED'
  | 'HANDOFF_NEEDS_CLARIFICATION'
  | 'CRITICAL_CONFLICT_DETECTED';

export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface BaseNotificationEvent {
  eventId: string;
  type: NotificationEventType;
  projectId: string;
  recipientUserId: string;
  occurredAt: string; // ISO 8601
  entityId: string;
}

export interface HandoffSubmittedEvent extends BaseNotificationEvent {
  type: 'HANDOFF_SUBMITTED';
  outgoingUserId: string;
  handoffTitle?: string;
}

export interface HandoffAcceptedEvent extends BaseNotificationEvent {
  type: 'HANDOFF_ACCEPTED';
  acceptedByUserId: string;
  notes?: string;
}

export interface HandoffNeedsClarificationEvent extends BaseNotificationEvent {
  type: 'HANDOFF_NEEDS_CLARIFICATION';
  requestedByUserId: string;
  clarificationNote: string;
  unresolvedItems?: string[];
}

export interface CriticalConflictDetectedEvent extends BaseNotificationEvent {
  type: 'CRITICAL_CONFLICT_DETECTED';
  conflictType: string;
  description: string;
  severity?: 'CRITICAL' | string;
  competingSources?: Array<{
    sourceId: string;
    sourceType: string;
    claimedValue: string;
  }>;
}

export type NotificationEvent =
  | HandoffSubmittedEvent
  | HandoffAcceptedEvent
  | HandoffNeedsClarificationEvent
  | CriticalConflictDetectedEvent;

export interface NotificationRecord {
  id: string;
  recipientUserId: string;
  eventId: string;
  type: NotificationEventType;
  title: string;
  message: string;
  projectId: string;
  entityId: string;
  readAt: string | null;
  createdAt: string; // ISO 8601
  deliveryStatus: DeliveryStatus;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface NotificationTemplateResult {
  title: string;
  message: string;
}

export interface NotificationQueryOptions {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface NotificationRepository {
  create(record: NotificationRecord): Promise<NotificationRecord>;
  findById(id: string): Promise<NotificationRecord | null>;
  findByRecipient(
    recipientUserId: string,
    options?: NotificationQueryOptions
  ): Promise<NotificationRecord[]>;
  findByEventId?(eventId: string): Promise<NotificationRecord | null>;
}

export interface NotificationServiceConfig {
  repository: NotificationRepository;
  idGenerator?: () => string;
}

export interface ProcessEventOptions {
  throwOnDuplicate?: boolean;
}

