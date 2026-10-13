import { Router } from 'express';
import { createTaskSchema, updateTaskSchema, taskQuerySchema } from '../contracts/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, attachTaskProjectContext, requireRole, getMembership } from '../middleware/access.js';
import { Task } from '../models/Task.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { GitHubInstallation } from '../models/GitHubInstallation.js';
import { logActivity } from '../audit/service.js';
import { TaskSyncError, serializeTaskGithub, syncTaskIssue } from '../services/githubIssueSync.js';

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
    github: serializeTaskGithub(task.github),
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

const repositoryError = (status, code, message) => Object.assign(new Error(message), { status, code });

const githubRows = (projectId) => SourceConnection.find({ projectId, provider: 'github', 'config.repositoryId': { $type: 'number' } }).sort({ createdAt: 1 }).lean();

const installationActive = (row) =>
  GitHubInstallation.exists({ userId: row.connectedBy, installationId: row.config?.installationId, status: 'active' });

// Repositories associated with this project (the SourceConnection rows are the only source of truth).
// No GitHub call and no installation ids/tokens; `available` reflects whether the installation is still active.
router.get(
  '/projects/:id/github/repositories',
  requireAuth,
  attachProject(),
  requireRole('member'),
  async (req, res, next) => {
    try {
      const rows = await githubRows(req.project._id);
      const repositories = await Promise.all(
        rows.map(async (r) => ({
          id: r.config.repositoryId,
          owner: r.config.owner || String(r.config.fullName || '').split('/')[0] || null,
          name: r.config.repo || String(r.config.fullName || '').split('/')[1] || null,
          fullName: r.config.fullName,
          htmlUrl: r.config.htmlUrl || null,
          isPrivate: Boolean(r.config.isPrivate),
          available: Boolean(await installationActive(r)),
        }))
      );
      res.set('Cache-Control', 'no-store').json({ connected: repositories.length > 0, repositories });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/projects/:id/tasks',
  requireAuth,
  attachProject(),
  requireRole('member'),
  async (req, res, next) => {
    try {
      const body = createTaskSchema.parse(req.body);
      await assertAssigneeIsMember(req.project._id, body.assignee);

      // Resolve the GitHub target on the server from the project's own associations; never from client-supplied owner/name.
      const rows = await githubRows(req.project._id);
      let link = null;
      if (body.githubRepositoryId === undefined) {
        if (rows.length > 1) throw repositoryError(400, 'repository_required', 'This project has several GitHub repositories. Choose one, or choose not to create a GitHub issue.');
        if (rows.length === 1) [link] = rows;
      } else if (body.githubRepositoryId !== null) {
        link = rows.find((r) => r.config.repositoryId === body.githubRepositoryId) || null;
        if (!link) throw repositoryError(400, 'invalid_repository', 'That repository is not linked to this project.');
      }
      if (link && !(await installationActive(link))) {
        throw repositoryError(409, 'repository_unavailable', 'The GitHub installation for this repository was removed or suspended. Reconnect GitHub from Connections, or choose another repository.');
      }

      let task = await Task.create({
        projectId: req.project._id,
        title: body.title,
        description: body.description,
        origin: 'manual',
        assignee: body.assignee || null,
        deadline: body.deadline ? new Date(body.deadline) : null,
        priority: body.priority,
        createdBy: req.user._id,
        github: link
          ? { status: 'pending', connectionId: link._id, repositoryId: link.config.repositoryId, fullName: link.config.fullName, htmlUrl: link.config.htmlUrl || null }
          : rows.length === 0 ? { status: 'not_connected' } : undefined,
      });

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'TASK_CREATED',
        targetType: 'Task',
        targetId: task._id,
        payload: { title: task.title, priority: task.priority },
      });

      // The task is already saved; a GitHub failure is recorded on it and never undoes or duplicates it.
      if (link) task = (await syncTaskIssue(task._id)) || task;

      res.status(201).json({ task: serializeTask(task) });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      if (err.code === 'repository_required' || err.code === 'invalid_repository' || err.code === 'repository_unavailable') {
        return res.status(err.status).json({ error: err.code, message: err.message });
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

// Retry reuses the original task and its pinned repository; syncTaskIssue reconciles before creating.
router.post('/tasks/:id/github/retry', requireAuth, attachTaskProjectContext(), requireRole('member'), async (req, res, next) => {
  try {
    const task = await syncTaskIssue(req.task._id);
    res.json({ task: serializeTask(task) });
  } catch (err) {
    if (err instanceof TaskSyncError) return res.status(err.status).json({ error: err.code, message: err.message });
    next(err);
  }
});

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
