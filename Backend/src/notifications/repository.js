/**
 * Notification Storage Repository Interface & In-Memory Implementation
 * 
 * Provides a storage-agnostic abstraction for persisting and querying
 * notification presentation records.
 */

export class NotificationRepositoryError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NotificationRepositoryError';
    if (cause) this.cause = cause;
  }
}

/**
 * In-Memory Notification Repository
 * 
 * Designed for automated testing, local development, and CI environments.
 * Stores records safely in an internal Map and deep-clones entities to prevent
 * cross-test mutations or external state corruption.
 * 
 * NOTE: Not intended for distributed production persistence.
 */
export class InMemoryNotificationRepository {
  constructor() {
    /** @type {Map<string, import('./records.js').NotificationRecord>} */
    this._recordsById = new Map();
  }

  /**
   * Persists a notification record in memory.
   * 
   * @param {import('./records.js').NotificationRecord} record
   * @returns {Promise<import('./records.js').NotificationRecord>}
   */
  async create(record) {
    if (!record || !record.id) {
      throw new NotificationRepositoryError('Cannot save notification without a valid id.');
    }

    if (this._recordsById.has(record.id)) {
      throw new NotificationRepositoryError(`Notification with id '${record.id}' already exists.`);
    }

    // Deep clone to prevent external mutation
    const cloned = structuredClone(record);
    this._recordsById.set(cloned.id, cloned);

    return structuredClone(cloned);
  }

  /**
   * Finds a notification record by its unique ID.
   * 
   * @param {string} id
   * @returns {Promise<import('./records.js').NotificationRecord | null>}
   */
  async findById(id) {
    if (!id || typeof id !== 'string') {
      return null;
    }

    const record = this._recordsById.get(id);
    return record ? structuredClone(record) : null;
  }

  /**
   * Finds all notifications for a specific recipient user.
   * 
   * @param {string} recipientUserId
   * @param {{ unreadOnly?: boolean, limit?: number, offset?: number }} [options={}]
   * @returns {Promise<import('./records.js').NotificationRecord[]>}
   */
  async findByRecipient(recipientUserId, options = {}) {
    if (!recipientUserId || typeof recipientUserId !== 'string') {
      return [];
    }

    let records = Array.from(this._recordsById.values()).filter(
      (rec) => rec.recipientUserId === recipientUserId
    );

    if (options.unreadOnly) {
      records = records.filter((rec) => rec.readAt === null);
    }

    // Sort by createdAt descending (newest first)
    records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const offset = Math.max(0, options.offset || 0);
    if (offset > 0) {
      records = records.slice(offset);
    }

    const limit = options.limit;
    if (typeof limit === 'number' && limit > 0) {
      records = records.slice(0, limit);
    }

    return structuredClone(records);
  }

  /**
   * Finds a notification associated with a specific event ID (used for idempotency/duplicate detection).
   * 
   * @param {string} eventId
   * @returns {Promise<import('./records.js').NotificationRecord | null>}
   */
  async findByEventId(eventId) {
    if (!eventId || typeof eventId !== 'string') {
      return null;
    }

    for (const record of this._recordsById.values()) {
      if (record.eventId === eventId) {
        return structuredClone(record);
      }
    }

    return null;
  }

  /**
   * Clears all in-memory records (useful for test resets).
   */
  clear() {
    this._recordsById.clear();
  }
}
