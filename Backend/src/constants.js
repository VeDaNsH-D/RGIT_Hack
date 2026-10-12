export const ROLES = ['viewer', 'member', 'owner'];
export const ROLE_RANK = { viewer: 0, member: 1, owner: 2 };

export const TASK_ORIGINS = ['manual', 'imported'];
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const TASK_STATUSES = ['open', 'completed'];

export const HANDOFF_STATES = [
  'DRAFT',
  'EDITING',
  'SUBMITTED',
  'CLARIFICATION_REQUESTED',
  'ACKNOWLEDGED',
  'CANCELLED',
];
export const HANDOFF_OPEN_STATES = ['DRAFT', 'EDITING', 'SUBMITTED', 'CLARIFICATION_REQUESTED'];
export const HANDOFF_TERMINAL_STATES = ['ACKNOWLEDGED', 'CANCELLED'];

export const HANDOFF_ITEM_TYPES = [
  'completed',
  'pending',
  'blocker',
  'decision',
  'deadline',
  'dependency',
  'risk',
];

export const CLARIFICATION_TYPES = ['request', 'response'];

export const CONFLICT_SEVERITIES = ['low', 'medium', 'high', 'critical'];
export const CONFLICT_STATUSES = ['open', 'reviewed', 'resolved', 'dismissed'];
export const CONFLICT_RESOLUTION_OUTCOMES = ['resolved', 'dismissed'];

export const VALIDATION_CHECK_NAMES = [
  'project_exists',
  'incoming_owner_specified',
  'current_status_documented',
  'pending_actions_listed',
  'task_owners_assigned',
  'mandatory_deadlines_present',
  'supporting_links_provided',
  'critical_conflicts_reviewed',
];

export const NON_WAIVABLE_CHECKS = ['project_exists', 'incoming_owner_specified'];

export const NOTIFICATION_EVENT_TYPES = [
  'HANDOFF_SUBMITTED',
  'HANDOFF_ACKNOWLEDGED',
  'HANDOFF_NEEDS_CLARIFICATION',
  'HANDOFF_CLARIFICATION_ANSWERED',
  'HANDOFF_ACK_OVERDUE',
  'TASK_OVERDUE',
  'CRITICAL_CONFLICT_DETECTED',
  'CONFLICT_RESOLVED',
];
