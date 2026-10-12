import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateHandoff } from '../../src/handoffs/validation.js';
import { NON_WAIVABLE_CHECKS, VALIDATION_CHECK_NAMES } from '../../src/constants.js';

function baseInput(overrides = {}) {
  return {
    projectExists: true,
    fromUserId: 'user-A',
    toUserId: 'user-B',
    currentStatus: 'Migration is 80% complete, waiting on DB index rebuild',
    items: [{ type: 'pending', text: 'Rebuild index' }],
    noPendingActionsConfirmed: false,
    openTasks: [],
    supportingLinks: ['https://example.com/doc'],
    documentIds: [],
    openConflicts: [],
    ...overrides,
  };
}

function checkByName(result, name) {
  return result.checks.find((c) => c.name === name);
}

describe('happy path', () => {
  test('fully complete input is ready with score 100', () => {
    const result = validateHandoff(baseInput());
    assert.equal(result.ready, true);
    assert.equal(result.score, 100);
    assert.deepEqual(result.missingFields, []);
    assert.equal(result.checks.length, VALIDATION_CHECK_NAMES.length);
  });
});

describe('every validation rule', () => {
  test('project_exists fails when projectExists is false', () => {
    const result = validateHandoff(baseInput({ projectExists: false }));
    assert.equal(checkByName(result, 'project_exists').passed, false);
    assert.equal(result.ready, false);
  });

  test('incoming_owner_specified fails when missing', () => {
    const result = validateHandoff(baseInput({ toUserId: null }));
    assert.equal(checkByName(result, 'incoming_owner_specified').passed, false);
  });

  test('incoming_owner_specified fails when same as outgoing', () => {
    const result = validateHandoff(baseInput({ toUserId: 'user-A' }));
    assert.equal(checkByName(result, 'incoming_owner_specified').passed, false);
  });

  test('current_status_documented fails on blank status', () => {
    const result = validateHandoff(baseInput({ currentStatus: '   ' }));
    assert.equal(checkByName(result, 'current_status_documented').passed, false);
  });

  test('pending_actions_listed passes via items, openTasks, or explicit confirmation', () => {
    assert.equal(
      checkByName(validateHandoff(baseInput({ items: [], openTasks: [] })), 'pending_actions_listed')
        .passed,
      false
    );
    assert.equal(
      checkByName(
        validateHandoff(baseInput({ items: [], openTasks: [], noPendingActionsConfirmed: true })),
        'pending_actions_listed'
      ).passed,
      true
    );
    assert.equal(
      checkByName(
        validateHandoff(baseInput({ items: [], openTasks: [{ assignee: 'u', priority: 'low', deadline: null }] })),
        'pending_actions_listed'
      ).passed,
      true
    );
  });

  test('task_owners_assigned fails when any open task has no assignee', () => {
    const result = validateHandoff(
      baseInput({ openTasks: [{ assignee: null, priority: 'low', deadline: null }] })
    );
    assert.equal(checkByName(result, 'task_owners_assigned').passed, false);
  });

  test('mandatory_deadlines_present only applies to high/critical priority', () => {
    const lowOk = validateHandoff(
      baseInput({ openTasks: [{ assignee: 'u', priority: 'low', deadline: null }] })
    );
    assert.equal(checkByName(lowOk, 'mandatory_deadlines_present').passed, true);

    const highMissing = validateHandoff(
      baseInput({ openTasks: [{ assignee: 'u', priority: 'high', deadline: null }] })
    );
    assert.equal(checkByName(highMissing, 'mandatory_deadlines_present').passed, false);

    const criticalOk = validateHandoff(
      baseInput({ openTasks: [{ assignee: 'u', priority: 'critical', deadline: '2026-01-01' }] })
    );
    assert.equal(checkByName(criticalOk, 'mandatory_deadlines_present').passed, true);
  });

  test('supporting_links_provided passes via links or documents', () => {
    assert.equal(
      checkByName(
        validateHandoff(baseInput({ supportingLinks: [], documentIds: [] })),
        'supporting_links_provided'
      ).passed,
      false
    );
    assert.equal(
      checkByName(
        validateHandoff(baseInput({ supportingLinks: [], documentIds: ['doc1'] })),
        'supporting_links_provided'
      ).passed,
      true
    );
  });

  test('critical_conflicts_reviewed fails only on open high/critical severity', () => {
    const mediumOk = validateHandoff(baseInput({ openConflicts: [{ severity: 'medium' }] }));
    assert.equal(checkByName(mediumOk, 'critical_conflicts_reviewed').passed, true);

    const highFails = validateHandoff(baseInput({ openConflicts: [{ severity: 'high' }] }));
    assert.equal(checkByName(highFails, 'critical_conflicts_reviewed').passed, false);
  });
});

describe('waivers', () => {
  test('a documented exception waives a failed waivable check and counts toward score', () => {
    const input = baseInput({ supportingLinks: [], documentIds: [] });
    const result = validateHandoff(input, [
      { checkName: 'supporting_links_provided', reason: 'Docs will be uploaded after migration window' },
    ]);
    const check = checkByName(result, 'supporting_links_provided');
    assert.equal(check.passed, false);
    assert.equal(check.waived, true);
    assert.equal(check.waivedReason, 'Docs will be uploaded after migration window');
    assert.equal(result.ready, true);
    assert.equal(result.score, 100);
    assert.deepEqual(result.missingFields, []);
  });

  test('a blank-reason exception does not waive the check', () => {
    const input = baseInput({ supportingLinks: [], documentIds: [] });
    const result = validateHandoff(input, [{ checkName: 'supporting_links_provided', reason: '   ' }]);
    const check = checkByName(result, 'supporting_links_provided');
    assert.equal(check.waived, false);
    assert.equal(result.ready, false);
  });
});

describe('non-waivable checks', () => {
  for (const name of NON_WAIVABLE_CHECKS) {
    test(`${name} cannot be waived even with a documented exception`, () => {
      const input =
        name === 'project_exists'
          ? baseInput({ projectExists: false })
          : baseInput({ toUserId: null });
      const result = validateHandoff(input, [{ checkName: name, reason: 'Please waive this' }]);
      const check = checkByName(result, name);
      assert.equal(check.passed, false);
      assert.equal(check.waived, false);
      assert.equal(result.ready, false);
      assert.ok(result.missingFields.includes(name));
    });
  }
});

describe('score math', () => {
  test('score is percent of satisfied checks (passed or waived)', () => {
    // Fail 2 of 8 checks, waive 1 of them -> 7/8 satisfied = 88% (rounded)
    const input = baseInput({
      currentStatus: '',
      supportingLinks: [],
      documentIds: [],
    });
    const result = validateHandoff(input, [
      { checkName: 'supporting_links_provided', reason: 'will add later' },
    ]);
    assert.equal(result.score, Math.round((7 / 8) * 100));
    assert.equal(result.ready, false);
    assert.deepEqual(result.missingFields, ['current_status_documented']);
  });
});
