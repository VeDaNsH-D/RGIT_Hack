/**
 * TypeScript Type Definitions for Relay Notifications Module
 */

export type NotificationEventType =
  | 'HANDOFF_SUBMITTED'
  | 'HANDOFF_ACCEPTED'
  | 'HANDOFF_ACKNOWLEDGED'
  | 'HANDOFF_NEEDS_CLARIFICATION'
  | 'HANDOFF_CLARIFICATION_ANSWERED'
  | 'HANDOFF_ACK_OVERDUE'
  | 'TASK_OVERDUE'
  | 'CRITICAL_CONFLICT_DETECTED'
  | 'CONFLICT_RESOLVED';

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

export interface HandoffAcknowledgedEvent extends BaseNotificationEvent {
  type: 'HANDOFF_ACKNOWLEDGED';
  acknowledgedByUserId?: string;
  acceptedByUserId?: string;
  notes?: string;
}

export interface HandoffNeedsClarificationEvent extends BaseNotificationEvent {
  type: 'HANDOFF_NEEDS_CLARIFICATION';
  requestedByUserId: string;
  clarificationNote: string;
  unresolvedItems?: string[];
}

export interface HandoffClarificationAnsweredEvent extends BaseNotificationEvent {
  type: 'HANDOFF_CLARIFICATION_ANSWERED';
  answeredByUserId: string;
  clarificationNote?: string;
  answerNote?: string;
  notes?: string;
  resolvedItems?: string[];
}

export interface HandoffAckOverdueEvent extends BaseNotificationEvent {
  type: 'HANDOFF_ACK_OVERDUE';
  overdueSince?: string;
  dueDate?: string;
  hoursOverdue?: number;
  handoffTitle?: string;
}

export interface TaskOverdueEvent extends BaseNotificationEvent {
  type: 'TASK_OVERDUE';
  taskId?: string;
  taskTitle?: string;
  dueDate?: string;
  assigneeId?: string;
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

export interface ConflictResolvedEvent extends BaseNotificationEvent {
  type: 'CONFLICT_RESOLVED';
  conflictType?: string;
  resolvedByUserId?: string;
  resolutionNotes?: string;
  description?: string;
}

export type NotificationEvent =
  | HandoffSubmittedEvent
  | HandoffAcceptedEvent
  | HandoffAcknowledgedEvent
  | HandoffNeedsClarificationEvent
  | HandoffClarificationAnsweredEvent
  | HandoffAckOverdueEvent
  | TaskOverdueEvent
  | CriticalConflictDetectedEvent
  | ConflictResolvedEvent;

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
  countUnread?(recipientUserId: string): Promise<number>;
  markAsRead?(id: string, recipientUserId: string): Promise<NotificationRecord | null>;
  markAllAsRead?(recipientUserId: string): Promise<{ updatedCount: number }>;
  updateDeliveryStatus?(
    id: string,
    deliveryStatus: DeliveryStatus,
    metadata?: Record<string, unknown>
  ): Promise<NotificationRecord | null>;
}

export interface NotificationServiceConfig {
  repository: NotificationRepository;
  idGenerator?: () => string;
}

export interface ProcessEventOptions {
  throwOnDuplicate?: boolean;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  maxDelayMs?: number;
  isTransient?: (error: unknown) => boolean;
  sleepFn?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export interface DeliveryProvider {
  name: string;
  send(notification: NotificationRecord): Promise<{ success: boolean, externalId?: string }>;
}
