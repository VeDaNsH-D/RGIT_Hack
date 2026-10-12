/**
 * WhatsApp Cloud API Delivery Adapter
 * 
 * Provides production-grade WhatsApp message dispatching using direct HTTP REST APIs
 * (Twilio WhatsApp API or Meta WhatsApp Business Cloud API).
 * Eliminates browser automation, QR code scanning, session expiration, and DOM fragility.
 * 
 * Originating sender is permanently configured (defaults to +919021875564).
 */

import { formatWhatsAppMessage } from './whatsappTemplates.js';
import { assertValidPhoneNumber } from './phoneValidator.js';
import { DeliveryAttemptTracker, ATTEMPT_STATE } from './deliveryAttemptTracker.js';
import {
  WhatsAppConfigError,
  WhatsAppSendFailedError,
  InvalidRecipientError,
  DuplicateDeliveryPreventedError,
} from './whatsappErrors.js';
import { logNotification } from '../reliability/logger.js';

export class WhatsAppCloudApiAdapter {
  /**
   * @param {object} [options={}]
   * @param {object} [options.config={}] Cloud API configuration overrides
   * @param {DeliveryAttemptTracker} [options.attemptTracker]
   * @param {((userId: string) => Promise<string|null>)} [options.phoneResolver]
   * @param {typeof fetch} [options.fetchClient] Injectable fetch for testing
   */
  constructor({
    config = {},
    attemptTracker = new DeliveryAttemptTracker(),
    phoneResolver = null,
    fetchClient = globalThis.fetch,
  } = {}) {
    const env = process.env;

    this.provider = (
      config.provider ||
      env.WHATSAPP_CLOUD_PROVIDER ||
      (env.META_WHATSAPP_TOKEN ? 'meta' : 'twilio')
    ).toLowerCase();

    this.fromPhone =
      config.fromPhone ||
      env.WHATSAPP_FROM_PHONE ||
      env.TWILIO_WHATSAPP_FROM ||
      '+919021875564';

    // Twilio credentials
    this.twilioAccountSid = config.twilioAccountSid !== undefined ? config.twilioAccountSid : (env.TWILIO_ACCOUNT_SID || '');
    this.twilioAuthToken = config.twilioAuthToken !== undefined ? config.twilioAuthToken : (env.TWILIO_AUTH_TOKEN || '');

    // Meta WhatsApp Cloud API credentials
    this.metaToken = config.metaToken !== undefined ? config.metaToken : (env.META_WHATSAPP_TOKEN || '');
    this.metaPhoneNumberId = config.metaPhoneNumberId !== undefined ? config.metaPhoneNumberId : (env.META_WHATSAPP_PHONE_NUMBER_ID || '');

    this.attemptTracker = attemptTracker;
    this.phoneResolver = phoneResolver;
    this.fetch = fetchClient;
    this.name = 'whatsapp-cloud-api';
  }

  /**
   * Validates that the active Cloud API credentials are configured.
   */
  _validateCredentials() {
    if (this.provider === 'meta') {
      if (!this.metaToken || !this.metaPhoneNumberId) {
        throw new WhatsAppConfigError(
          'Meta WhatsApp Cloud API requires META_WHATSAPP_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID in environment variables.'
        );
      }
    } else {
      // Default: Twilio
      if (!this.twilioAccountSid || !this.twilioAuthToken) {
        throw new WhatsAppConfigError(
          'Twilio WhatsApp API requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in environment variables.'
        );
      }
    }
  }

  /**
   * Resolves recipient phone number from notification record.
   * 
   * @param {import('../records.js').NotificationRecord} notification
   * @returns {Promise<string>}
   */
  async _resolveRecipientPhone(notification) {
    let candidate = notification.recipientPhone;

    if (!candidate && notification.metadata?.phone) {
      candidate = notification.metadata.phone;
    }

    if (!candidate && typeof this.phoneResolver === 'function') {
      candidate = await this.phoneResolver(notification.recipientUserId);
    }

    if (!candidate) {
      throw new InvalidRecipientError(
        `Recipient phone number not found for notification '${notification.id}'. An E.164 phone number is required.`
      );
    }

    return assertValidPhoneNumber(candidate);
  }

  /**
   * Dispatches via Twilio WhatsApp REST API.
   */
  async _sendViaTwilio(toPhone, messageText) {
    const from = this.fromPhone.startsWith('whatsapp:')
      ? this.fromPhone
      : `whatsapp:${this.fromPhone}`;
    const to = toPhone.startsWith('whatsapp:')
      ? toPhone
      : `whatsapp:${toPhone}`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.twilioAccountSid}/Messages.json`;

    const body = new URLSearchParams({
      From: from,
      To: to,
      Body: messageText,
    });

    const auth = Buffer.from(`${this.twilioAccountSid}:${this.twilioAuthToken}`).toString('base64');

    const res = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      let msg = data.message || `HTTP ${res.status}: ${res.statusText}`;
      if (
        data.code === 63007 ||
        data.code === 21211 ||
        (data.message && data.message.includes('Channel with the specified From address'))
      ) {
        msg += `. HINT: Your TWILIO_WHATSAPP_FROM is set to '${this.fromPhone}'. Twilio only sends from verified WhatsApp Senders or the Twilio Sandbox ('+14155238886'). Set TWILIO_WHATSAPP_FROM=+14155238886 in Backend/.env.`;
      }
      throw new WhatsAppSendFailedError(`Twilio WhatsApp dispatch failed: ${msg}`);
    }

    return {
      success: true,
      status: 'SENT',
      externalId: data.sid,
    };
  }

  /**
   * Dispatches via Meta WhatsApp Cloud API (Graph API).
   */
  async _sendViaMeta(toPhone, messageText) {
    const rawDigits = toPhone.replace(/\+/g, '');
    const url = `https://graph.facebook.com/v21.0/${this.metaPhoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: rawDigits,
      type: 'text',
      text: {
        preview_url: false,
        body: messageText,
      },
    };

    const res = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.metaToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errDetail = data.error?.message || `HTTP ${res.status}: ${res.statusText}`;
      throw new WhatsAppSendFailedError(`Meta WhatsApp Cloud dispatch failed: ${errDetail}`);
    }

    const messageId = data.messages?.[0]?.id || `meta_wa_${Date.now()}`;

    return {
      success: true,
      status: 'SENT',
      externalId: messageId,
    };
  }

  /**
   * Sends a notification via WhatsApp Cloud API.
   * 
   * @param {import('../records.js').NotificationRecord} notification
   * @returns {Promise<{ success: boolean, externalId?: string, status: string, attemptStatus: string }>}
   */
  async send(notification) {
    if (!notification || !notification.id) {
      throw new TypeError('WhatsApp Cloud adapter requires a notification record with an id.');
    }

    const notificationId = notification.id;

    // 1. Idempotency check
    const canAttempt = this.attemptTracker.canAttempt(notificationId);
    if (!canAttempt.canAttempt) {
      if (canAttempt.state === ATTEMPT_STATE.SENT) {
        const prev = this.attemptTracker.getAttempt(notificationId);
        return {
          success: true,
          status: 'SENT',
          attemptStatus: 'ALREADY_SENT',
          externalId: prev?.outcome?.externalId,
        };
      }
      throw new DuplicateDeliveryPreventedError(canAttempt.reason);
    }

    // 2. Validate configuration
    this._validateCredentials();

    // 3. Resolve and validate recipient phone
    const recipientPhone = await this._resolveRecipientPhone(notification);

    // 4. Format message text
    const messageText = formatWhatsAppMessage(notification);

    // 5. Record start
    this.attemptTracker.recordStart(notificationId);

    logNotification('info', `Attempting WhatsApp Cloud delivery for notification ${notificationId}`, {
      notificationId,
      provider: this.provider,
      from: this.fromPhone,
      toMasked: recipientPhone.slice(0, 4) + '****' + recipientPhone.slice(-2),
    });

    try {
      let result;
      if (this.provider === 'meta') {
        result = await this._sendViaMeta(recipientPhone, messageText);
      } else {
        result = await this._sendViaTwilio(recipientPhone, messageText);
      }

      const outcome = {
        ...result,
        attemptStatus: 'SUBMITTED_CONFIRMED',
      };

      this.attemptTracker.recordSuccess(notificationId, outcome);

      logNotification('info', `WhatsApp Cloud delivery succeeded for ${notificationId}`, {
        notificationId,
        externalId: outcome.externalId,
      });

      return outcome;
    } catch (err) {
      this.attemptTracker.recordFailure(notificationId, err, false);
      throw err;
    }
  }
}
