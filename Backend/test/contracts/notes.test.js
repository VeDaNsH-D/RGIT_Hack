import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CreateNoteBody, updateNoteSchema, noteQuerySchema } from '../../src/contracts/schemas.js';

describe('CreateNoteBody', () => {
  test('valid decision payload passes', () => {
    const r = CreateNoteBody.safeParse({
      recordType: 'decision',
      title: 'Use Postgres for the ledger service',
      content: 'Chosen for transactional guarantees over the alternatives.',
      observedAt: '2026-01-05T00:00:00.000Z',
      url: 'https://example.com/rfc/42',
    });
    assert.equal(r.success, true);
  });

  test('valid minimal note payload passes with defaults', () => {
    const r = CreateNoteBody.safeParse({ recordType: 'note', title: 'Quick status update' });
    assert.equal(r.success, true);
    assert.equal(r.data.content, '');
  });

  test('missing required fields fail', () => {
    assert.equal(CreateNoteBody.safeParse({ title: 'No record type' }).success, false);
    assert.equal(CreateNoteBody.safeParse({ recordType: 'note' }).success, false);
  });

  test('rejects invalid recordType', () => {
    const r = CreateNoteBody.safeParse({ recordType: 'memo', title: 'x' });
    assert.equal(r.success, false);
  });

  test('rejects extra fields (strict)', () => {
    const r = CreateNoteBody.safeParse({
      recordType: 'note',
      title: 'x',
      provider: 'manual',
      author: 'Injected Author',
    });
    assert.equal(r.success, false);
  });

  test('rejects a non-http(s) url', () => {
    const r = CreateNoteBody.safeParse({ recordType: 'note', title: 'x', url: 'ftp://example.com/f' });
    assert.equal(r.success, false);
  });

  test('rejects title over 500 chars', () => {
    const r = CreateNoteBody.safeParse({ recordType: 'note', title: 'a'.repeat(501) });
    assert.equal(r.success, false);
  });
});

describe('updateNoteSchema', () => {
  test('requires at least one field', () => {
    assert.equal(updateNoteSchema.safeParse({}).success, false);
  });

  test('rejects recordType changes (immutable)', () => {
    const r = updateNoteSchema.safeParse({ recordType: 'decision' });
    assert.equal(r.success, false);
  });

  test('accepts a partial update', () => {
    assert.equal(updateNoteSchema.safeParse({ title: 'New title' }).success, true);
  });
});

describe('noteQuerySchema', () => {
  test('defaults applied, recordType optional', () => {
    const r = noteQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data.page, 1);
  });

  test('rejects invalid recordType filter', () => {
    assert.equal(noteQuerySchema.safeParse({ recordType: 'memo' }).success, false);
  });
});
