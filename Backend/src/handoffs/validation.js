import { NON_WAIVABLE_CHECKS, VALIDATION_CHECK_NAMES } from '../constants.js';

const HIGH_SEVERITY = ['high', 'critical'];

/**
 * @typedef {object} ValidationInput
 * @property {boolean} projectExists
 * @property {string|null} fromUserId
 * @property {string|null} toUserId
 * @property {string} currentStatus
 * @property {Array<object>} items - handoff items (completed/pending/blocker/...)
 * @property {boolean} noPendingActionsConfirmed
 * @property {Array<{assignee: string|null, deadline: string|Date|null, priority: string}>} openTasks
 * @property {string[]} supportingLinks
 * @property {string[]} documentIds
 * @property {Array<{severity: string}>} openConflicts
 */

const CHECK_DEFINITIONS = [
  {
    name: 'project_exists',
    run: (input) => Boolean(input.projectExists),
    reason: 'Project does not exist',
  },
  {
    name: 'incoming_owner_specified',
    run: (input) => Boolean(input.toUserId) && input.toUserId !== input.fromUserId,
    reason: 'Incoming owner must be specified and different from the outgoing owner',
  },
  {
    name: 'current_status_documented',
    run: (input) => Boolean(input.currentStatus && input.currentStatus.trim().length > 0),
    reason: 'Current status must be documented',
  },
  {
    name: 'pending_actions_listed',
    run: (input) => {
      const items = input.items || [];
      const openTasks = input.openTasks || [];
      return items.length > 0 || openTasks.length > 0 || input.noPendingActionsConfirmed === true;
    },
    reason: 'Pending actions must be listed, or explicitly confirmed as none',
  },
  {
    name: 'task_owners_assigned',
    run: (input) => (input.openTasks || []).every((t) => Boolean(t.assignee)),
    reason: 'All open tasks must have an assignee',
  },
  {
    name: 'mandatory_deadlines_present',
    run: (input) =>
      (input.openTasks || [])
        .filter((t) => HIGH_SEVERITY.includes(t.priority))
        .every((t) => Boolean(t.deadline)),
    reason: 'All open high/critical priority tasks must have a deadline',
  },
  {
    name: 'supporting_links_provided',
    run: (input) => (input.supportingLinks || []).length > 0 || (input.documentIds || []).length > 0,
    reason: 'At least one supporting link or document must be provided',
  },
  {
    name: 'critical_conflicts_reviewed',
    run: (input) => (input.openConflicts || []).every((c) => !HIGH_SEVERITY.includes(c.severity)),
    reason: 'All open high/critical conflicts must be reviewed or resolved',
  },
];

// Guard against CHECK_DEFINITIONS and the shared constant list drifting apart.
const definedNames = CHECK_DEFINITIONS.map((d) => d.name).sort();
const constantNames = [...VALIDATION_CHECK_NAMES].sort();
if (JSON.stringify(definedNames) !== JSON.stringify(constantNames)) {
  throw new Error('validation.js CHECK_DEFINITIONS is out of sync with VALIDATION_CHECK_NAMES');
}

/**
 * Pure completeness validator. No DB, no clock — the caller resolves all
 * inputs (project existence, open tasks, open conflicts, etc.) beforehand.
 *
 * @param {ValidationInput} input
 * @param {Array<{checkName: string, reason: string}>} [exceptions] - documented exceptions already recorded on the handoff
 * @returns {{ ready: boolean, score: number, missingFields: string[], checks: Array<{name: string, passed: boolean, waived: boolean, reason: string, waivedReason: string}> }}
 */
export function validateHandoff(input, exceptions = []) {
  const exceptionByCheck = new Map();
  for (const ex of exceptions) {
    if (ex && ex.reason && ex.reason.trim().length > 0 && !exceptionByCheck.has(ex.checkName)) {
      exceptionByCheck.set(ex.checkName, ex.reason.trim());
    }
  }

  const checks = CHECK_DEFINITIONS.map((def) => {
    const passed = Boolean(def.run(input));
    let waived = false;
    let waivedReason = '';

    if (!passed && !NON_WAIVABLE_CHECKS.includes(def.name) && exceptionByCheck.has(def.name)) {
      waived = true;
      waivedReason = exceptionByCheck.get(def.name);
    }

    return {
      name: def.name,
      passed,
      waived,
      reason: passed ? '' : def.reason,
      waivedReason,
    };
  });

  const satisfiedCount = checks.filter((c) => c.passed || c.waived).length;
  const ready = satisfiedCount === checks.length;
  const score = Math.round((satisfiedCount / checks.length) * 100);
  const missingFields = checks.filter((c) => !c.passed && !c.waived).map((c) => c.name);

  return { ready, score, missingFields, checks };
}
