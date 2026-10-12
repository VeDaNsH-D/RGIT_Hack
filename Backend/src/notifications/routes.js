/**
 * Notification REST API Router
 * 
 * Implements authenticated endpoints for querying, counting, and marking
 * notifications as read.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { MongooseNotificationRepository } from './mongooseRepository.js';

/**
 * Creates an Express router for notification endpoints with dependency injection.
 * 
 * @param {object} [options={}]
 * @param {object} [options.repository] Storage repository instance
 * @returns {import('express').Router}
 */
export function createNotificationRouter({
  repository = new MongooseNotificationRepository(),
} = {}) {
  const router = Router();

  // All notification endpoints require authenticated user identity
  router.use(requireAuth);

  /**
   * GET /api/notifications
   * List notifications for the authenticated user with pagination and optional unread filter.
   */
  router.get('/', async (req, res, next) => {
    try {
      const recipientUserId = req.user.id;

      // Validate pagination & filter query parameters
      let limit = 20;
      if (req.query.limit !== undefined) {
        const parsedLimit = Number(req.query.limit);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
          return res.status(400).json({
            error: 'bad_request',
            message: "Query parameter 'limit' must be an integer between 1 and 100.",
          });
        }
        limit = parsedLimit;
      }

      let offset = 0;
      if (req.query.offset !== undefined) {
        const parsedOffset = Number(req.query.offset);
        if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
          return res.status(400).json({
            error: 'bad_request',
            message: "Query parameter 'offset' must be a non-negative integer.",
          });
        }
        offset = parsedOffset;
      }

      let unreadOnly = false;
      if (req.query.unreadOnly !== undefined) {
        if (req.query.unreadOnly === 'true') {
          unreadOnly = true;
        } else if (req.query.unreadOnly === 'false') {
          unreadOnly = false;
        } else {
          return res.status(400).json({
            error: 'bad_request',
            message: "Query parameter 'unreadOnly' must be 'true' or 'false'.",
          });
        }
      }

      const items = await repository.findByRecipient(recipientUserId, {
        limit,
        offset,
        unreadOnly,
      });

      return res.status(200).json({
        success: true,
        data: {
          items,
          pagination: {
            limit,
            offset,
            count: items.length,
          },
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * GET /api/notifications/unread-count
   * Efficiently counts unread notifications for the authenticated user.
   */
  router.get('/unread-count', async (req, res, next) => {
    try {
      const recipientUserId = req.user.id;
      const count = await repository.countUnread(recipientUserId);

      return res.status(200).json({
        success: true,
        data: {
          unreadCount: count,
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * PATCH /api/notifications/:id/read
   * Marks a single notification as read, ensuring ownership validation.
   */
  router.patch('/:id/read', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || typeof id !== 'string' || !id.trim()) {
        return res.status(400).json({
          error: 'bad_request',
          message: 'Notification ID parameter is required.',
        });
      }

      const recipientUserId = req.user.id;
      const notification = await repository.markAsRead(id.trim(), recipientUserId);

      if (!notification) {
        // Return 404 to avoid leaking whether another user's notification exists
        return res.status(404).json({
          error: 'not_found',
          message: 'Notification not found.',
        });
      }

      return res.status(200).json({
        success: true,
        data: notification,
      });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * PATCH /api/notifications/read-all
   * Atomically marks all unread notifications for the authenticated user as read.
   */
  router.patch('/read-all', async (req, res, next) => {
    try {
      const recipientUserId = req.user.id;
      const result = await repository.markAllAsRead(recipientUserId);

      return res.status(200).json({
        success: true,
        message: 'All unread notifications marked as read',
        data: {
          updatedCount: result.updatedCount,
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

export const notificationRouter = createNotificationRouter();
