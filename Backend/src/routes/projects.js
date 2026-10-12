import { Router } from 'express';
import { createProjectSchema, updateProjectSchema, addMemberSchema, sourceRecordQuerySchema } from '../contracts/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { Project } from '../models/Project.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { Task } from '../models/Task.js';
import { Document } from '../models/Document.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { Conflict } from '../models/Conflict.js';
import { Handoff } from '../models/Handoff.js';
import { User } from '../models/User.js';
import { logActivity } from '../audit/service.js';

const router = Router();

/**
 * NOTE: this file currently covers only what the notes/context features
 * (and their tests) need: create/list projects, add a member, and the
 * aggregated context view. GET/PATCH /:id, ownership-history, and the
 * full task/source-record/document endpoints described in the original
 * Step 7 plan are not built yet and belong to that step.
 */

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = createProjectSchema.parse(req.body);
    const project = await Project.create({
      name: body.name,
      description: body.description,
      ownerId: req.user._id,
      createdBy: req.user._id,
    });
    await ProjectMembership.create({
      projectId: project._id,
      userId: req.user._id,
      role: 'owner',
      invitedBy: req.user._id,
    });
    await logActivity({
      projectId: project._id,
      actorId: req.user._id,
      action: 'PROJECT_CREATED',
      targetType: 'Project',
      targetId: project._id,
      payload: { name: project.name },
    });
    res.status(201).json({ project: serializeProject(project) });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    next(err);
  }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const memberships = await ProjectMembership.find({ userId: req.user._id }).lean();
    const projectIds = memberships.map((m) => m.projectId);
    const projects = await Project.find({ _id: { $in: projectIds } }).lean();
    const roleByProjectId = new Map(memberships.map((m) => [String(m.projectId), m.role]));
    res.json({
      projects: projects.map((p) => ({ ...serializeProject(p), myRole: roleByProjectId.get(String(p._id)) })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, attachProject(), requireRole('viewer'), (req, res) => {
  res.json({ project: serializeProject(req.project) });
});

router.patch('/:id', requireAuth, attachProject(), requireRole('owner'), async (req, res, next) => {
  try {
    const body = updateProjectSchema.parse(req.body);
    if (body.name !== undefined) req.project.name = body.name;
    if (body.description !== undefined) req.project.description = body.description;
    await req.project.save();

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'PROJECT_UPDATED',
      targetType: 'Project',
      targetId: req.project._id,
      payload: body,
    });

    res.json({ project: serializeProject(req.project) });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    next(err);
  }
});

router.get('/:id/ownership-history', requireAuth, attachProject(), requireRole('viewer'), async (req, res, next) => {
  try {
    const userIds = new Set();
    for (const entry of req.project.ownershipHistory) {
      userIds.add(String(entry.fromUserId));
      userIds.add(String(entry.toUserId));
    }
    const users = await User.find({ _id: { $in: [...userIds] } }).select('name email').lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    res.json({
      ownershipHistory: req.project.ownershipHistory.map((entry) => ({
        fromUser: userById.get(String(entry.fromUserId)) ? { id: String(entry.fromUserId), name: userById.get(String(entry.fromUserId)).name, email: userById.get(String(entry.fromUserId)).email } : { id: String(entry.fromUserId) },
        toUser: userById.get(String(entry.toUserId)) ? { id: String(entry.toUserId), name: userById.get(String(entry.toUserId)).name, email: userById.get(String(entry.toUserId)).email } : { id: String(entry.toUserId) },
        handoffId: String(entry.handoffId),
        changedAt: entry.changedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:id/source-records',
  requireAuth,
  attachProject(),
  requireRole('member'),
  async (req, res, next) => {
    try {
      const query = sourceRecordQuerySchema.parse(req.query);
      const filter = { projectId: req.project._id };
      if (query.provider) filter.provider = query.provider;
      if (query.type) filter.type = query.type;

      const skip = (query.page - 1) * query.limit;
      const [items, total] = await Promise.all([
        SourceRecord.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
        SourceRecord.countDocuments(filter),
      ]);

      res.json({
        sourceRecords: items.map((r) => ({
          id: String(r._id),
          provider: r.provider,
          externalId: r.externalId,
          type: r.type,
          title: r.title,
          url: r.url,
          content: r.content,
          metadata: r.metadata,
          isDemo: Boolean(r.isDemo),
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
        total,
        page: query.page,
        limit: query.limit,
      });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

router.post('/:id/members', requireAuth, attachProject(), requireRole('owner'), async (req, res, next) => {
  try {
    const body = addMemberSchema.parse(req.body);
    const user = await User.findOne({ email: body.email });
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'No user with that email' });
    }
    const membership = await ProjectMembership.findOneAndUpdate(
      { projectId: req.project._id, userId: user._id },
      { $set: { role: body.role }, $setOnInsert: { invitedBy: req.user._id } },
      { upsert: true, new: true }
    );
    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'MEMBER_ADDED',
      targetType: 'User',
      targetId: user._id,
      payload: { email: body.email, role: body.role },
    });
    res.status(201).json({ membership: { userId: String(user._id), role: membership.role } });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    next(err);
  }
});

router.get('/:id/context', requireAuth, attachProject(), requireRole('viewer'), async (req, res, next) => {
  try {
    const projectId = req.project._id;

    const [members, tasks, documents, sourceRecords, openConflicts, activeHandoff, decisions, notes] =
      await Promise.all([
        ProjectMembership.find({ projectId }).populate('userId', 'name email').lean(),
        Task.find({ projectId }).lean(),
        Document.find({ projectId }).select('-extractedText -storageRef').lean(),
        SourceRecord.find({ projectId, provider: { $ne: 'manual' } }).select('-content').lean(),
        Conflict.find({ projectId, status: 'open' }).lean(),
        Handoff.findOne({ projectId, isOpen: true }).lean(),
        SourceRecord.find({ projectId, provider: 'manual', type: 'decision' })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean(),
        SourceRecord.find({ projectId, provider: 'manual', type: 'note' })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean(),
      ]);

    const now = new Date();

    res.json({
      project: serializeProject(req.project),
      members: members
        .filter((m) => m.userId)
        .map((m) => ({ userId: String(m.userId._id), name: m.userId.name, email: m.userId.email, role: m.role })),
      tasks: tasks.map((t) => ({
        id: String(t._id),
        title: t.title,
        status: t.status,
        priority: t.priority,
        assignee: t.assignee ? String(t.assignee) : null,
        deadline: t.deadline,
        overdue: t.status === 'open' && Boolean(t.deadline) && new Date(t.deadline) < now,
        origin: t.origin,
      })),
      documents: documents.map((d) => ({
        id: String(d._id),
        title: d.title,
        filename: d.filename,
        mimeType: d.mimeType,
        size: d.size,
        uploadedBy: String(d.uploadedBy),
        createdAt: d.createdAt,
      })),
      sourceRecords: sourceRecords.map((r) => ({
        id: String(r._id),
        provider: r.provider,
        type: r.type,
        title: r.title,
        url: r.url,
        createdAt: r.createdAt,
      })),
      openConflicts: openConflicts.map((c) => ({
        id: String(c._id),
        title: c.title,
        severity: c.severity,
        status: c.status,
      })),
      activeHandoff: activeHandoff
        ? {
            id: String(activeHandoff._id),
            state: activeHandoff.state,
            fromUserId: String(activeHandoff.fromUserId),
            toUserId: String(activeHandoff.toUserId),
          }
        : null,
      decisions: decisions.map(serializeDecisionOrNote(true)),
      notes: notes.map(serializeDecisionOrNote(false)),
      counts: {
        tasks: tasks.length,
        documents: documents.length,
        openConflicts: openConflicts.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

function serializeDecisionOrNote(includeContent) {
  return (record) => ({
    id: String(record._id),
    title: record.title,
    ...(includeContent ? { content: record.content } : {}),
    author: record.metadata?.author || null,
    observedAt: record.metadata?.observedAt || null,
    createdAt: record.createdAt,
  });
}

function serializeProject(project) {
  return {
    id: String(project._id),
    name: project.name,
    description: project.description,
    ownerId: String(project.ownerId),
    isDemo: Boolean(project.isDemo),
  };
}

export default router;
