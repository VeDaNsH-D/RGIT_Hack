/**
 * WhatsApp Web Automation Errors
 * 
 * Defines granular error types and categories for WhatsApp Web Selenium delivery.
 */

export const WHATSAPP_ERROR_CODES = Object.freeze({
  ADAPTER_DISABLED: 'ADAPTER_DISABLED',
  MISSING_CONFIGURATION: 'MISSING_CONFIGURATION',
  INVALID_CONFIGURATION: 'INVALID_CONFIGURATION',
  BROWSER_DRIVER_UNAVAILABLE: 'BROWSER_DRIVER_UNAVAILABLE',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INVALID_RECIPIENT: 'INVALID_RECIPIENT',
  RECIPIENT_VERIFICATION_FAILED: 'RECIPIENT_VERIFICATION_FAILED',
  UI_ELEMENT_NOT_FOUND: 'UI_ELEMENT_NOT_FOUND',
  UI_CHANGED: 'UI_CHANGED',
  SEND_ACTION_FAILED: 'SEND_ACTION_FAILED',
  BROWSER_CRASHED: 'BROWSER_CRASHED',
  AMBIGUOUS_OUTCOME: 'AMBIGUOUS_OUTCOME',
  SHUTDOWN_DURING_DELIVERY: 'SHUTDOWN_DURING_DELIVERY',
  DUPLICATE_DELIVERY_PREVENTED: 'DUPLICATE_DELIVERY_PREVENTED',
});

export class WhatsAppAdapterError extends Error {
  /**
   * @param {string} message
   * @param {string} code One of WHATSAPP_ERROR_CODES
   * @param {object} [options]
   * @param {boolean} [options.isTransient=false]
   * @param {boolean} [options.isAmbiguous=false]
   * @param {unknown} [options.cause]
   */
  constructor(message, code, { isTransient = false, isAmbiguous = false, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.isTransient = isTransient;
    this.isAmbiguous = isAmbiguous;
    if (cause) this.cause = cause;
  }
}

export class WhatsAppConfigError extends WhatsAppAdapterError {
  constructor(message, cause) {
    super(message, WHATSAPP_ERROR_CODES.MISSING_CONFIGURATION, { isTransient: false, cause });
  }
}

export class WhatsAppAdapterDisabledError extends WhatsAppAdapterError {
  constructor(message = 'WhatsApp Web delivery adapter is currently disabled in configuration.') {
    super(message, WHATSAPP_ERROR_CODES.ADAPTER_DISABLED, { isTransient: false });
  }
}

export class BrowserStartupError extends WhatsAppAdapterError {
  constructor(message, cause) {
    super(message, WHATSAPP_ERROR_CODES.BROWSER_DRIVER_UNAVAILABLE, { isTransient: true, cause });
  }
}

export class WhatsAppLoginRequiredError extends WhatsAppAdapterError {
  constructor(message = 'WhatsApp Web manual QR code login is required.') {
    super(message, WHATSAPP_ERROR_CODES.LOGIN_REQUIRED, { isTransient: false });
  }
}

export class WhatsAppSessionExpiredError extends WhatsAppAdapterError {
  constructor(message = 'WhatsApp Web session has expired or been disconnected.') {
    super(message, WHATSAPP_ERROR_CODES.SESSION_EXPIRED, { isTransient: false });
  }
}

export class InvalidRecipientError extends WhatsAppAdapterError {
  constructor(message) {
    super(message, WHATSAPP_ERROR_CODES.INVALID_RECIPIENT, { isTransient: false });
  }
}

export class RecipientVerificationError extends WhatsAppAdapterError {
  constructor(message) {
    super(message, WHATSAPP_ERROR_CODES.RECIPIENT_VERIFICATION_FAILED, { isTransient: false });
  }
}

export class WhatsAppUIElementNotFoundError extends WhatsAppAdapterError {
  constructor(message, cause) {
    super(message, WHATSAPP_ERROR_CODES.UI_ELEMENT_NOT_FOUND, { isTransient: false, cause });
  }
}

export class WhatsAppSendFailedError extends WhatsAppAdapterError {
  constructor(message, cause) {
    super(message, WHATSAPP_ERROR_CODES.SEND_ACTION_FAILED, { isTransient: true, cause });
  }
}

export class BrowserCrashedError extends WhatsAppAdapterError {
  constructor(message, cause) {
    super(message, WHATSAPP_ERROR_CODES.BROWSER_CRASHED, { isTransient: true, cause });
  }
}

export class AmbiguousSendOutcomeError extends WhatsAppAdapterError {
  constructor(message, cause) {
    super(
      message || 'WhatsApp message send outcome is uncertain: UI submission could not be verified.',
      WHATSAPP_ERROR_CODES.AMBIGUOUS_OUTCOME,
      { isTransient: false, isAmbiguous: true, cause }
    );
  }
}

export class BrowserShutdownError extends WhatsAppAdapterError {
  constructor(message = 'Browser session was terminated or shutdown during delivery.') {
    super(message, WHATSAPP_ERROR_CODES.SHUTDOWN_DURING_DELIVERY, { isTransient: false });
  }
}

export class DuplicateDeliveryPreventedError extends WhatsAppAdapterError {
  constructor(message = 'Delivery skipped: previous attempt or ambiguous outcome already recorded.') {
    super(message, WHATSAPP_ERROR_CODES.DUPLICATE_DELIVERY_PREVENTED, { isTransient: false });
  }
}
