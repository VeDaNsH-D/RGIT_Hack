import { Router } from 'express';
import { createTaskSchema, updateTaskSchema, taskQuerySchema } from '../contracts/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, attachTaskProjectContext, requireRole, getMembership } from '../middleware/access.js';
import { Task } from '../models/Task.js';
import { logActivity } from '../audit/service.js';

const router = Router();

function serializeTask(task) {
  const now = new Date();
  return {
    id: String(task._id),
    projectId: String(task.projectId),
    title: task.title,
    description: task.description,
    origin: task.origin,
    sourceRecordId: task.sourceRecordId ? String(task.sourceRecordId) : null,
    assignee: task.assignee ? String(task.assignee) : null,
    deadline: task.deadline,
    priority: task.priority,
    status: task.status,
    overdue: task.status === 'open' && Boolean(task.deadline) && new Date(task.deadline) < now,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function assertAssigneeIsMember(projectId, assignee) {
  if (!assignee) return;
  const membership = await getMembership(projectId, assignee);
  if (!membership) {
    const err = new Error('assignee must be a member of this project');
    err.status = 400;
    err.code = 'invalid_assignee';
    throw err;
  }
}

router.post(
  '/projects/:id/tasks',
  requireAuth,
  attachProject(),
  requireRole('member'),
  async (req, res, next) => {
    try {
      const body = createTaskSchema.parse(req.body);
      await assertAssigneeIsMember(req.project._id, body.assignee);

      const task = await Task.create({
        projectId: req.project._id,
        title: body.title,
        description: body.description,
        origin: 'manual',
        assignee: body.assignee || null,
        deadline: body.deadline ? new Date(body.deadline) : null,
        priority: body.priority,
        createdBy: req.user._id,
      });

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'TASK_CREATED',
        targetType: 'Task',
        targetId: task._id,
        payload: { title: task.title, priority: task.priority },
      });

      res.status(201).json({ task: serializeTask(task) });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

router.get(
  '/projects/:id/tasks',
  requireAuth,
  attachProject(),
  requireRole('viewer'),
  async (req, res, next) => {
    try {
      const query = taskQuerySchema.parse(req.query);
      const filter = { projectId: req.project._id };
      if (query.status) filter.status = query.status;
      if (query.assignee) filter.assignee = query.assignee;

      const skip = (query.page - 1) * query.limit;
      let items = await Task.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean();
      const total = await Task.countDocuments(filter);

      if (query.overdue !== undefined) {
        const now = new Date();
        items = items.filter((t) => {
          const isOverdue = t.status === 'open' && Boolean(t.deadline) && new Date(t.deadline) < now;
          return isOverdue === query.overdue;
        });
      }

      res.json({ tasks: items.map(serializeTask), total, page: query.page, limit: query.limit });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

router.patch('/tasks/:id', requireAuth, attachTaskProjectContext(), requireRole('member'), async (req, res, next) => {
  try {
    const body = updateTaskSchema.parse(req.body);

    if (body.assignee !== undefined) {
      await assertAssigneeIsMember(req.project._id, body.assignee);
      req.task.assignee = body.assignee || null;
    }
    if (body.title !== undefined) req.task.title = body.title;
    if (body.description !== undefined) req.task.description = body.description;
    if (body.deadline !== undefined) req.task.deadline = body.deadline ? new Date(body.deadline) : null;
    if (body.priority !== undefined) req.task.priority = body.priority;
    if (body.status !== undefined) {
      req.task.status = body.status;
      // Imported tasks are never written back to their source on
      // completion (or any other change) — this route only ever touches
      // our own Task document.
      req.task.completedAt = body.status === 'completed' ? new Date() : null;
    }

    await req.task.save();

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'TASK_UPDATED',
      targetType: 'Task',
      targetId: req.task._id,
      payload: body,
    });

    res.json({ task: serializeTask(req.task) });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    next(err);
  }
});

export default router;
