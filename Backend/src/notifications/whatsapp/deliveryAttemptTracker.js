/**
 * Delivery Attempt & Idempotency Tracker
 * 
 * Tracks delivery attempts, prevents concurrent and duplicate sends,
 * and records ambiguous/uncertain outcomes to prevent duplicate message spam.
 */

export const ATTEMPT_STATE = Object.freeze({
  IDLE: 'IDLE',
  IN_PROGRESS: 'IN_PROGRESS',
  SENT: 'SENT',
  UNCERTAIN: 'UNCERTAIN',
  FAILED: 'FAILED',
});

export class DeliveryAttemptTracker {
  constructor() {
    /**
     * Map of notificationId/eventId -> attempt details
     * @type {Map<string, {
     *   id: string,
     *   state: string,
     *   attempts: number,
     *   firstAttemptAt: string,
     *   lastAttemptAt: string,
     *   outcome?: object,
     *   lastError?: string
     * }>}
     */
    this._attempts = new Map();
  }

  /**
   * Retrieves current attempt record for an identifier.
   * 
   * @param {string} id
   * @returns {object|null}
   */
  getAttempt(id) {
    if (!id) return null;
    return this._attempts.get(id) || null;
  }

  /**
   * Checks if an attempt is already in progress, confirmed sent, or in an ambiguous state.
   * 
   * @param {string} id
   * @returns {{ canAttempt: boolean, reason?: string, state?: string }}
   */
  canAttempt(id) {
    if (!id) return { canAttempt: true };

    const record = this._attempts.get(id);
    if (!record) {
      return { canAttempt: true };
    }

    if (record.state === ATTEMPT_STATE.SENT) {
      return {
        canAttempt: false,
        reason: 'Notification already successfully delivered via WhatsApp Web.',
        state: record.state,
      };
    }

    if (record.state === ATTEMPT_STATE.IN_PROGRESS) {
      return {
        canAttempt: false,
        reason: 'A WhatsApp delivery attempt for this notification is currently in progress.',
        state: record.state,
      };
    }

    if (record.state === ATTEMPT_STATE.UNCERTAIN) {
      return {
        canAttempt: false,
        reason: 'Previous attempt ended in an uncertain outcome (e.g. timeout during submission). Resend blocked to prevent duplicate messaging.',
        state: record.state,
      };
    }

    return { canAttempt: true };
  }

  /**
   * Marks an attempt as started.
   * 
   * @param {string} id
   * @returns {object} Updated attempt record
   */
  recordStart(id) {
    const nowIso = new Date().toISOString();
    const existing = this._attempts.get(id);

    if (existing) {
      existing.attempts += 1;
      existing.state = ATTEMPT_STATE.IN_PROGRESS;
      existing.lastAttemptAt = nowIso;
      return existing;
    }

    const record = {
      id,
      state: ATTEMPT_STATE.IN_PROGRESS,
      attempts: 1,
      firstAttemptAt: nowIso,
      lastAttemptAt: nowIso,
    };

    this._attempts.set(id, record);
    return record;
  }

  /**
   * Records a confirmed delivery outcome.
   * 
   * @param {string} id
   * @param {object} outcome
   */
  recordSuccess(id, outcome = {}) {
    const record = this._attempts.get(id) || this.recordStart(id);
    record.state = ATTEMPT_STATE.SENT;
    record.lastAttemptAt = new Date().toISOString();
    record.outcome = outcome;
    return record;
  }

  /**
   * Records an attempt failure.
   * 
   * @param {string} id
   * @param {Error|object} error
   * @param {object} [options]
   * @param {boolean} [options.isAmbiguous=false]
   */
  recordFailure(id, error, { isAmbiguous = false } = {}) {
    const record = this._attempts.get(id) || this.recordStart(id);
    record.state = isAmbiguous ? ATTEMPT_STATE.UNCERTAIN : ATTEMPT_STATE.FAILED;
    record.lastAttemptAt = new Date().toISOString();
    record.lastError = error?.message || String(error);
    record.errorCode = error?.code || (isAmbiguous ? 'AMBIGUOUS_OUTCOME' : 'FAILED');
    return record;
  }

  /**
   * Resets all recorded attempts (useful for tests).
   */
  clear() {
    this._attempts.clear();
  }
}
