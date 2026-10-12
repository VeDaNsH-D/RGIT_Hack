import mongoose from 'mongoose';

const { Schema } = mongoose;

const ownershipHistoryEntrySchema = new Schema(
  {
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    handoffId: { type: Schema.Types.ObjectId, ref: 'Handoff', required: true },
    changedAt: { type: Date, required: true },
  },
  { _id: false }
);

const projectSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ownershipHistory: { type: [ownershipHistoryEntrySchema], default: [] },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Project = mongoose.model('Project', projectSchema);
