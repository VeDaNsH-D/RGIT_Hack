/**
 * Notification Retry & Resilience Utility
 * 
 * Provides bounded exponential backoff retries for transient failures,
 * strictly distinguishing transient errors from permanent validation/client errors.
 */

import { NotificationValidationError } from '../validation.js';
import { UnsupportedTemplateEventError } from '../templates.js';

export class RetryExhaustedError extends Error {
  constructor(message, { attempts, errors, lastError }) {
    super(message);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.errors = errors;
    this.lastError = lastError;
  }
}

/**
 * Determines whether an error is transient and safe to retry.
 * 
 * @param {Error|unknown} error
 * @returns {boolean}
 */
export function isTransientError(error) {
  if (!error) return false;

  // Permanent failure types - never retry
  if (
    error instanceof NotificationValidationError ||
    error instanceof UnsupportedTemplateEventError ||
    error instanceof TypeError ||
    error instanceof RangeError
  ) {
    return false;
  }

  // Explicit non-transient status codes (4xx except 429)
  const status = error.status || error.statusCode;
  if (typeof status === 'number') {
    if (status === 429) return true; // Rate limiting is transient
    if (status >= 400 && status < 500) return false; // 4xx client errors are permanent
    if (status >= 500) return true; // 5xx server errors are transient
  }

  // Transient network / socket error codes
  const code = error.code || error.errno;
  const transientCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'EHOSTUNREACH',
  ];
  if (code && transientCodes.includes(code)) {
    return true;
  }

  // Common transient error messages
  const msg = (error.message || '').toLowerCase();
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('connection lost') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('network error') ||
    msg.includes('rate limit') ||
    msg.includes('server closed') ||
    msg.includes('topology was destroyed')
  ) {
    return true;
  }

  // Custom flag if specified
  if (typeof error.isTransient === 'boolean') {
    return error.isTransient;
  }

  return false;
}

/**
 * Default sleep implementation using setTimeout.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const defaultSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Executes an asynchronous operation with bounded exponential backoff retries.
 * 
 * @template T
 * @param {() => Promise<T>} operation
 * @param {object} [options={}]
 * @param {number} [options.maxRetries=3] Maximum number of retry attempts
 * @param {number} [options.initialDelayMs=100] Initial delay in milliseconds
 * @param {number} [options.backoffFactor=2] Exponential backoff multiplier
 * @param {number} [options.maxDelayMs=5000] Maximum delay cap
 * @param {(err: unknown) => boolean} [options.isTransient] Custom transient error predicate
 * @param {(ms: number) => Promise<void>} [options.sleepFn] Custom sleep function for zero-wait testing
 * @param {(attempt: number, error: unknown, delayMs: number) => void} [options.onRetry] Retry callback
 * @returns {Promise<T>}
 */
export async function withRetry(operation, options = {}) {
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 100);
  const backoffFactor = Math.max(1, options.backoffFactor ?? 2);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 5000);
  const isTransient = options.isTransient ?? isTransientError;
  const sleepFn = options.sleepFn ?? defaultSleep;

  const errors = [];
  let attempt = 0;

  while (attempt <= maxRetries) {
    attempt++;
    try {
      return await operation();
    } catch (err) {
      errors.push(err);

      // Check if error is permanent or retries exhausted
      const isRetryable = isTransient(err);
      if (!isRetryable || attempt > maxRetries) {
        if (!isRetryable) {
          // Permanent failure fails immediately without further attempts
          throw err;
        }

        throw new RetryExhaustedError(
          `Operation failed after ${attempt} attempts: ${err.message}`,
          {
            attempts: attempt,
            errors,
            lastError: err,
          }
        );
      }

      // Calculate exponential backoff delay
      const rawDelay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
      const delayMs = Math.min(rawDelay, maxDelayMs);

      if (typeof options.onRetry === 'function') {
        options.onRetry(attempt, err, delayMs);
      }

      await sleepFn(delayMs);
    }
  }

  // Fallback (unreachable under normal control flow)
  throw errors[errors.length - 1];
}
