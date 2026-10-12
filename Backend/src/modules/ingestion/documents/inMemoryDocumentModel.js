/**
 * @file inMemoryDocumentModel.js
 * @description Test double for the Document model's `create`. Every document is
 * built and validated with the REAL Document schema (`validateSync`), so field
 * names, required fields, enums and casting match production.
 */

import { Document } from '../../../models/Document.js';

export class InMemoryDocumentModel {
  constructor() {
    this.docs = [];
    this.createCalls = 0;
    this.#createError = null;
  }

  #createError;

  /** Make the next create() reject (e.g. database unavailable). */
  failNextCreate(error = new Error('connection closed')) {
    this.#createError = error;
  }

  async create(data) {
    this.createCalls += 1;
    if (this.#createError) {
      const err = this.#createError;
      this.#createError = null;
      throw err;
    }
    const doc = new Document(data);
    const validationError = doc.validateSync();
    if (validationError) throw validationError;
    const now = new Date();
    doc.createdAt = now;
    doc.updatedAt = now;
    this.docs.push(doc);
    return doc;
  }
}
