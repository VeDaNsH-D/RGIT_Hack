import mongoose from 'mongoose';

const { Schema } = mongoose;

// A team is a reusable group of people that can work on several projects. `projectIds` lists the projects it is
// currently linked to; being linked is what makes it a valid handoff destination for that project.
const projectTeamSchema = new Schema(
  {
    projectIds: { type: [Schema.Types.ObjectId], ref: 'Project', default: [], index: true },
    // Legacy single-project link from before teams were shareable; folded into projectIds on first use.
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: undefined },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    // Must be an active member of this team; enforced by the teams routes.
    leaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isActive: { type: Boolean, required: true, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

export const ProjectTeam = mongoose.model('ProjectTeam', projectTeamSchema);
