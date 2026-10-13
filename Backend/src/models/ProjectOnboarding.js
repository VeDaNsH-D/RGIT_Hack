import mongoose from 'mongoose';

const { Schema } = mongoose;

export const ONBOARDING_STATUSES = ['pending', 'preparing', 'ready', 'in_progress', 'completed'];

const onboardingSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ['member', 'viewer'], default: 'member', required: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    invitationId: { type: Schema.Types.ObjectId, ref: 'ProjectInvitation', default: null },
    selectedDocumentIds: [{ type: Schema.Types.ObjectId, ref: 'Document' }],
    status: {
      type: String,
      enum: ONBOARDING_STATUSES,
      default: 'ready',
      index: true,
    },
    contextVersion: { type: Number, default: 1 },
    contextGeneratedAt: { type: Date, default: Date.now },
    contextGenerationStatus: {
      type: String,
      enum: ['ready', 'generating', 'failed'],
      default: 'ready',
    },
    contextGenerationError: { type: String, default: null },
    contextPack: { type: Schema.Types.Mixed, default: null },
    reviewedSections: [{ type: String }],
    reviewedDocumentIds: [{ type: Schema.Types.ObjectId, ref: 'Document' }],
    notes: { type: String, default: '' },
    completedAt: { type: Date, default: null },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Prevent duplicate active onboarding assignments for the same email in the same project
onboardingSchema.index({ projectId: 1, email: 1 }, { unique: true });

export const ProjectOnboarding = mongoose.model('ProjectOnboarding', onboardingSchema);
