import mongoose from 'mongoose';
import { TASK_ORIGINS, TASK_PRIORITIES, TASK_STATUSES } from '../constants.js';

const { Schema } = mongoose;

export const GITHUB_SYNC_STATUSES = ['pending', 'synced', 'failed', 'not_connected'];

// Link between a Relay task and the GitHub issue created for it. The repository is pinned by
// its stable GitHub id (connectionId points at the project's SourceConnection association).
// The task _id doubles as the correlation key: it is embedded in the issue body so an issue
// created before a failed write-back can be found again instead of being duplicated.
const githubLinkSchema = new Schema(
  {
    status: { type: String, enum: GITHUB_SYNC_STATUSES, required: true },
    connectionId: { type: Schema.Types.ObjectId, ref: 'SourceConnection', default: null },
    repositoryId: { type: Number, default: null },
    fullName: { type: String, default: null },
    htmlUrl: { type: String, default: null },
    issueNumber: { type: Number, default: null },
    issueId: { type: Number, default: null },
    issueUrl: { type: String, default: null },
    error: { type: new Schema({ code: String, message: String }, { _id: false }), default: null },
    warnings: { type: [String], default: [] },
    attempts: { type: Number, default: 0 },
    lockedAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    syncedAt: { type: Date, default: null },
  },
  { _id: false }
);

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
    github: { type: githubLinkSchema, default: undefined },
  },
  { timestamps: true }
);

taskSchema.index({ projectId: 1, status: 1 });
taskSchema.index({ projectId: 1, assignee: 1 });

export const Task = mongoose.model('Task', taskSchema);
