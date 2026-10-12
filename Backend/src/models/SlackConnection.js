import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    botToken: { type: String, required: true },
    teamDomain: { type: String, default: '' },
    channelId: { type: String, default: '' },
    teamName: { type: String, default: '' },
    active: { type: Boolean, default: true },
    connectedAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date },
    syncedMessageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const SlackConnection = mongoose.model('SlackConnection', schema);
