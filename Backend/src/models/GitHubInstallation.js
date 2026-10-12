import mongoose from 'mongoose';

const { Schema } = mongoose;

// PROPOSED (pending Person 2 sign-off): a verified GitHub App installation
// linked to a Relay user's workspace. Holds no credentials: installation access
// tokens are minted on demand from the App key and never stored.
const gitHubInstallationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    installationId: { type: Number, required: true },
    accountLogin: { type: String, required: true },
    accountType: { type: String, enum: ['User', 'Organization'], required: true },
    repositorySelection: { type: String, enum: ['all', 'selected'], default: 'selected' },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    connectedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

gitHubInstallationSchema.index({ userId: 1, installationId: 1 }, { unique: true });

export const GitHubInstallation = mongoose.model('GitHubInstallation', gitHubInstallationSchema);
