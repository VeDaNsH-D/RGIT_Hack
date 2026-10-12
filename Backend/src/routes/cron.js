import { Router } from 'express';
import { requireCronAuth } from '../middleware/cronAuth.js';
import { Task } from '../models/Task.js';
import { Handoff } from '../models/Handoff.js';
import { Project } from '../models/Project.js';
import { logActivity } from '../audit/service.js';
import { emitNotificationEvent } from '../notifications/emitEvent.js';
import { config } from '../config.js';

const router = Router();

const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Finds open tasks past their deadline and atomically "claims" each one
 * (conditional update, same filter as the find) so two overlapping cron
 * runs can never both alert on the same task. A task already claimed
 * within the last 24h is skipped — reminders repeat at most once a day.
 */
async function claimOverdueTasks(now) {
  const cutoff = new Date(now.getTime() - REMINDER_COOLDOWN_MS);
  const filter = {
    status: 'open',
    deadline: { $lt: now },
    $or: [{ overdueNotifiedAt: null }, { overdueNotifiedAt: { $lt: cutoff } }],
  };

  const candidates = await Task.find(filter).select('_id').lean();

  const claimed = [];
  for (const { _id } of candidates) {
    const updated = await Task.findOneAndUpdate(
      { _id, ...filter },
      { $set: { overdueNotifiedAt: now } },
      { new: true }
    );
    if (updated) claimed.push(updated);
  }
  return claimed;
}

/** Same claim-once pattern, for SUBMITTED handoffs stuck past the ack SLA. */
async function claimOverdueHandoffs(now) {
  const slaDeadline = new Date(now.getTime() - config.ackSlaHours * 60 * 60 * 1000);
  const cutoff = new Date(now.getTime() - REMINDER_COOLDOWN_MS);
  const filter = {
    state: 'SUBMITTED',
    submittedAt: { $lt: slaDeadline },
    $or: [{ ackReminderSentAt: null }, { ackReminderSentAt: { $lt: cutoff } }],
  };

  const candidates = await Handoff.find(filter).select('_id').lean();

  const claimed = [];
  for (const { _id } of candidates) {
    const updated = await Handoff.findOneAndUpdate(
      { _id, ...filter },
      { $set: { ackReminderSentAt: now } },
      { new: true }
    );
    if (updated) claimed.push(updated);
  }
  return claimed;
}

router.get('/cron/overdue', requireCronAuth, async (req, res, next) => {
  try {
    const now = new Date();

    const [overdueTasks, overdueHandoffs] = await Promise.all([
      claimOverdueTasks(now),
      claimOverdueHandoffs(now),
    ]);

    const projectCache = new Map();
    async function getProject(projectId) {
      const key = String(projectId);
      if (!projectCache.has(key)) {
        projectCache.set(key, await Project.findById(projectId).lean());
      }
      return projectCache.get(key);
    }

    for (const task of overdueTasks) {
      const project = await getProject(task.projectId);
      const recipientUserId = task.assignee || project?.ownerId;

      await logActivity({
        projectId: task.projectId,
        actorId: null,
        actorType: 'system',
        action: 'TASK_OVERDUE',
        targetType: 'Task',
        targetId: task._id,
        payload: { title: task.title, deadline: task.deadline },
      });

      if (recipientUserId) {
        await emitNotificationEvent({
          type: 'TASK_OVERDUE',
          projectId: task.projectId,
          recipientUserId,
          dedupeKey: `task-overdue-${task._id}-${task.overdueNotifiedAt.toISOString()}`,
          payload: { entityId: String(task._id), title: task.title, deadline: task.deadline },
        });
      }
    }

    for (const handoff of overdueHandoffs) {
      await logActivity({
        projectId: handoff.projectId,
        actorId: null,
        actorType: 'system',
        action: 'HANDOFF_ACK_OVERDUE',
        targetType: 'Handoff',
        targetId: handoff._id,
        payload: { submittedAt: handoff.submittedAt },
      });

      // The recipient (who hasn't acknowledged) and the outgoing owner
      // (who remains accountable until acknowledgement) both get alerted.
      for (const recipientUserId of [handoff.toUserId, handoff.fromUserId]) {
        await emitNotificationEvent({
          type: 'HANDOFF_ACK_OVERDUE',
          projectId: handoff.projectId,
          recipientUserId,
          dedupeKey: `handoff-ack-overdue-${handoff._id}-${recipientUserId}-${handoff.ackReminderSentAt.toISOString()}`,
          payload: { entityId: String(handoff._id), submittedAt: handoff.submittedAt },
        });
      }
    }

    res.json({
      processed: {
        overdueTasks: overdueTasks.length,
        overdueHandoffs: overdueHandoffs.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
