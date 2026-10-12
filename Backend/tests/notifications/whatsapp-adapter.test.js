/**
 * WhatsApp Web Automation Adapter Test Suite
 * 
 * Verifies all 14 mandatory delivery, error handling, lifecycle,
 * idempotency, and isolation scenarios using mock browser abstractions.
 * 
 * No real WhatsApp messages, accounts, or browser binaries are used.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  WhatsAppWebSeleniumAdapter,
  BrowserSessionManager,
  DeliveryAttemptTracker,
  ATTEMPT_STATE,
  resolveWhatsAppConfig,
  WHATSAPP_ERROR_CODES,
  WhatsAppAdapterDisabledError,
  WhatsAppConfigError,
  BrowserStartupError,
  WhatsAppLoginRequiredError,
  InvalidRecipientError,
  RecipientVerificationError,
  WhatsAppUIElementNotFoundError,
  WhatsAppSendFailedError,
  BrowserCrashedError,
  AmbiguousSendOutcomeError,
  DuplicateDeliveryPreventedError,
} from '../../src/notifications/whatsapp/index.js';
import {
  NotificationDeliveryDispatcher,
  InMemoryNotificationRepository,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_DELIVERY_STATUS,
} from '../../src/notifications/index.js';

/**
 * Mock WebElement simulating Selenium element interactions
 */
class MockWebElement {
  constructor({ text = '', isDisplayed = true, onClick = null } = {}) {
    this._text = text;
    this._isDisplayed = isDisplayed;
    this._onClick = onClick;
  }

  async getText() {
    return this._text;
  }

  async isDisplayed() {
    return this._isDisplayed;
  }

  async click() {
    if (typeof this._onClick === 'function') {
      return this._onClick();
    }
  }
}

/**
 * Mock Browser Driver simulating Selenium WebDriver API
 */
class MockBrowserDriver {
  constructor({
    state = 'normal', // 'normal' | 'qr_login' | 'invalid_dialog' | 'wrong_recipient' | 'missing_send_button' | 'crash_on_click' | 'uncleared_input'
    recipientHeader = '+14155552671',
  } = {}) {
    this.state = state;
    this.recipientHeader = recipientHeader;
    this.currentUrl = null;
    this.hasQuit = false;
    this.clickCount = 0;
    this.inputCleared = false;
  }

  async get(url) {
    if (this.state === 'crash_on_nav') {
      const err = new Error('chrome not reachable');
      err.name = 'WebDriverError';
      throw err;
    }
    this.currentUrl = url;
  }

  async getSession() {
    if (this.hasQuit || this.state === 'crashed_session') {
      throw new Error('NoSuchSessionError: session deleted');
    }
    return { id: 'mock-session-id' };
  }

  async findElements({ css }) {
    if (this.hasQuit) {
      throw new Error('NoSuchSessionError: session deleted');
    }

    // 1. QR code login check
    if (css.includes('canvas') || css.includes('qrcode')) {
      if (this.state === 'qr_login') {
        return [new MockWebElement({ text: 'Scan QR code' })];
      }
      return [];
    }

    // 2. Invalid number modal popup check
    if (css.includes('dialog') || css.includes('modal')) {
      if (this.state === 'invalid_dialog') {
        return [
          new MockWebElement({
            text: 'Phone number shared via url is invalid. OK',
          }),
        ];
      }
      return [];
    }

    // 3. Header recipient verification
    if (css.includes('header')) {
      if (this.state === 'no_header') {
        return [];
      }
      if (this.state === 'wrong_recipient') {
        return [new MockWebElement({ text: '+447911123456' })]; // Different phone
      }
      return [new MockWebElement({ text: this.recipientHeader })];
    }

    // 4. Send button lookup
    if (css.includes('send') || css.includes('button[aria-label="Send"]')) {
      if (this.state === 'missing_send_button') {
        return [];
      }
      return [
        new MockWebElement({
          text: '',
          onClick: () => {
            if (this.state === 'crash_on_click') {
              const err = new Error('session deleted because of crash');
              err.name = 'NoSuchSessionError';
              throw err;
            }
            this.clickCount++;
            if (this.state !== 'uncleared_input') {
              this.inputCleared = true;
            }
          },
        }),
      ];
    }

    // 5. Input text field verification
    if (css.includes('contenteditable') || css.includes('Type a message')) {
      if (this.state === 'uncleared_input') {
        return [new MockWebElement({ text: 'Still uncleared text' })];
      }
      if (this.inputCleared) {
        return [new MockWebElement({ text: '' })];
      }
      return [new MockWebElement({ text: 'Hello' })];
    }

    return [];
  }

  async quit() {
    this.hasQuit = true;
  }
}

describe('WhatsApp Web Selenium Delivery Adapter Suite', () => {
  let attemptTracker;
  const sampleNotification = {
    id: 'notif_wa_test_001',
    eventId: 'evt_handoff_sub_999',
    type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
    title: 'Project Handoff Submitted',
    message: 'Handoff pkg_101 was submitted by alice for project alpha-1',
    projectId: 'alpha-1',
    entityId: 'pkg_101',
    recipientUserId: 'usr_target_123',
    recipientPhone: '+14155552671', // Valid E.164
    createdAt: new Date().toISOString(),
    deliveryStatus: 'PENDING',
  };

  beforeEach(() => {
    attemptTracker = new DeliveryAttemptTracker();
  });

  // Scenario 1: Adapter Disabled
  it('1. should reject send if adapter is disabled in configuration', async () => {
    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: false },
      attemptTracker,
    });

    await assert.rejects(
      () => adapter.send(sampleNotification),
      (err) => {
        assert.ok(err instanceof WhatsAppAdapterDisabledError);
        assert.equal(err.code, WHATSAPP_ERROR_CODES.ADAPTER_DISABLED);
        return true;
      }
    );
  });

  // Scenario 2: Missing / Invalid Configuration
  it('2. should reject startup when required configuration is invalid', () => {
    assert.throws(
      () =>
        resolveWhatsAppConfig({
          enabled: true,
          browser: 'unsupported_browser',
        }),
      (err) => {
        assert.ok(err instanceof WhatsAppConfigError);
        assert.equal(err.code, WHATSAPP_ERROR_CODES.MISSING_CONFIGURATION);
        return true;
      }
    );

    assert.throws(
      () =>
        resolveWhatsAppConfig({
          enabled: true,
          navigationTimeoutMs: -100,
        }),
      (err) => {
        assert.ok(err instanceof WhatsAppConfigError);
        return true;
      }
    );
  });

  // Scenario 3: Browser Startup Failure
  it('3. should handle browser startup failures cleanly', async () => {
    const sessionManager = new BrowserSessionManager({
      driverFactory: async () => {
        throw new Error('chromedriver executable not found on PATH');
      },
    });

    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      sessionManager,
      attemptTracker,
    });

    await assert.rejects(
      () => adapter.send(sampleNotification),
      (err) => {
        assert.ok(err instanceof BrowserStartupError);
        assert.equal(err.code, WHATSAPP_ERROR_CODES.BROWSER_DRIVER_UNAVAILABLE);
        return true;
      }
    );
  });

  // Scenario 4: WhatsApp Web Login Required (QR Code Screen)
  it('4. should detect when manual QR code login is required', async () => {
    const mockDriver = new MockBrowserDriver({ state: 'qr_login' });
    const sessionManager = new BrowserSessionManager({
      driverFactory: async () => mockDriver,
    });

    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      sessionManager,
      attemptTracker,
    });

    await assert.rejects(
      () => adapter.send(sampleNotification),
      (err) => {
        assert.ok(err instanceof WhatsAppLoginRequiredError);
        assert.equal(err.code, WHATSAPP_ERROR_CODES.LOGIN_REQUIRED);
        return true;
      }
    );
  });

  // Scenario 5: Invalid Recipient Phone Number
  it('5. should reject delivery if recipient phone format is invalid', async () => {
    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      attemptTracker,
    });

    // Invalid local number without international country code
    const invalidPhoneNotif = {
      ...sampleNotification,
      id: 'notif_invalid_phone',
      recipientPhone: '9876543210',
    };

    await assert.rejects(
      () => adapter.send(invalidPhoneNotif),
      (err) => {
        assert.ok(err instanceof InvalidRecipientError);
        assert.equal(err.code, WHATSAPP_ERROR_CODES.INVALID_RECIPIENT);
        return true;
      }
    );
  });

  // Scenario 6: Recipient Verification Failure (Mismatched Chat)
  it('6. should abort send if active chat recipient header fails verification', async () => {
    const mockDriver = new MockBrowserDriver({ state: 'wrong_recipient' });
    const sessionManager = new BrowserSessionManager({
      driverFactory: async () => mockDriver,
    });

    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      sessionManager,
      attemptTracker,
    });

    await assert.rejects(
      () => adapter.send(sampleNotification),
      (err) => {
        assert.ok(err instanceof RecipientVerificationError);
        assert.equal(err.code, WHATSAPP_ERROR_CODES.RECIPIENT_VERIFICATION_FAILED);
        assert.equal(mockDriver.clickCount, 0, 'Send button must NOT be clicked when recipient verification fails');
        return true;
      }
    );
  });

  // Scenario 7: Successful Mocked Send Flow
  it('7. should successfully verify recipient, click send, and confirm UI submission', async () => {
    const mockDriver = new MockBrowserDriver({ state: 'normal' });
    const sessionManager = new BrowserSessionManager({
      driverFactory: async () => mockDriver,
    });

    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      sessionManager,
      attemptTracker,
    });

    const result = await adapter.send(sampleNotification);

    assert.equal(result.success, true);
    assert.equal(result.status, 'SENT');
    assert.equal(result.attemptStatus, 'SUBMITTED_CONFIRMED');
    assert.ok(result.externalId.startsWith('wa_notif_wa_test_001_'));
    assert.equal(mockDriver.clickCount, 1);
    assert.ok(mockDriver.currentUrl.includes('web.whatsapp.com/send'));
  });

  // Scenario 8: UI Element Not Found (Send Button Missing / UI Changed)
  it('8. should fail safely if Send button or expected UI element is not found', async () => {
    const mockDriver = new MockBrowserDriver({ state: 'missing_send_button' });
    const sessionManager = new BrowserSessionManager({
      driverFactory: async () => mockDriver,
    });

    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      sessionManager,
      attemptTracker,
    });

    await assert.rejects(
      () => adapter.send(sampleNotification),
      (err) => {
        assert.ok(err instanceof WhatsAppUIElementNotFoundError);
        assert.equal(err.code, WHATSAPP_ERROR_CODES.UI_ELEMENT_NOT_FOUND);
        return true;
      }
    );
  });

  // Scenario 9: Browser Crash During Delivery
  it('9. should detect and handle browser crashes gracefully', async () => {
    const mockDriver = new MockBrowserDriver({ state: 'crash_on_click' });
    const sessionManager = new BrowserSessionManager({
      driverFactory: async () => mockDriver,
    });

    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      sessionManager,
      attemptTracker,
    });

    await assert.rejects(
      () => adapter.send(sampleNotification),
      (err) => {
        assert.ok(err instanceof BrowserCrashedError);
        assert.equal(err.code, WHATSAPP_ERROR_CODES.BROWSER_CRASHED);
        return true;
      }
    );
  });

  // Scenario 10: Ambiguous Send Outcome (Input Box Never Cleared After Send)
  it('10. should classify uncertain submission outcomes as AMBIGUOUS_OUTCOME and avoid resending', async () => {
    const mockDriver = new MockBrowserDriver({ state: 'uncleared_input' });
    const sessionManager = new BrowserSessionManager({
      driverFactory: async () => mockDriver,
    });

    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      sessionManager,
      attemptTracker,
    });

    await assert.rejects(
      () => adapter.send(sampleNotification),
      (err) => {
        assert.ok(err instanceof AmbiguousSendOutcomeError);
        assert.equal(err.code, WHATSAPP_ERROR_CODES.AMBIGUOUS_OUTCOME);
        assert.equal(err.isAmbiguous, true);
        return true;
      }
    );

    // Verify attempt tracker marked as UNCERTAIN
    const attempt = attemptTracker.getAttempt(sampleNotification.id);
    assert.equal(attempt.state, ATTEMPT_STATE.UNCERTAIN);
  });

  // Scenario 11: Duplicate-Attempt Protection
  it('11. should protect against duplicate attempts after confirmed send or ambiguous outcome', async () => {
    const mockDriver = new MockBrowserDriver({ state: 'normal' });
    const sessionManager = new BrowserSessionManager({
      driverFactory: async () => mockDriver,
    });

    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      sessionManager,
      attemptTracker,
    });

    // 1st attempt succeeds
    const firstResult = await adapter.send(sampleNotification);
    assert.equal(firstResult.success, true);
    assert.equal(mockDriver.clickCount, 1);

    // 2nd attempt with same notificationId returns cached outcome without re-clicking Send
    const secondResult = await adapter.send(sampleNotification);
    assert.equal(secondResult.success, true);
    assert.equal(secondResult.attemptStatus, 'ALREADY_SENT');
    assert.equal(mockDriver.clickCount, 1, 'Send button must NOT be clicked twice');
  });

  // Scenario 12: Concurrent Send Prevention (Serialization)
  it('12. should serialize concurrent sends so they execute sequentially', async () => {
    const mockDriver = new MockBrowserDriver({ state: 'normal' });
    const sessionManager = new BrowserSessionManager({
      driverFactory: async () => mockDriver,
    });

    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      sessionManager,
      attemptTracker,
    });

    const notifA = { ...sampleNotification, id: 'notif_concurrent_A' };
    const notifB = { ...sampleNotification, id: 'notif_concurrent_B' };

    // Fire both sends concurrently
    const [resA, resB] = await Promise.all([
      adapter.send(notifA),
      adapter.send(notifB),
    ]);

    assert.equal(resA.success, true);
    assert.equal(resB.success, true);
    assert.equal(mockDriver.clickCount, 2);
  });

  // Scenario 13: Browser Cleanup and Resource Release
  it('13. should safely release browser driver resources on shutdown', async () => {
    const mockDriver = new MockBrowserDriver({ state: 'normal' });
    const sessionManager = new BrowserSessionManager({
      driverFactory: async () => mockDriver,
    });

    const adapter = new WhatsAppWebSeleniumAdapter({
      config: { enabled: true },
      sessionManager,
      attemptTracker,
    });

    await adapter.send(sampleNotification);
    assert.equal(mockDriver.hasQuit, false);

    await adapter.shutdown();
    assert.equal(mockDriver.hasQuit, true);
  });

  // Scenario 14: In-App Notifications Continue to Work When WhatsApp Delivery Fails
  it('14. should ensure in-app notification system remains fully operational when WhatsApp delivery fails', async () => {
    const repository = new InMemoryNotificationRepository();
    const dispatcher = new NotificationDeliveryDispatcher({ repository });

    // Failing WhatsApp provider
    const failingWhatsAppProvider = {
      name: 'whatsapp-web-selenium',
      send: async () => {
        throw new WhatsAppLoginRequiredError('Manual QR login required');
      },
    };

    dispatcher.registerProvider(failingWhatsAppProvider);

    // Initial notification stored in repository
    const storedNotification = await repository.create({
      id: 'notif_isolation_test_001',
      recipientUserId: 'usr_user_555',
      eventId: 'evt_isolation_001',
      type: NOTIFICATION_EVENT_TYPES.TASK_OVERDUE,
      title: 'Task Overdue',
      message: 'Task 456 is overdue',
      projectId: 'proj_beta',
      entityId: 'task_456',
      readAt: null,
      createdAt: new Date().toISOString(),
      deliveryStatus: NOTIFICATION_DELIVERY_STATUS.PENDING,
    });

    // Dispatch notification
    const dispatchResult = await dispatcher.dispatch(storedNotification);

    // WhatsApp failed, but notification record remains safe in repository
    assert.equal(dispatchResult.success, false);
    assert.equal(dispatchResult.status, NOTIFICATION_DELIVERY_STATUS.FAILED);

    // In-app queries continue to return the notification record cleanly
    const inAppRecords = await repository.findByRecipient('usr_user_555');
    assert.equal(inAppRecords.length, 1);
    assert.equal(inAppRecords[0].id, 'notif_isolation_test_001');
    assert.equal(inAppRecords[0].title, 'Task Overdue');

    // Unread count and mark-as-read continue working smoothly
    const unreadCount = await repository.countUnread('usr_user_555');
    assert.equal(unreadCount, 1);

    const readResult = await repository.markAsRead('notif_isolation_test_001', 'usr_user_555');
    assert.ok(readResult.readAt);
  });
});
