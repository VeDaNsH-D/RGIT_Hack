import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authType: { type: String, enum: ['oauth', 'api_token'], default: 'oauth' },
    cloudId: { type: String, default: '' },
    siteUrl: { type: String, default: '' },
    siteName: { type: String, default: '' },
    accessToken: { type: String, default: '' },
    refreshToken: { type: String, default: '' },
    tokenExpiresAt: { type: Date },
    scopes: { type: [String], default: [] },
    host: { type: String, default: '' },
    email: { type: String, default: '' },
    apiToken: { type: String, default: '' },
    projectKey: { type: String, default: '' },
    active: { type: Boolean, default: true },
    connectedAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date },
    syncedIssueCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const JiraConnection = mongoose.model('JiraConnection', schema);
