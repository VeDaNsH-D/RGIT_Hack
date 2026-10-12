/**
 * WhatsApp Cloud API Adapter Test Suite
 * 
 * Verifies Twilio and Meta WhatsApp Cloud API dispatch, payload mapping,
 * phone formatting, error handling, and duplicate protection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WhatsAppCloudApiAdapter,
  WhatsAppConfigError,
  InvalidRecipientError,
  WhatsAppSendFailedError,
  DeliveryAttemptTracker,
} from '../../src/notifications/whatsapp/index.js';
import {
  NotificationDeliveryDispatcher,
  InMemoryNotificationRepository,
  NOTIFICATION_EVENT_TYPES,
} from '../../src/notifications/index.js';

describe('WhatsApp Cloud API Delivery Adapter Suite', () => {
  const sampleNotification = {
    id: 'notif_cloud_001',
    eventId: 'evt_cloud_001',
    type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
    title: 'Deployment Ready',
    message: 'Backend handoff package is ready.',
    projectId: 'alpha-project',
    entityId: 'pkg-999',
    recipientUserId: 'usr_sarah',
    recipientPhone: '+14155552671',
    createdAt: new Date().toISOString(),
    deliveryStatus: 'PENDING',
  };

  it('1. should reject send if Twilio credentials are missing in Twilio mode', async () => {
    const adapter = new WhatsAppCloudApiAdapter({
      config: {
        provider: 'twilio',
        twilioAccountSid: '',
        twilioAuthToken: '',
      },
    });

    await assert.rejects(
      () => adapter.send(sampleNotification),
      (err) => {
        assert.ok(err instanceof WhatsAppConfigError);
        assert.match(err.message, /TWILIO_ACCOUNT_SID/);
        return true;
      }
    );
  });

  it('2. should reject send if Meta Cloud credentials are missing in Meta mode', async () => {
    const adapter = new WhatsAppCloudApiAdapter({
      config: {
        provider: 'meta',
        metaToken: '',
        metaPhoneNumberId: '',
      },
    });

    await assert.rejects(
      () => adapter.send(sampleNotification),
      (err) => {
        assert.ok(err instanceof WhatsAppConfigError);
        assert.match(err.message, /META_WHATSAPP_TOKEN/);
        return true;
      }
    );
  });

  it('3. should reject send if recipient phone format is invalid', async () => {
    const adapter = new WhatsAppCloudApiAdapter({
      config: {
        provider: 'twilio',
        twilioAccountSid: 'ACmock123',
        twilioAuthToken: 'tokenmock123',
      },
    });

    const invalidNotif = {
      ...sampleNotification,
      id: 'notif_cloud_invalid_phone',
      recipientPhone: '9876543210', // Missing +
    };

    await assert.rejects(
      () => adapter.send(invalidNotif),
      (err) => {
        assert.ok(err instanceof InvalidRecipientError);
        return true;
      }
    );
  });

  it('4. should successfully dispatch WhatsApp notification via Twilio REST API', async () => {
    let capturedUrl = null;
    let capturedHeaders = null;
    let capturedBody = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      capturedBody = new URLSearchParams(options.body);

      return {
        ok: true,
        status: 201,
        json: async () => ({
          sid: 'SMmock_twilio_sid_12345',
          status: 'queued',
        }),
      };
    };

    const adapter = new WhatsAppCloudApiAdapter({
      config: {
        provider: 'twilio',
        fromPhone: '+919021875564',
        twilioAccountSid: 'ACmock_sid',
        twilioAuthToken: 'auth_mock_token',
      },
      fetchClient: mockFetch,
    });

    const result = await adapter.send(sampleNotification);

    assert.equal(result.success, true);
    assert.equal(result.status, 'SENT');
    assert.equal(result.attemptStatus, 'SUBMITTED_CONFIRMED');
    assert.equal(result.externalId, 'SMmock_twilio_sid_12345');

    assert.ok(capturedUrl.includes('/Accounts/ACmock_sid/Messages.json'));
    assert.equal(capturedBody.get('From'), 'whatsapp:+919021875564');
    assert.equal(capturedBody.get('To'), 'whatsapp:+14155552671');
    assert.ok(capturedBody.get('Body').includes('*Project Handoff Submitted*'));
  });

  it('5. should successfully dispatch WhatsApp notification via Meta Cloud API', async () => {
    let capturedUrl = null;
    let capturedHeaders = null;
    let capturedJson = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      capturedJson = JSON.parse(options.body);

      return {
        ok: true,
        status: 200,
        json: async () => ({
          messaging_product: 'whatsapp',
          contacts: [{ input: '14155552671', wa_id: '14155552671' }],
          messages: [{ id: 'wamid.HBgLMTQxNTU1NTI2NzEVAgARGBI' }],
        }),
      };
    };

    const adapter = new WhatsAppCloudApiAdapter({
      config: {
        provider: 'meta',
        fromPhone: '+919021875564',
        metaToken: 'meta_test_access_token',
        metaPhoneNumberId: '10987654321',
      },
      fetchClient: mockFetch,
    });

    const result = await adapter.send(sampleNotification);

    assert.equal(result.success, true);
    assert.equal(result.status, 'SENT');
    assert.equal(result.externalId, 'wamid.HBgLMTQxNTU1NTI2NzEVAgARGBI');

    assert.ok(capturedUrl.includes('/10987654321/messages'));
    assert.equal(capturedHeaders['Authorization'], 'Bearer meta_test_access_token');
    assert.equal(capturedJson.to, '14155552671');
    assert.ok(capturedJson.text.body.includes('*Project Handoff Submitted*'));
  });

  it('6. should handle upstream API error response gracefully', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({
        code: 20003,
        message: 'Authenticate',
      }),
    });

    const adapter = new WhatsAppCloudApiAdapter({
      config: {
        provider: 'twilio',
        fromPhone: '+919021875564',
        twilioAccountSid: 'ACinvalid',
        twilioAuthToken: 'tokeninvalid',
      },
      fetchClient: mockFetch,
    });

    await assert.rejects(
      () => adapter.send(sampleNotification),
      (err) => {
        assert.ok(err instanceof WhatsAppSendFailedError);
        assert.match(err.message, /Twilio WhatsApp dispatch failed/);
        return true;
      }
    );
  });

  it('7. should protect against duplicate sends using attempt tracker', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 201,
        json: async () => ({ sid: 'SMtest_duplicate' }),
      };
    };

    const attemptTracker = new DeliveryAttemptTracker();
    const adapter = new WhatsAppCloudApiAdapter({
      config: {
        provider: 'twilio',
        fromPhone: '+919021875564',
        twilioAccountSid: 'ACmock',
        twilioAuthToken: 'auth_mock',
      },
      attemptTracker,
      fetchClient: mockFetch,
    });

    // 1st call
    const res1 = await adapter.send(sampleNotification);
    assert.equal(res1.success, true);
    assert.equal(callCount, 1);

    // 2nd call with same notificationId returns cached outcome without HTTP request
    const res2 = await adapter.send(sampleNotification);
    assert.equal(res2.success, true);
    assert.equal(res2.attemptStatus, 'ALREADY_SENT');
    assert.equal(callCount, 1);
  });

  it('8. should integrate cleanly into NotificationDeliveryDispatcher', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sid: 'SM_dispatch_test' }),
    });

    const adapter = new WhatsAppCloudApiAdapter({
      config: {
        provider: 'twilio',
        fromPhone: '+919021875564',
        twilioAccountSid: 'ACmock',
        twilioAuthToken: 'auth_mock',
      },
      fetchClient: mockFetch,
    });

    const repo = new InMemoryNotificationRepository();
    await repo.create(sampleNotification);

    const dispatcher = new NotificationDeliveryDispatcher({
      repository: repo,
      providers: [adapter],
    });

    const dispatchResult = await dispatcher.dispatch(sampleNotification);

    assert.equal(dispatchResult.success, true);
    assert.equal(dispatchResult.status, 'SENT');
    assert.equal(dispatchResult.results[0].externalId, 'SM_dispatch_test');
  });
});
