/**
 * Production Mongoose Notification Repository
 * 
 * Persists and retrieves notification presentation records using the canonical
 * Mongoose model and MongoDB database connection.
 */

import { NotificationModel } from '../models/Notification.js';
import { NotificationRepositoryError } from './repository.js';
import { DuplicateNotificationEventError } from './service.js';

export class MongooseNotificationRepository {
  /**
   * @param {import('mongoose').Model} [model] Optional model override
   */
  constructor(model = NotificationModel) {
    this.model = model;
  }

  /**
   * Persists a notification record to MongoDB.
   * 
   * @param {import('./records.js').NotificationRecord} record
   * @returns {Promise<import('./records.js').NotificationRecord>}
   */
  async create(record) {
    try {
      const doc = await this.model.create(record);
      return doc.toObject();
    } catch (err) {
      if (err.code === 11000) {
        if (err.keyPattern && err.keyPattern.eventId) {
          throw new DuplicateNotificationEventError(record.eventId, record);
        }
        throw new NotificationRepositoryError(
          `Notification with id '${record.id}' already exists in database.`,
          err
        );
      }
      throw new NotificationRepositoryError(
        `Failed to persist notification to MongoDB: ${err.message}`,
        err
      );
    }
  }

  /**
   * Retrieves a notification by its unique ID.
   * 
   * @param {string} id
   * @returns {Promise<import('./records.js').NotificationRecord | null>}
   */
  async findById(id) {
    if (!id || typeof id !== 'string') return null;

    try {
      const doc = await this.model.findOne({ id }).lean();
      if (!doc) return null;
      delete doc._id;
      return doc;
    } catch (err) {
      throw new NotificationRepositoryError(
        `Database failure looking up notification '${id}': ${err.message}`,
        err
      );
    }
  }

  /**
   * Retrieves paginated notifications for an authenticated recipient.
   * 
   * @param {string} recipientUserId
   * @param {{ unreadOnly?: boolean, limit?: number, offset?: number }} [options={}]
   * @returns {Promise<import('./records.js').NotificationRecord[]>}
   */
  async findByRecipient(recipientUserId, options = {}) {
    if (!recipientUserId || typeof recipientUserId !== 'string') return [];

    try {
      const query = { recipientUserId };
      if (options.unreadOnly) {
        query.readAt = null;
      }

      let cursor = this.model.find(query).sort({ createdAt: -1 });

      const offset = Math.max(0, options.offset || 0);
      if (offset > 0) {
        cursor = cursor.skip(offset);
      }

      const limit = options.limit;
      if (typeof limit === 'number' && limit > 0) {
        cursor = cursor.limit(limit);
      }

      const docs = await cursor.lean();
      return docs.map((doc) => {
        delete doc._id;
        return doc;
      });
    } catch (err) {
      throw new NotificationRepositoryError(
        `Database failure retrieving notifications for user '${recipientUserId}': ${err.message}`,
        err
      );
    }
  }

  /**
   * Finds a notification associated with a specific event ID for duplicate detection.
   * 
   * @param {string} eventId
   * @returns {Promise<import('./records.js').NotificationRecord | null>}
   */
  async findByEventId(eventId) {
    if (!eventId || typeof eventId !== 'string') return null;

    try {
      const doc = await this.model.findOne({ eventId }).lean();
      if (!doc) return null;
      delete doc._id;
      return doc;
    } catch (err) {
      throw new NotificationRepositoryError(
        `Database failure querying eventId '${eventId}': ${err.message}`,
        err
      );
    }
  }

  /**
   * Counts unread notifications for a recipient user.
   * 
   * @param {string} recipientUserId
   * @returns {Promise<number>}
   */
  async countUnread(recipientUserId) {
    if (!recipientUserId || typeof recipientUserId !== 'string') return 0;

    try {
      return await this.model.countDocuments({
        recipientUserId,
        readAt: null,
      });
    } catch (err) {
      throw new NotificationRepositoryError(
        `Database failure counting unread notifications: ${err.message}`,
        err
      );
    }
  }

  /**
   * Atomically marks a single notification as read if it belongs to recipientUserId.
   * 
   * @param {string} id
   * @param {string} recipientUserId
   * @returns {Promise<import('./records.js').NotificationRecord | null>}
   */
  async markAsRead(id, recipientUserId) {
    if (!id || !recipientUserId) return null;

    try {
      const nowIso = new Date().toISOString();
      const doc = await this.model.findOneAndUpdate(
        { id, recipientUserId },
        {
          $set: {
            readAt: nowIso,
          },
        },
        { new: true }
      ).lean();

      if (!doc) return null;
      delete doc._id;
      return doc;
    } catch (err) {
      throw new NotificationRepositoryError(
        `Database failure marking notification '${id}' as read: ${err.message}`,
        err
      );
    }
  }

  /**
   * Atomically marks all unread notifications for a recipient as read.
   * 
   * @param {string} recipientUserId
   * @returns {Promise<{ updatedCount: number }>}
   */
  async markAllAsRead(recipientUserId) {
    if (!recipientUserId) return { updatedCount: 0 };

    try {
      const nowIso = new Date().toISOString();
      const res = await this.model.updateMany(
        { recipientUserId, readAt: null },
        { $set: { readAt: nowIso } }
      );

      return { updatedCount: res.modifiedCount || 0 };
    } catch (err) {
      throw new NotificationRepositoryError(
        `Database failure marking all notifications as read: ${err.message}`,
        err
      );
    }
  }
}
