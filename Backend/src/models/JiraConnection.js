import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    host: { type: String, required: true },
    email: { type: String, default: '' },
    apiToken: { type: String, required: true },
    projectKey: { type: String, default: '' },
    active: { type: Boolean, default: true },
    connectedAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date },
    syncedIssueCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const JiraConnection = mongoose.model('JiraConnection', schema);
