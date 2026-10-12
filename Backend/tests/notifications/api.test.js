import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_DELIVERY_STATUS,
  NotificationService,
  InMemoryNotificationRepository,
  createNotificationRouter,
  NotificationRepositoryError,
} from '../../src/notifications/index.js';

describe('Notification Storage & REST API Integration Suite', () => {
  let repository;
  let service;
  let testApp;
  let server;
  let baseUrl;

  before(async () => {
    repository = new InMemoryNotificationRepository();
    service = new NotificationService({ repository });

    testApp = express();
    testApp.use(express.json());
    testApp.use('/api/notifications', createNotificationRouter({ repository }));

    // Global error handler
    testApp.use((err, req, res, next) => {
      const status = err.status || err.statusCode || 500;
      res.status(status).json({
        error: err.code || 'internal_error',
        message: status < 500 ? err.message : 'Internal server error',
      });
    });

    server = http.createServer(testApp);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api/notifications`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    repository.clear();
  });

  describe('1. Successful Notification Persistence via Service', () => {
    it('should persist event to repository and allow querying', async () => {
      const event = {
        eventId: 'evt_persist_001',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_api_001',
        recipientUserId: 'usr_alice',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_001',
        outgoingUserId: 'usr_bob',
        handoffTitle: 'Production Handoff',
      };

      const record = await service.processEvent(event);
      assert.ok(record.id);

      const found = await repository.findById(record.id);
      assert.deepEqual(found, record);
    });
  });

  describe('2. Notification Retrieval for Authenticated User', () => {
    it('should return notifications only for the authenticated recipient', async () => {
      await service.processEvent({
        eventId: 'evt_alice_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_alice',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_1',
        outgoingUserId: 'usr_lead',
      });

      await service.processEvent({
        eventId: 'evt_bob_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        projectId: 'proj_1',
        recipientUserId: 'usr_bob',
        occurredAt: '2026-10-12T12:00:00Z',
        entityId: 'hnd_1',
        outgoingUserId: 'usr_lead',
      });

      const res = await fetch(baseUrl, {
        headers: { 'x-user-id': 'usr_alice' },
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.items.length, 1);
      assert.equal(json.data.items[0].recipientUserId, 'usr_alice');
    });

    it('should reject unauthenticated request with 401', async () => {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.error, 'unauthorized');
    });
  });

  describe('3. Pagination and Ordering', () => {
    it('should order newest first and respect limit and offset', async () => {
      // Insert three records at different timestamps
      const baseDate = Date.now();
      for (let i = 1; i <= 3; i++) {
        await repository.create({
          id: `rec_page_${i}`,
          recipientUserId: 'usr_carol',
          eventId: `evt_page_${i}`,
          type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
          title: `Notification ${i}`,
          message: `Message ${i}`,
          projectId: 'proj_1',
          entityId: `hnd_${i}`,
          readAt: null,
          createdAt: new Date(baseDate + i * 1000).toISOString(),
          deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
        });
      }

      // Query limit 2, offset 0 -> newest first (rec_page_3, rec_page_2)
      const res1 = await fetch(`${baseUrl}?limit=2&offset=0`, {
        headers: { 'x-user-id': 'usr_carol' },
      });
      const json1 = await res1.json();
      assert.equal(json1.data.items.length, 2);
      assert.equal(json1.data.items[0].id, 'rec_page_3');
      assert.equal(json1.data.items[1].id, 'rec_page_2');

      // Query limit 2, offset 2 -> rec_page_1
      const res2 = await fetch(`${baseUrl}?limit=2&offset=2`, {
        headers: { 'x-user-id': 'usr_carol' },
      });
      const json2 = await res2.json();
      assert.equal(json2.data.items.length, 1);
      assert.equal(json2.data.items[0].id, 'rec_page_1');
    });
  });

  describe('4. Unread Count Endpoint', () => {
    it('should accurately return count of unread notifications', async () => {
      await repository.create({
        id: 'rec_unread_1',
        recipientUserId: 'usr_david',
        eventId: 'evt_d_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        title: 'Title',
        message: 'Message',
        projectId: 'proj_1',
        entityId: 'hnd_1',
        readAt: null,
        createdAt: new Date().toISOString(),
        deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
      });

      await repository.create({
        id: 'rec_read_2',
        recipientUserId: 'usr_david',
        eventId: 'evt_d_2',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_ACCEPTED,
        title: 'Title',
        message: 'Message',
        projectId: 'proj_1',
        entityId: 'hnd_1',
        readAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        deliveryStatus: NOTIFICATION_DELIVERY_STATUS.SENT,
      });

      const res = await fetch(`${baseUrl}/unread-count`, {
        headers: { 'x-user-id': 'usr_david' },
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.data.unreadCount, 1);
    });
  });

  describe('5. Mark One Notification as Read', () => {
    it('should set readAt timestamp and return updated record', async () => {
      const record = await repository.create({
        id: 'rec_mark_single',
        recipientUserId: 'usr_eva',
        eventId: 'evt_eva_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        title: 'Title',
        message: 'Message',
        projectId: 'proj_1',
        entityId: 'hnd_1',
        readAt: null,
        createdAt: new Date().toISOString(),
        deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
      });

      const res = await fetch(`${baseUrl}/${record.id}/read`, {
        method: 'PATCH',
        headers: { 'x-user-id': 'usr_eva' },
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.readAt);

      const updatedInRepo = await repository.findById(record.id);
      assert.ok(updatedInRepo.readAt);
    });
  });

  describe('6. Mark All Notifications as Read', () => {
    it('should atomically update all unread notifications for authenticated user', async () => {
      for (let i = 1; i <= 3; i++) {
        await repository.create({
          id: `rec_all_${i}`,
          recipientUserId: 'usr_frank',
          eventId: `evt_all_${i}`,
          type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
          title: `Title ${i}`,
          message: 'Message',
          projectId: 'proj_1',
          entityId: `hnd_${i}`,
          readAt: null,
          createdAt: new Date().toISOString(),
          deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
        });
      }

      const res = await fetch(`${baseUrl}/read-all`, {
        method: 'PATCH',
        headers: { 'x-user-id': 'usr_frank' },
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.data.updatedCount, 3);

      const unreadCount = await repository.countUnread('usr_frank');
      assert.equal(unreadCount, 0);
    });
  });

  describe('7. Attempts to Access Another User’s Notification', () => {
    it('should reject marking another user notification as read with 404 (leak prevention)', async () => {
      const record = await repository.create({
        id: 'rec_private_victim',
        recipientUserId: 'usr_victim',
        eventId: 'evt_victim_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        title: 'Confidential',
        message: 'Secret',
        projectId: 'proj_1',
        entityId: 'hnd_1',
        readAt: null,
        createdAt: new Date().toISOString(),
        deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
      });

      // Attacker usr_attacker tries to mark victim's record as read
      const res = await fetch(`${baseUrl}/${record.id}/read`, {
        method: 'PATCH',
        headers: { 'x-user-id': 'usr_attacker' },
      });

      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.error, 'not_found');

      // Confirm record was NOT modified
      const untouched = await repository.findById(record.id);
      assert.equal(untouched.readAt, null);
    });
  });

  describe('8. Invalid Identifiers and Query Parameters', () => {
    it('should reject invalid limit parameter with 400', async () => {
      const res = await fetch(`${baseUrl}?limit=-5`, {
        headers: { 'x-user-id': 'usr_alice' },
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error, 'bad_request');
    });

    it('should reject invalid offset parameter with 400', async () => {
      const res = await fetch(`${baseUrl}?offset=invalid`, {
        headers: { 'x-user-id': 'usr_alice' },
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error, 'bad_request');
    });

    it('should reject invalid unreadOnly parameter with 400', async () => {
      const res = await fetch(`${baseUrl}?unreadOnly=maybe`, {
        headers: { 'x-user-id': 'usr_alice' },
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error, 'bad_request');
    });
  });

  describe('9. Missing Notifications', () => {
    it('should return 404 when marking a non-existent notification ID as read', async () => {
      const res = await fetch(`${baseUrl}/rec_non_existent_id/read`, {
        method: 'PATCH',
        headers: { 'x-user-id': 'usr_alice' },
      });
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.error, 'not_found');
    });
  });

  describe('10. Database Failures Handling', () => {
    it('should propagate database failure to error handler without leaking internal details', async () => {
      const failingRepo = {
        async findByRecipient() {
          throw new NotificationRepositoryError('Fatal DB cluster disconnect');
        },
      };

      const failApp = express();
      failApp.use(express.json());
      failApp.use('/api/notifications', createNotificationRouter({ repository: failingRepo }));
      failApp.use((err, req, res, next) => {
        res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
      });

      const failServer = http.createServer(failApp);
      await new Promise((resolve) => failServer.listen(0, resolve));
      const failPort = failServer.address().port;

      try {
        const res = await fetch(`http://127.0.0.1:${failPort}/api/notifications`, {
          headers: { 'x-user-id': 'usr_alice' },
        });
        assert.equal(res.status, 500);
        const json = await res.json();
        assert.equal(json.error, 'internal_error');
        assert.equal(json.message, 'Internal server error'); // No leak of DB stack or details
      } finally {
        await new Promise((resolve) => failServer.close(resolve));
      }
    });
  });

  describe('11. Repeated Mark-As-Read Requests (Idempotency)', () => {
    it('should safely return success on repeated calls without altering existing readAt', async () => {
      const record = await repository.create({
        id: 'rec_repeat_test',
        recipientUserId: 'usr_grace',
        eventId: 'evt_grace_1',
        type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
        title: 'Title',
        message: 'Message',
        projectId: 'proj_1',
        entityId: 'hnd_1',
        readAt: null,
        createdAt: new Date().toISOString(),
        deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
      });

      // First call
      const res1 = await fetch(`${baseUrl}/${record.id}/read`, {
        method: 'PATCH',
        headers: { 'x-user-id': 'usr_grace' },
      });
      const json1 = await res1.json();
      assert.equal(res1.status, 200);
      const firstReadAt = json1.data.readAt;
      assert.ok(firstReadAt);

      // Repeated call
      const res2 = await fetch(`${baseUrl}/${record.id}/read`, {
        method: 'PATCH',
        headers: { 'x-user-id': 'usr_grace' },
      });
      const json2 = await res2.json();
      assert.equal(res2.status, 200);
      assert.equal(json2.data.readAt, firstReadAt);
    });
  });
});
