import mongoose from 'mongoose';

const { Schema } = mongoose;

const ownershipHistoryEntrySchema = new Schema(
  {
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    handoffId: { type: Schema.Types.ObjectId, ref: 'Handoff', required: true },
    fromTeamId: { type: Schema.Types.ObjectId, ref: 'ProjectTeam', default: null },
    toTeamId: { type: Schema.Types.ObjectId, ref: 'ProjectTeam', default: null },
    reason: { type: String, default: '' },
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
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
    // The team that currently owns the project (null until a team is assigned). Distinct from ownerId, the responsible person.
    owningTeamId: { type: Schema.Types.ObjectId, ref: 'ProjectTeam', default: null },
    ownershipHistory: { type: [ownershipHistoryEntrySchema], default: [] },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Project = mongoose.model('Project', projectSchema);
