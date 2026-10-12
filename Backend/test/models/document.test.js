import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Document } from '../../src/models/Document.js';

// No DB connection needed: constructing a document and reading schema
// defaults/validation doesn't require persistence.

describe('Document.storageRef', () => {
  test('defaults to provider "none" with empty key/url when not provided', () => {
    const doc = new Document({
      projectId: new mongoose.Types.ObjectId(),
      title: 'Spec.pdf',
      uploadedBy: new mongoose.Types.ObjectId(),
    });
    assert.equal(doc.storageRef.provider, 'none');
    assert.equal(doc.storageRef.key, '');
    assert.equal(doc.storageRef.url, '');
  });

  test('accepts a populated storageRef', () => {
    const doc = new Document({
      projectId: new mongoose.Types.ObjectId(),
      title: 'Spec.pdf',
      uploadedBy: new mongoose.Types.ObjectId(),
      storageRef: { provider: 's3', key: 'docs/abc123', url: 'https://cdn.example.com/abc123' },
    });
    assert.equal(doc.storageRef.provider, 's3');
    assert.equal(doc.storageRef.key, 'docs/abc123');
  });

  test('rejects an invalid storageRef.provider', () => {
    const doc = new Document({
      projectId: new mongoose.Types.ObjectId(),
      title: 'Spec.pdf',
      uploadedBy: new mongoose.Types.ObjectId(),
      storageRef: { provider: 'dropbox' },
    });
    const err = doc.validateSync();
    assert.ok(err, 'expected a validation error for an invalid storageRef.provider');
    assert.ok(err.errors['storageRef.provider']);
  });

  test('extractedText stays select:false', () => {
    const path = Document.schema.path('extractedText');
    assert.equal(path.selectOptions ? path.selectOptions.select : path.options.select, false);
  });
});
