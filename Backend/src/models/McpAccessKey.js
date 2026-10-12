import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, maxlength: 80 },
  tokenHash: { type: String, required: true, unique: true, select: false },
  prefix: { type: String, required: true },
  projectIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Project' }],
  access: { type: String, enum: ['read', 'write'], default: 'read' },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  lastUsedAt: { type: Date, default: null },
  oauthClientId: { type: String, default: null },
  oauthScopes: [String],
  oauthResource: String,
  refreshTokenHash: { type: String, select: false },
}, { timestamps: true });
export const McpAccessKey = mongoose.model('McpAccessKey', schema);
