/**
 * Structured & Sanitized Logging for Notifications
 * 
 * Provides safe logging utilities that strip secrets, credentials, tokens,
 * and sensitive headers to prevent observability leaks.
 */

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /auth/i,
  /bearer/i,
  /cookie/i,
  /jwt/i,
  /key/i,
  /phone/i,
  /api[_-]?key/i,
];

/**
 * Recursively sanitizes objects and arrays, masking sensitive fields with [REDACTED].
 * 
 * @param {unknown} value
 * @param {number} [depth=0]
 * @returns {unknown}
 */
export function sanitizeData(value, depth = 0) {
  if (depth > 6) return '[MAX_DEPTH_REACHED]';
  if (!value || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeData(item, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
    };
  }

  const sanitized = {};
  for (const [k, v] of Object.entries(value)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(k));
    if (isSensitive) {
      sanitized[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      sanitized[k] = sanitizeData(v, depth + 1);
    } else {
      sanitized[k] = v;
    }
  }

  return sanitized;
}

/**
 * Structured log entry generator.
 * 
 * @param {'info'|'warn'|'error'|'debug'} level
 * @param {string} message
 * @param {object} [context={}]
 * @returns {object} Sanitized log payload
 */
export function formatLogEntry(level, message, context = {}) {
  const sanitizedContext = sanitizeData(context);
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...sanitizedContext,
  };
}

/**
 * Logs a notification event safely.
 * 
 * @param {'info'|'warn'|'error'|'debug'} level
 * @param {string} message
 * @param {object} [context={}]
 */
export function logNotification(level, message, context = {}) {
  const entry = formatLogEntry(level, message, context);
  const jsonStr = JSON.stringify(entry);

  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(jsonStr);
  } else if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(jsonStr);
  } else {
    // eslint-disable-next-line no-console
    console.log(jsonStr);
  }

  return entry;
}
