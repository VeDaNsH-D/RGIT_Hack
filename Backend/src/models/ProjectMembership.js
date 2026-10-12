import mongoose from 'mongoose';
import { ROLES } from '../constants.js';

const { Schema } = mongoose;

const projectMembershipSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLES, required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

projectMembershipSchema.index({ projectId: 1, userId: 1 }, { unique: true });

export const ProjectMembership = mongoose.model('ProjectMembership', projectMembershipSchema);
