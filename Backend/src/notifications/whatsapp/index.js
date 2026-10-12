/**
 * WhatsApp Web Automation Adapter Module
 */

export {
  WHATSAPP_ERROR_CODES,
  WhatsAppAdapterError,
  WhatsAppConfigError,
  WhatsAppAdapterDisabledError,
  BrowserStartupError,
  WhatsAppLoginRequiredError,
  WhatsAppSessionExpiredError,
  InvalidRecipientError,
  RecipientVerificationError,
  WhatsAppUIElementNotFoundError,
  WhatsAppSendFailedError,
  BrowserCrashedError,
  AmbiguousSendOutcomeError,
  BrowserShutdownError,
  DuplicateDeliveryPreventedError,
} from './whatsappErrors.js';

export {
  SUPPORTED_BROWSERS,
  resolveWhatsAppConfig,
  validateWhatsAppConfig,
} from './whatsappConfig.js';

export {
  validateAndNormalizePhoneNumber,
  assertValidPhoneNumber,
} from './phoneValidator.js';

export {
  formatWhatsAppMessage,
} from './whatsappTemplates.js';

export {
  BrowserSessionManager,
} from './browserSessionManager.js';

export {
  ATTEMPT_STATE,
  DeliveryAttemptTracker,
} from './deliveryAttemptTracker.js';

export {
  WhatsAppWebSeleniumAdapter,
} from './whatsappWebAdapter.js';
