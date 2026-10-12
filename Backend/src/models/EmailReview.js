import mongoose from 'mongoose';
const { Schema } = mongoose;
const item = new Schema({
  title: String, description: String, priority: String, deadline: Date, rationale: String,
  sourceIds: [String], status: { type: String, enum: ['pending', 'applying', 'applied', 'dismissed'], default: 'pending' },
  targetTaskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
  createdTaskId: { type: Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
  claimAt: Date, applyPayload: { type: Schema.Types.Mixed, default: null },
});
const schema = new Schema({ projectId: { type: Schema.Types.ObjectId, required: true }, createdBy: { type: Schema.Types.ObjectId, required: true }, sourceRecordIds: [Schema.Types.ObjectId], summary: String, decisions: { type: Schema.Types.Mixed }, blockers: { type: Schema.Types.Mixed }, items: [item] }, { timestamps: true });
export const EmailReview = mongoose.model('EmailReview', schema);
