import mongoose from 'mongoose';
import { NOTIFICATION_EVENT_TYPES } from '../notifications/events.js';
import { NOTIFICATION_DELIVERY_STATUS } from '../notifications/records.js';

const notificationSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    recipientUserId: {
      type: String,
      required: true,
      index: true,
    },
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: [...Object.values(NOTIFICATION_EVENT_TYPES), 'PROJECT_ACTIVITY'],
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    projectId: {
      type: String,
      required: true,
      index: true,
    },
    entityId: {
      type: String,
      required: true,
      index: true,
    },
    readAt: {
      type: String,
      default: null,
      index: true,
    },
    createdAt: {
      type: String,
      required: true,
      index: true,
    },
    deliveryStatus: {
      type: String,
      enum: Object.values(NOTIFICATION_DELIVERY_STATUS),
      default: NOTIFICATION_DELIVERY_STATUS.PENDING,
      index: true,
    },
  },
  {
    timestamps: false,
    versionKey: false,
    toJSON: {
      transform: (doc, ret) => {
        delete ret._id;
        return ret;
      },
    },
    toObject: {
      transform: (doc, ret) => {
        delete ret._id;
        return ret;
      },
    },
  }
);

// Compound index for querying a user's notifications efficiently by date or unread status
notificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });

export const NotificationModel =
  mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
