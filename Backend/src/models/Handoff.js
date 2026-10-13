import mongoose from 'mongoose';
import {
  HANDOFF_ITEM_TYPES,
  HANDOFF_STATES,
  HANDOFF_TRANSFER_TYPES,
  CLARIFICATION_TYPES,
  VALIDATION_CHECK_NAMES,
} from '../constants.js';

const { Schema } = mongoose;

const handoffItemSchema = new Schema(
  {
    type: { type: String, enum: HANDOFF_ITEM_TYPES, required: true },
    text: { type: String, required: true, trim: true },
    relatedTaskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    // References a decision/note SourceRecord (provider: 'manual'). The
    // handoff route/service layer must call
    // assertItemSourceRecordsBelongToProject() before persisting items so a
    // reference can never point at another project's record.
    sourceRecordId: { type: Schema.Types.ObjectId, ref: 'SourceRecord', default: null },
  },
  { timestamps: true }
);

const exceptionSchema = new Schema(
  {
    checkName: { type: String, enum: VALIDATION_CHECK_NAMES, required: true },
    reason: { type: String, required: true, trim: true },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recordedAt: { type: Date, required: true },
  },
  { _id: false }
);

const checkResultSchema = new Schema(
  {
    name: { type: String, enum: VALIDATION_CHECK_NAMES, required: true },
    passed: { type: Boolean, required: true },
    waived: { type: Boolean, required: true, default: false },
    reason: { type: String, default: '' },
    waivedReason: { type: String, default: '' },
  },
  { _id: false }
);

const lastValidationSchema = new Schema(
  {
    ready: { type: Boolean, required: true },
    score: { type: Number, required: true },
    missingFields: { type: [String], default: [] },
    checks: { type: [checkResultSchema], default: [] },
    validatedAt: { type: Date, required: true },
  },
  { _id: false }
);

const clarificationSchema = new Schema(
  {
    type: { type: String, enum: CLARIFICATION_TYPES, required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    note: { type: String, required: true, trim: true },
    createdAt: { type: Date, required: true },
  },
  { _id: false }
);

const handoffSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Team routing. The receiving team and the named recipient are separate concepts.
    transferType: { type: String, enum: HANDOFF_TRANSFER_TYPES, required: true, default: 'individual' },
    fromTeamId: { type: Schema.Types.ObjectId, ref: 'ProjectTeam', default: null },
    toTeamId: { type: Schema.Types.ObjectId, ref: 'ProjectTeam', default: null },
    reason: { type: String, default: '', trim: true },
    instructions: { type: String, default: '', trim: true },
    // Immutable copy of the context the recipient was asked to review, captured on submit.
    contextSnapshot: { type: Schema.Types.Mixed, default: null },
    // Hash + timestamp of every earlier submission so a resubmitted handoff keeps a verifiable version trail.
    contextSnapshotHistory: { type: [Schema.Types.Mixed], default: [] },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
    state: { type: String, enum: HANDOFF_STATES, required: true, default: 'DRAFT' },
    // Mirrors state but kept as a plain boolean so the partial unique index
    // below can enforce "one open handoff per project" without re-deriving
    // openness from the state enum inside the index expression.
    isOpen: { type: Boolean, required: true, default: true },
    currentStatus: { type: String, default: '', trim: true },
    items: { type: [handoffItemSchema], default: [] },
    noPendingActionsConfirmed: { type: Boolean, default: false },
    supportingLinks: { type: [String], default: [] },
    documentIds: { type: [Schema.Types.ObjectId], ref: 'Document', default: [] },
    aiDraft: { type: Schema.Types.Mixed, default: null },
    exceptions: { type: [exceptionSchema], default: [] },
    lastValidation: { type: lastValidationSchema, default: null },
    clarifications: { type: [clarificationSchema], default: [] },
    submittedAt: { type: Date, default: null },
    acknowledgedAt: { type: Date, default: null },
    ackReminderSentAt: { type: Date, default: null },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

handoffSchema.index(
  { projectId: 1 },
  { unique: true, partialFilterExpression: { isOpen: true } }
);

export const Handoff = mongoose.model('Handoff', handoffSchema);
