import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    apiKey: { type: String, required: true },
    pageId: { type: String, default: '' },
    databaseId: { type: String, default: '' },
    workspaceName: { type: String, default: '' },
    active: { type: Boolean, default: true },
    connectedAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date },
    syncedPageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const NotionConnection = mongoose.model('NotionConnection', schema);
