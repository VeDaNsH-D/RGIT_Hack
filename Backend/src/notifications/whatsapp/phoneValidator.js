/**
 * International Phone Number Validator & Normalizer
 * 
 * Enforces strict E.164 international phone number formatting (+[country code][subscriber number]).
 */

import { InvalidRecipientError } from './whatsappErrors.js';

// E.164 specification: + followed by 7 to 15 digits, starting with non-zero country code
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/**
 * Validates and normalizes an international phone number.
 * 
 * @param {string} rawPhone
 * @returns {{ valid: boolean, normalized?: string, error?: string }}
 */
export function validateAndNormalizePhoneNumber(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return {
      valid: false,
      error: 'Recipient phone number must be a non-empty string.',
    };
  }

  const trimmed = rawPhone.trim();

  // Strip common visual formatting characters (spaces, hyphens, dots, parentheses)
  let sanitized = trimmed.replace(/[\s\-_().]/g, '');

  // Handle leading international dial code prefix 00 (e.g. 001... -> +1...)
  if (sanitized.startsWith('00')) {
    sanitized = `+${sanitized.slice(2)}`;
  }

  // Must start with + indicating international country code
  if (!sanitized.startsWith('+')) {
    return {
      valid: false,
      error: `Recipient phone number '${rawPhone}' lacks an international country code prefix (+). Format must be E.164 (e.g. +14155552671).`,
    };
  }

  // Must match strict E.164 pattern
  if (!E164_REGEX.test(sanitized)) {
    return {
      valid: false,
      error: `Recipient phone number '${rawPhone}' is not a valid international E.164 number (+ followed by 7 to 15 digits without leading zeros in country code).`,
    };
  }

  return {
    valid: true,
    normalized: sanitized,
    // Formatted for WhatsApp Web query parameter: pure digits with country code
    digitsOnly: sanitized.replace(/\+/g, ''),
  };
}

/**
 * Asserts that a phone number is valid E.164, throwing InvalidRecipientError if not.
 * 
 * @param {string} rawPhone
 * @returns {string} Normalized phone number with leading +
 * @throws {InvalidRecipientError}
 */
export function assertValidPhoneNumber(rawPhone) {
  const result = validateAndNormalizePhoneNumber(rawPhone);
  if (!result.valid) {
    throw new InvalidRecipientError(result.error);
  }
  return result.normalized;
}
