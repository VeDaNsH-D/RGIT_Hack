/**
 * WhatsApp Web Delivery Adapter using Selenium WebDriver
 * 
 * Implements the DeliveryProvider interface to deliver notification messages
 * safely via WhatsApp Web in a controlled browser session.
 */

import {
  WHATSAPP_ERROR_CODES,
  WhatsAppAdapterDisabledError,
  WhatsAppLoginRequiredError,
  WhatsAppSessionExpiredError,
  InvalidRecipientError,
  RecipientVerificationError,
  WhatsAppUIElementNotFoundError,
  WhatsAppSendFailedError,
  AmbiguousSendOutcomeError,
  DuplicateDeliveryPreventedError,
} from './whatsappErrors.js';
import { resolveWhatsAppConfig } from './whatsappConfig.js';
import { assertValidPhoneNumber, validateAndNormalizePhoneNumber } from './phoneValidator.js';
import { formatWhatsAppMessage } from './whatsappTemplates.js';
import { BrowserSessionManager } from './browserSessionManager.js';
import { DeliveryAttemptTracker, ATTEMPT_STATE } from './deliveryAttemptTracker.js';
import { logNotification } from '../reliability/logger.js';

export class WhatsAppWebSeleniumAdapter {
  /**
   * @param {object} [options={}]
   * @param {object} [options.config]
   * @param {BrowserSessionManager} [options.sessionManager]
   * @param {DeliveryAttemptTracker} [options.attemptTracker]
   * @param {(recipientUserId: string) => Promise<string|null>} [options.phoneResolver]
   */
  constructor({
    config = {},
    sessionManager = null,
    attemptTracker = null,
    phoneResolver = null,
  } = {}) {
    this.name = 'whatsapp-web-selenium';
    this.config = resolveWhatsAppConfig(config);
    this.sessionManager =
      sessionManager ||
      new BrowserSessionManager({
        browser: this.config.browser,
        profileDir: this.config.profileDir,
        headless: this.config.headless,
        navigationTimeoutMs: this.config.navigationTimeoutMs,
        actionTimeoutMs: this.config.actionTimeoutMs,
      });

    this.attemptTracker = attemptTracker || new DeliveryAttemptTracker();
    this.phoneResolver = phoneResolver || null;
  }

  /**
   * Resolves recipient phone number from notification or phone resolver.
   * 
   * @param {import('../records.js').NotificationRecord} notification
   * @returns {Promise<string>} Normalized E.164 phone number
   */
  async _resolveRecipientPhone(notification) {
    let candidate =
      notification.recipientPhone ||
      notification.payload?.recipientPhone ||
      notification.metadata?.recipientPhone;

    if (!candidate && typeof this.phoneResolver === 'function') {
      candidate = await this.phoneResolver(notification.recipientUserId);
    }

    if (!candidate) {
      throw new InvalidRecipientError(
        `Recipient phone number not found for user '${notification.recipientUserId}'. An international phone number with country code is required.`
      );
    }

    return assertValidPhoneNumber(candidate);
  }

  /**
   * Builds the official WhatsApp Web URL to initiate chat.
   * 
   * @param {string} phone Normalized E.164 phone
   * @param {string} text Message text
   * @returns {string}
   */
  _buildSendUrl(phone, text) {
    const digits = phone.replace(/\+/g, '');
    const encodedText = encodeURIComponent(text);
    return `https://web.whatsapp.com/send?phone=${digits}&text=${encodedText}`;
  }

  /**
   * Checks if WhatsApp Web requires manual QR code login or session is expired.
   * 
   * @param {any} driver
   */
  async _checkLoginState(driver) {
    try {
      // Look for QR code or landing canvas
      const qrElements = await driver.findElements({
        css: 'canvas[aria-label*="QR"], [data-ref*="qr"], [data-testid="qrcode"], div[data-testid="landing-title"]',
      });

      if (qrElements && qrElements.length > 0) {
        throw new WhatsAppLoginRequiredError(
          'WhatsApp Web QR code detected: manual user login is required to initialize the session.'
        );
      }
    } catch (err) {
      if (err instanceof WhatsAppLoginRequiredError) throw err;
    }
  }

  /**
   * Checks for invalid phone number dialog popup.
   * 
   * @param {any} driver
   */
  async _checkInvalidNumberDialog(driver) {
    try {
      const dialogs = await driver.findElements({
        css: 'div[data-animate-modal-popup="true"], div[role="dialog"]',
      });

      if (dialogs && dialogs.length > 0) {
        for (const dialog of dialogs) {
          const text = (await dialog.getText()).toLowerCase();
          if (
            text.includes('invalid') ||
            text.includes('phone number shared via url is invalid') ||
            text.includes('not on whatsapp') ||
            text.includes('couldn\'t find')
          ) {
            throw new InvalidRecipientError(
              'WhatsApp Web reported recipient phone number is invalid or not registered on WhatsApp.'
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof InvalidRecipientError) throw err;
    }
  }

  /**
   * Verifies that the opened conversation corresponds to the intended recipient.
   * 
   * @param {any} driver
   * @param {string} expectedPhone
   */
  async _verifyRecipient(driver, expectedPhone) {
    const rawDigits = expectedPhone.replace(/\+/g, '');

    try {
      // Look for conversation header element
      const headers = await driver.findElements({
        css: 'header [data-testid="conversation-info-header"], header div[role="button"], header [dir="auto"]',
      });

      if (!headers || headers.length === 0) {
        throw new RecipientVerificationError(
          'Unable to verify recipient identity: Conversation header element could not be located.'
        );
      }

      // Check header text to ensure conversation opened
      let verified = false;
      for (const header of headers) {
        const text = await header.getText();
        if (!text || text.trim().length === 0) continue;

        // If phone number is directly visible in header, check digits
        const headerDigits = text.replace(/\D/g, '');
        if (headerDigits.length >= 7) {
          if (rawDigits.includes(headerDigits) || headerDigits.includes(rawDigits)) {
            verified = true;
            break;
          }
          // If header contains phone digits that mismatch expected phone, reject this header
          continue;
        }

        // If contact has a saved name or verified business name (no phone digits present)
        if (headerDigits.length === 0 && text.trim().length >= 2) {
          verified = true;
          break;
        }
      }

      if (!verified) {
        throw new RecipientVerificationError(
          `Recipient verification failed: Active chat header did not match expected recipient '${expectedPhone}'. Aborting send action.`
        );
      }
    } catch (err) {
      if (err instanceof RecipientVerificationError) throw err;
      throw new RecipientVerificationError(
        `Recipient verification failed due to inspection error: ${err.message}`
      );
    }
  }

  /**
   * Resiliently finds the Send button using fallback selectors.
   * 
   * @param {any} driver
   * @returns {Promise<any>}
   */
  async _locateSendButton(driver) {
    const selectors = [
      'button[aria-label="Send"]',
      'button span[data-icon="send"]',
      'footer [data-icon="send"]',
      '[data-testid="send"]',
      '[data-testid="compose-btn-send"]',
      'span[data-icon="send"]',
    ];

    for (const selector of selectors) {
      try {
        const elements = await driver.findElements({ css: selector });
        if (elements && elements.length > 0) {
          return elements[0];
        }
      } catch {
        // Fallback to next selector
      }
    }

    throw new WhatsAppUIElementNotFoundError(
      'Send button element not found. WhatsApp Web UI may have changed or the message input box is inactive.'
    );
  }

  /**
   * Sends a notification record through WhatsApp Web.
   * 
   * @param {import('../records.js').NotificationRecord} notification
   * @returns {Promise<{ success: boolean, externalId?: string, status: string, attemptStatus: string }>}
   */
  async send(notification) {
    if (!this.config.enabled) {
      throw new WhatsAppAdapterDisabledError();
    }

    if (!notification || !notification.id) {
      throw new TypeError('WhatsApp adapter requires a valid notification record with an id.');
    }

    const notificationId = notification.id;
    const eventId = notification.eventId || notificationId;

    // 1. Idempotency & Duplicate Send Check
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

    // 2. Validate and resolve recipient phone number
    const recipientPhone = await this._resolveRecipientPhone(notification);

    // 3. Centralized WhatsApp message formatting
    const messageText = formatWhatsAppMessage(notification);

    // 4. Record attempt start
    this.attemptTracker.recordStart(notificationId);

    logNotification('info', `Attempting WhatsApp delivery for notification ${notificationId}`, {
      notificationId,
      eventId,
      recipientUserId: notification.recipientUserId,
      maskedPhone: recipientPhone.slice(0, 4) + '****' + recipientPhone.slice(-2),
    });

    let externalId = null;

    try {
      // 5. Execute within serialized browser session
      await this.sessionManager.executeSerialized(async (driver) => {
        const sendUrl = this._buildSendUrl(recipientPhone, messageText);

        // Navigate to conversation
        try {
          await driver.get(sendUrl);
        } catch (navErr) {
          throw new WhatsAppSendFailedError(`Failed navigating to WhatsApp Web: ${navErr.message}`, navErr);
        }

        // Check login state (QR code present)
        await this._checkLoginState(driver);

        // Check for invalid number dialog
        await this._checkInvalidNumberDialog(driver);

        // Verify recipient in open chat
        await this._verifyRecipient(driver, recipientPhone);

        // Locate Send button
        const sendButton = await this._locateSendButton(driver);

        // Perform click
        try {
          await sendButton.click();
        } catch (clickErr) {
          throw new WhatsAppSendFailedError(`Failed clicking Send button: ${clickErr.message}`, clickErr);
        }

        // 6. Post-send UI submission confirmation
        let submitted = false;
        try {
          // Check if send button transitioned or message input cleared
          const inputs = await driver.findElements({
            css: 'footer div[contenteditable="true"], div[title="Type a message"]',
          });
          if (inputs && inputs.length > 0) {
            const val = await inputs[0].getText();
            if (!val || val.trim() === '') {
              submitted = true;
            }
          } else {
            submitted = true;
          }
        } catch (uiErr) {
          // Ambiguous outcome if error occurs right after click
          throw new AmbiguousSendOutcomeError(
            `Send button was clicked, but post-send UI confirmation timed out: ${uiErr.message}`,
            uiErr
          );
        }

        if (!submitted) {
          throw new AmbiguousSendOutcomeError(
            'Send button was clicked, but message input field remained uncleared. Delivery outcome is uncertain.'
          );
        }

        externalId = `wa_${notificationId}_${Date.now()}`;
      });

      // 7. Success recording
      const result = {
        success: true,
        status: 'SENT',
        attemptStatus: 'SUBMITTED_CONFIRMED',
        externalId,
      };

      this.attemptTracker.recordSuccess(notificationId, result);

      logNotification('info', `WhatsApp delivery submitted confirmed for ${notificationId}`, {
        notificationId,
        eventId,
        externalId,
      });

      return result;
    } catch (err) {
      const isAmbiguous = err instanceof AmbiguousSendOutcomeError || Boolean(err.isAmbiguous);
      this.attemptTracker.recordFailure(notificationId, err, { isAmbiguous });

      logNotification('error', `WhatsApp delivery failed for ${notificationId}`, {
        notificationId,
        eventId,
        errorCode: err.code || WHATSAPP_ERROR_CODES.SEND_ACTION_FAILED,
        isAmbiguous,
        error: err.message,
      });

      throw err;
    }
  }

  /**
   * Shuts down the adapter's browser session.
   */
  async shutdown() {
    await this.sessionManager.shutdown();
  }
}
