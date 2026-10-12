import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerSchema,
  loginSchema,
  createProjectSchema,
  updateProjectSchema,
  addMemberSchema,
  createTaskSchema,
  updateTaskSchema,
  taskQuerySchema,
  createHandoffSchema,
  updateHandoffSchema,
  exceptionSchema,
  clarificationNoteSchema,
  createConflictSchema,
  resolveConflictSchema,
  paginationQuerySchema,
  notificationEventSchema,
  objectId,
  httpUrl,
} from '../../src/contracts/schemas.js';

const VALID_ID = '507f1f77bcf86cd799439011';
const VALID_ID_2 = '507f1f77bcf86cd799439012';

describe('objectId / httpUrl primitives', () => {
  test('objectId accepts a 24-char hex string', () => {
    assert.equal(objectId.safeParse(VALID_ID).success, true);
  });

  test('objectId rejects non-hex / wrong length', () => {
    assert.equal(objectId.safeParse('not-an-id').success, false);
    assert.equal(objectId.safeParse('507f1f77bcf86cd79943901').success, false);
  });

  test('httpUrl accepts http/https', () => {
    assert.equal(httpUrl.safeParse('https://example.com/doc').success, true);
    assert.equal(httpUrl.safeParse('http://example.com').success, true);
  });

  test('httpUrl rejects other schemes', () => {
    assert.equal(httpUrl.safeParse('ftp://example.com').success, false);
    assert.equal(httpUrl.safeParse('javascript:alert(1)').success, false);
  });
});

describe('auth schemas', () => {
  test('register: valid payload passes', () => {
    const r = registerSchema.safeParse({ email: 'a@b.com', password: 'password123', name: 'Ann' });
    assert.equal(r.success, true);
  });

  test('register: rejects extra fields', () => {
    const r = registerSchema.safeParse({
      email: 'a@b.com',
      password: 'password123',
      name: 'Ann',
      isAdmin: true,
    });
    assert.equal(r.success, false);
  });

  test('register: rejects short password', () => {
    const r = registerSchema.safeParse({ email: 'a@b.com', password: 'short', name: 'Ann' });
    assert.equal(r.success, false);
  });

  test('login: rejects invalid email', () => {
    const r = loginSchema.safeParse({ email: 'not-an-email', password: 'x' });
    assert.equal(r.success, false);
  });
});

describe('project schemas', () => {
  test('create: valid minimal payload', () => {
    const r = createProjectSchema.safeParse({ name: 'Atlas' });
    assert.equal(r.success, true);
    assert.equal(r.data.description, '');
  });

  test('create: rejects ownerId injection', () => {
    const r = createProjectSchema.safeParse({ name: 'Atlas', ownerId: VALID_ID });
    assert.equal(r.success, false);
  });

  test('update: requires at least one field', () => {
    const r = updateProjectSchema.safeParse({});
    assert.equal(r.success, false);
  });
});

describe('member schema', () => {
  test('accepts viewer/member roles', () => {
    assert.equal(addMemberSchema.safeParse({ email: 'a@b.com', role: 'viewer' }).success, true);
    assert.equal(addMemberSchema.safeParse({ email: 'a@b.com', role: 'member' }).success, true);
  });

  test('rejects role: owner', () => {
    const r = addMemberSchema.safeParse({ email: 'a@b.com', role: 'owner' });
    assert.equal(r.success, false);
  });
});

describe('task schemas', () => {
  test('create: valid payload with defaults', () => {
    const r = createTaskSchema.safeParse({ title: 'Do the thing' });
    assert.equal(r.success, true);
    assert.equal(r.data.priority, 'medium');
  });

  test('create: rejects origin/status injection', () => {
    const r = createTaskSchema.safeParse({ title: 'Do the thing', origin: 'imported' });
    assert.equal(r.success, false);
  });

  test('create: rejects invalid priority', () => {
    const r = createTaskSchema.safeParse({ title: 'Do the thing', priority: 'urgent' });
    assert.equal(r.success, false);
  });

  test('update: requires at least one field, rejects empty object', () => {
    assert.equal(updateTaskSchema.safeParse({}).success, false);
    assert.equal(updateTaskSchema.safeParse({ status: 'completed' }).success, true);
  });

  test('query: coerces overdue string to boolean', () => {
    const r = taskQuerySchema.safeParse({ overdue: 'true' });
    assert.equal(r.success, true);
    assert.equal(r.data.overdue, true);
  });

  test('query: rejects unknown status value', () => {
    const r = taskQuerySchema.safeParse({ status: 'archived' });
    assert.equal(r.success, false);
  });
});

describe('handoff schemas', () => {
  test('create: valid toUserId', () => {
    assert.equal(createHandoffSchema.safeParse({ toUserId: VALID_ID }).success, true);
  });

  test('create: rejects state/fromUserId injection', () => {
    const r = createHandoffSchema.safeParse({ toUserId: VALID_ID, state: 'ACKNOWLEDGED' });
    assert.equal(r.success, false);
  });

  test('update: validates item type enum and requires text', () => {
    const ok = updateHandoffSchema.safeParse({
      items: [{ type: 'pending', text: 'Finish the migration' }],
    });
    assert.equal(ok.success, true);

    const bad = updateHandoffSchema.safeParse({
      items: [{ type: 'not-a-type', text: 'x' }],
    });
    assert.equal(bad.success, false);
  });

  test('update: supportingLinks must be http(s)', () => {
    const r = updateHandoffSchema.safeParse({ supportingLinks: ['ftp://bad.example'] });
    assert.equal(r.success, false);
  });

  test('update: rejects empty object', () => {
    assert.equal(updateHandoffSchema.safeParse({}).success, false);
  });
});

describe('exception and clarification schemas', () => {
  test('exception requires non-blank reason', () => {
    assert.equal(
      exceptionSchema.safeParse({ checkName: 'supporting_links_provided', reason: 'Docs pending upload' })
        .success,
      true
    );
    assert.equal(
      exceptionSchema.safeParse({ checkName: 'supporting_links_provided', reason: '   ' }).success,
      false
    );
  });

  test('exception rejects unknown check name', () => {
    const r = exceptionSchema.safeParse({ checkName: 'not_a_real_check', reason: 'x' });
    assert.equal(r.success, false);
  });

  test('clarification note requires non-blank text', () => {
    assert.equal(clarificationNoteSchema.safeParse({ note: 'Please clarify X' }).success, true);
    assert.equal(clarificationNoteSchema.safeParse({ note: '' }).success, false);
  });
});

describe('conflict schemas', () => {
  const evidence = (n) =>
    Array.from({ length: n }, (_, i) => ({ sourceType: 'document', excerpt: `evidence ${i}` }));

  test('create: requires at least 2 evidence items', () => {
    assert.equal(
      createConflictSchema.safeParse({ title: 'Conflicting deadline', evidence: evidence(1) }).success,
      false
    );
    assert.equal(
      createConflictSchema.safeParse({ title: 'Conflicting deadline', evidence: evidence(2) }).success,
      true
    );
  });

  test('resolve: requires outcome enum and non-blank note', () => {
    assert.equal(resolveConflictSchema.safeParse({ outcome: 'resolved', note: 'fixed' }).success, true);
    assert.equal(resolveConflictSchema.safeParse({ outcome: 'closed', note: 'x' }).success, false);
    assert.equal(resolveConflictSchema.safeParse({ outcome: 'resolved', note: '' }).success, false);
  });
});

describe('pagination schema', () => {
  test('defaults applied when omitted', () => {
    const r = paginationQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data.page, 1);
    assert.equal(r.data.limit, 20);
  });

  test('rejects limit above 100', () => {
    assert.equal(paginationQuerySchema.safeParse({ limit: '500' }).success, false);
  });
});

describe('notification event schema', () => {
  test('valid event passes', () => {
    const r = notificationEventSchema.safeParse({
      type: 'TASK_OVERDUE',
      recipientUserId: VALID_ID,
      projectId: VALID_ID_2,
      payload: { taskId: VALID_ID },
    });
    assert.equal(r.success, true);
  });

  test('rejects unknown event type', () => {
    const r = notificationEventSchema.safeParse({ type: 'SOMETHING_ELSE', recipientUserId: VALID_ID });
    assert.equal(r.success, false);
  });

  test('rejects missing recipientUserId', () => {
    const r = notificationEventSchema.safeParse({ type: 'TASK_OVERDUE' });
    assert.equal(r.success, false);
  });
});
