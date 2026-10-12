import mongoose from 'mongoose';
import { CONFLICT_SEVERITIES, CONFLICT_STATUSES } from '../constants.js';

const { Schema } = mongoose;

const conflictSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    fingerprint: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    severity: { type: String, enum: CONFLICT_SEVERITIES, required: true, default: 'medium' },
    status: { type: String, enum: CONFLICT_STATUSES, required: true, default: 'open' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolutionNote: { type: String, default: '' },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

conflictSchema.index({ projectId: 1, fingerprint: 1 }, { unique: true });
conflictSchema.index({ projectId: 1, status: 1, severity: 1 });

export const Conflict = mongoose.model('Conflict', conflictSchema);
