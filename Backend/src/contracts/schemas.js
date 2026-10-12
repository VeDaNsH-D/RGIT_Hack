import { z } from 'zod';
import {
  ROLES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  HANDOFF_ITEM_TYPES,
  VALIDATION_CHECK_NAMES,
  CONFLICT_SEVERITIES,
  CONFLICT_STATUSES,
  CONFLICT_RESOLUTION_OUTCOMES,
  NOTIFICATION_EVENT_TYPES,
} from '../constants.js';

// --- Primitives -------------------------------------------------------

export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const httpUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'Only http(s) links are allowed');

const nonEmptyString = z.string().trim().min(1);

// Assignable roles via the API; 'owner' is never granted directly, it only
// changes through handoff acknowledgement.
const assignableRole = z.enum(['viewer', 'member']);
void ROLES; // ROLES includes 'owner', kept imported for documentation/reference.

// --- Pagination / generic query filters --------------------------------

export const paginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .strict();

// --- Auth ---------------------------------------------------------------

export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8).max(200),
    name: nonEmptyString.max(200),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(200),
  })
  .strict();

// --- Projects -------------------------------------------------------------

export const createProjectSchema = z
  .object({
    name: nonEmptyString.max(200),
    description: z.string().trim().max(5000).optional().default(''),
  })
  .strict();

export const updateProjectSchema = z
  .object({
    name: nonEmptyString.max(200).optional(),
    description: z.string().trim().max(5000).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, 'No fields to update');

// --- Members --------------------------------------------------------------

export const addMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    role: assignableRole,
  })
  .strict();

// --- Tasks ------------------------------------------------------------

export const createTaskSchema = z
  .object({
    title: nonEmptyString.max(300),
    description: z.string().trim().max(5000).optional().default(''),
    assignee: objectId.nullable().optional(),
    deadline: z.string().datetime().nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional().default('medium'),
  })
  .strict();

export const updateTaskSchema = z
  .object({
    title: nonEmptyString.max(300).optional(),
    description: z.string().trim().max(5000).optional(),
    assignee: objectId.nullable().optional(),
    deadline: z.string().datetime().nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    status: z.enum(TASK_STATUSES).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, 'No fields to update');

export const taskQuerySchema = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    assignee: objectId.optional(),
    overdue: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === undefined ? undefined : v === 'true'),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .strict();

export const sourceRecordQuerySchema = z
  .object({
    provider: z.string().trim().min(1).max(100).optional(),
    type: z.string().trim().min(1).max(100).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .strict();

// --- Handoffs ---------------------------------------------------------

export const createHandoffSchema = z
  .object({
    toUserId: objectId,
  })
  .strict();

const handoffItemSchema = z
  .object({
    type: z.enum(HANDOFF_ITEM_TYPES),
    text: nonEmptyString.max(2000),
    relatedTaskId: objectId.nullable().optional(),
    // References a decision/note SourceRecord (provider: 'manual'); the
    // handoff service must verify this record belongs to the same project
    // before accepting it (see src/handoffs/itemRefs.js).
    sourceRecordId: objectId.nullable().optional(),
  })
  .strict();

export const updateHandoffSchema = z
  .object({
    currentStatus: z.string().trim().max(5000).optional(),
    items: z.array(handoffItemSchema).max(200).optional(),
    noPendingActionsConfirmed: z.boolean().optional(),
    supportingLinks: z.array(httpUrl).max(50).optional(),
    documentIds: z.array(objectId).max(50).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, 'No fields to update');

export const exceptionSchema = z
  .object({
    checkName: z.enum(VALIDATION_CHECK_NAMES),
    reason: nonEmptyString.max(2000),
  })
  .strict();

export const clarificationNoteSchema = z
  .object({
    note: nonEmptyString.max(2000),
  })
  .strict();

// --- Conflicts ----------------------------------------------------------

const conflictEvidenceInputSchema = z
  .object({
    sourceType: nonEmptyString.max(100),
    sourceRecordId: objectId.optional(),
    documentId: objectId.optional(),
    excerpt: nonEmptyString.max(5000),
    url: httpUrl.optional(),
  })
  .strict();

export const createConflictSchema = z
  .object({
    title: nonEmptyString.max(300),
    description: z.string().trim().max(5000).optional().default(''),
    severity: z.enum(CONFLICT_SEVERITIES).optional().default('medium'),
    fingerprint: z.string().trim().min(1).max(500).optional(),
    evidence: z.array(conflictEvidenceInputSchema).min(2, 'At least 2 evidence items are required'),
  })
  .strict();

export const conflictQuerySchema = z
  .object({
    status: z.enum(CONFLICT_STATUSES).optional(),
  })
  .strict();

export const reviewConflictSchema = z.object({}).strict();

export const resolveConflictSchema = z
  .object({
    outcome: z.enum(CONFLICT_RESOLUTION_OUTCOMES),
    note: nonEmptyString.max(2000),
  })
  .strict();

// --- Manual decisions / notes (stored as SourceRecord, provider: 'manual') --

export const CreateNoteBody = z
  .object({
    recordType: z.enum(['decision', 'note']),
    title: nonEmptyString.max(500),
    content: z.string().trim().max(20000).optional().default(''),
    observedAt: z.string().datetime().optional(),
    url: httpUrl.optional(),
  })
  .strict();

export const updateNoteSchema = z
  .object({
    title: nonEmptyString.max(500).optional(),
    content: z.string().trim().max(20000).optional(),
    observedAt: z.string().datetime().nullable().optional(),
    url: httpUrl.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, 'No fields to update');

export const noteQuerySchema = z
  .object({
    recordType: z.enum(['decision', 'note']).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .strict();

// --- Notification events (contract for Person 4) ------------------------

export const notificationEventTypes = NOTIFICATION_EVENT_TYPES;

export const notificationEventSchema = z
  .object({
    type: z.enum(NOTIFICATION_EVENT_TYPES),
    projectId: objectId.nullable().optional(),
    recipientUserId: objectId,
    payload: z.record(z.any()).optional().default({}),
    dedupeKey: z.string().min(1).max(500).optional(),
  })
  .strict();
