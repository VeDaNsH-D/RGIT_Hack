import { Task } from '../models/Task.js';
import { Conflict } from '../models/Conflict.js';
import { validateHandoff } from './validation.js';

/**
 * Builds the input for the pure validateHandoff() check from live DB
 * state. This is the only DB-dependent piece of the validation pipeline —
 * validateHandoff() itself stays pure (see validation.js).
 */
export async function buildValidationInput(project, handoff) {
  const [openTasks, openConflicts] = await Promise.all([
    Task.find({ projectId: project._id, status: 'open' }).select('assignee deadline priority').lean(),
    Conflict.find({ projectId: project._id, status: 'open' }).select('severity').lean(),
  ]);

  return {
    projectExists: true,
    fromUserId: String(handoff.fromUserId),
    toUserId: handoff.toUserId ? String(handoff.toUserId) : null,
    currentStatus: handoff.currentStatus,
    items: handoff.items,
    noPendingActionsConfirmed: handoff.noPendingActionsConfirmed,
    openTasks: openTasks.map((t) => ({
      assignee: t.assignee ? String(t.assignee) : null,
      deadline: t.deadline,
      priority: t.priority,
    })),
    supportingLinks: handoff.supportingLinks,
    documentIds: handoff.documentIds,
    openConflicts: openConflicts.map((c) => ({ severity: c.severity })),
  };
}

export async function runValidation(project, handoff) {
  const input = await buildValidationInput(project, handoff);
  return validateHandoff(input, handoff.exceptions);
}
