import mongoose from 'mongoose';
export const NotionInstallState = mongoose.model('NotionInstallState', new mongoose.Schema({
  stateHash: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}));
