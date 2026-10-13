import mongoose from 'mongoose';
import { TEAM_ROLES, TEAM_MEMBERSHIP_STATUSES } from '../constants.js';

const { Schema } = mongoose;

// Membership belongs to the team, not to a project. ProjectMembership stays the source of truth for project access:
// someone can only receive a handoff on a project if they are also a member of that project.
const teamMembershipSchema = new Schema(
  {
    teamId: { type: Schema.Types.ObjectId, ref: 'ProjectTeam', required: true },
    // Legacy: teams used to belong to one project. Membership is now per team, independent of project.
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: undefined },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: TEAM_ROLES, required: true, default: 'member' },
    status: { type: String, enum: TEAM_MEMBERSHIP_STATUSES, required: true, default: 'active' },
  },
  { timestamps: true }
);

teamMembershipSchema.index({ teamId: 1, userId: 1 }, { unique: true });

export const TeamMembership = mongoose.model('TeamMembership', teamMembershipSchema);
