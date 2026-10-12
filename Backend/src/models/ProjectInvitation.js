import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  role: { type: String, enum: ['member', 'viewer'], required: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  status: { type: String, enum: ['sending', 'pending', 'failed', 'accepted', 'revoked'], default: 'sending' },
  expiresAt: { type: Date, required: true },
  acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  acceptedAt: { type: Date, default: null },
}, { timestamps: true });
export const ProjectInvitation = mongoose.model('ProjectInvitation', schema);
