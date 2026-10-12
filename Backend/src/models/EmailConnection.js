import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  provider: { type: String, enum: ['gmail', 'outlook'], required: true },
  email: { type: String, required: true },
  encryptedTokens: { type: String, required: true, select: false },
}, { timestamps: true });
schema.index({ userId: 1, provider: 1 }, { unique: true });
export const EmailConnection = mongoose.model('EmailConnection', schema);
