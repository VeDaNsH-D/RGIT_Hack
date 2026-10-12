import mongoose from 'mongoose';

const { Schema } = mongoose;

// Append-only, hash-chained audit log. chainKey is the projectId for
// project-scoped events, or the literal string 'system' for cron/system
// actions. seq is strictly increasing per chain starting at 0.
const activityEventSchema = new Schema(
  {
    chainKey: { type: String, required: true, index: true },
    seq: { type: Number, required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorType: { type: String, enum: ['user', 'system'], required: true, default: 'user' },
    action: { type: String, required: true, trim: true },
    targetType: { type: String, default: '' },
    targetId: { type: Schema.Types.ObjectId, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
    occurredAt: { type: Date, required: true },
  },
  { timestamps: true }
);

activityEventSchema.index({ chainKey: 1, seq: 1 }, { unique: true });

export const ActivityEvent = mongoose.model('ActivityEvent', activityEventSchema);
