import mongoose from 'mongoose';
import { TASK_ORIGINS, TASK_PRIORITIES, TASK_STATUSES } from '../constants.js';

const { Schema } = mongoose;

const taskSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    origin: { type: String, enum: TASK_ORIGINS, required: true, default: 'manual' },
    sourceRecordId: { type: Schema.Types.ObjectId, ref: 'SourceRecord', default: null },
    assignee: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deadline: { type: Date, default: null },
    priority: { type: String, enum: TASK_PRIORITIES, required: true, default: 'medium' },
    status: { type: String, enum: TASK_STATUSES, required: true, default: 'open' },
    completedAt: { type: Date, default: null },
    overdueNotifiedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

taskSchema.index({ projectId: 1, status: 1 });
taskSchema.index({ projectId: 1, assignee: 1 });

export const Task = mongoose.model('Task', taskSchema);
