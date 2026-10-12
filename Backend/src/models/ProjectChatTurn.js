import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  question: { type: String, required: true },
  answer: { type: String, required: true },
  citations: { type: [mongoose.Schema.Types.Mixed], default: [] },
  limitations: { type: [String], default: [] },
}, { timestamps: true });
schema.index({ projectId: 1, userId: 1, createdAt: -1 });
export const ProjectChatTurn = mongoose.model('ProjectChatTurn', schema);
