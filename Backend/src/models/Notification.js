import mongoose from 'mongoose';
import { NOTIFICATION_EVENT_TYPES } from '../constants.js';

const { Schema } = mongoose;

// Minimal in-app fallback sink for notification events (see
// src/notifications/events.js). Person 4's delivery module (WhatsApp/etc.)
// is expected to register its own handler and may replace or supplement
// this one.
const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    type: { type: String, enum: NOTIFICATION_EVENT_TYPES, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    // Used to prevent duplicate alerts for the same underlying occurrence
    // (e.g. one TASK_OVERDUE per task per day). Sparse so events that don't
    // need dedupe can omit it.
    dedupeKey: { type: String, default: null },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

export const Notification = mongoose.model('Notification', notificationSchema);
