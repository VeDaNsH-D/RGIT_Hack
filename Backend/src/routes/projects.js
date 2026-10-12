import { Router } from 'express';
import { createProjectSchema, addMemberSchema } from '../contracts/schemas.js';
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
import { generateContextPack, generateProjectBrief, AiServiceError } from '../services/aiClient.js';
import { buildProjectContextPack } from '../services/contextBuilder.js';
import { detectProjectConflicts } from '../services/conflictDetector.js';
import { projectBriefSchema, conflictDetectionResultSchema } from '../contracts/schemas.js';

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

/**
 * Route handler for POST /api/projects/:id/ai/generate-context.
 * Extracts complete project context including document and source text,
 * maps it to ContextPackRequest, and invokes the AI Context Intelligence service.
 */
export async function handleGenerateContext(req, res, next) {
  try {
    const contextPack = await buildProjectContextPack(req.project._id, {
      project: req.project,
      tasks: req.tasks,
      documents: req.documents,
      sourceRecords: req.sourceRecords,
    });

    const aiResponse = await generateContextPack(contextPack);

    res.status(200).json(aiResponse);
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(err.status || 502).json({
        error: err.code || 'ai_service_error',
        message: err.message,
      });
    }
    next(err);
  }
}

router.post(
  '/:id/ai/generate-context',
  requireAuth,
  attachProject(),
  requireRole('viewer'),
  handleGenerateContext
);

/**
 * Route handler for generating a structured Project Brief ("Understand This Project").
 */
export async function handleGenerateProjectBrief(req, res, next) {
  try {
    const contextPack = await buildProjectContextPack(req.project._id, {
      project: req.project,
      tasks: req.tasks,
      documents: req.documents,
      sourceRecords: req.sourceRecords,
    });

    const aiBrief = await generateProjectBrief(contextPack);

    // Normalize snake_case keys to camelCase matching projectBriefSchema
    const normalized = {
      projectId: String(aiBrief.project_id || aiBrief.projectId || req.project._id),
      projectName: String(aiBrief.project_name || aiBrief.projectName || req.project.name),
      projectOverview: String(aiBrief.project_overview || aiBrief.projectOverview || ''),
      technologyStack: Array.isArray(aiBrief.technology_stack || aiBrief.technologyStack)
        ? (aiBrief.technology_stack || aiBrief.technologyStack)
        : [],
      currentStatus: String(aiBrief.current_status || aiBrief.currentStatus || 'Active'),
      completedWork: Array.isArray(aiBrief.completed_work || aiBrief.completedWork)
        ? (aiBrief.completed_work || aiBrief.completedWork)
        : [],
      pendingActions: Array.isArray(aiBrief.pending_actions || aiBrief.pendingActions)
        ? (aiBrief.pending_actions || aiBrief.pendingActions)
        : [],
      blockers: Array.isArray(aiBrief.blockers) ? aiBrief.blockers : [],
      recommendedNextSteps: Array.isArray(aiBrief.recommended_next_steps || aiBrief.recommendedNextSteps)
        ? (aiBrief.recommended_next_steps || aiBrief.recommendedNextSteps)
        : [],
      missingInformation: Array.isArray(aiBrief.missing_information || aiBrief.missingInformation)
        ? (aiBrief.missing_information || aiBrief.missingInformation).map((m) => ({
            topic: m.topic || 'Unspecified',
            explanation: m.explanation || '',
            impact: m.impact || null,
            ...(Array.isArray(m.source_ids || m.sourceIds) ? { sourceIds: m.source_ids || m.sourceIds } : {}),
          }))
        : [],
      evidenceReferences: Array.isArray(aiBrief.evidence_references || aiBrief.evidenceReferences)
        ? (aiBrief.evidence_references || aiBrief.evidenceReferences)
        : [],
      generatedAt: (() => {
        const rawDate = aiBrief.generated_at || aiBrief.generatedAt;
        if (!rawDate) return new Date().toISOString();
        try {
          return new Date(rawDate).toISOString();
        } catch {
          return new Date().toISOString();
        }
      })(),
    };

    const validated = projectBriefSchema.parse(normalized);
    res.status(200).json(validated);
  } catch (err) {
    if (err instanceof AiServiceError) {
      return res.status(err.status || 502).json({
        error: err.code || 'ai_service_error',
        message: err.message,
      });
    }
    if (err.name === 'ZodError') {
      return res.status(502).json({
        error: 'invalid_brief_schema',
        message: `Project brief failed contract validation: ${err.message}`,
      });
    }
    next(err);
  }
}

router.post(
  '/:id/ai/brief',
  requireAuth,
  attachProject(),
  requireRole('viewer'),
  handleGenerateProjectBrief
);

router.get(
  '/:id/ai/brief',
  requireAuth,
  attachProject(),
  requireRole('viewer'),
  handleGenerateProjectBrief
);

/**
 * Route handler for deterministic conflict detection on project records.
 */
export async function handleDetectConflicts(req, res, next) {
  try {
    let tasks = req.tasks;
    let documents = req.documents;
    let sourceRecords = req.sourceRecords;

    if (!tasks || !documents || !sourceRecords) {
      const [fetchedTasks, fetchedDocuments, fetchedSourceRecords] = await Promise.all([
        tasks ? tasks : Task.find({ projectId: req.project._id }).lean(),
        documents ? documents : Document.find({ projectId: req.project._id }).select('+extractedText').lean(),
        sourceRecords ? sourceRecords : SourceRecord.find({ projectId: req.project._id }).lean(),
      ]);
      tasks = fetchedTasks;
      documents = fetchedDocuments;
      sourceRecords = fetchedSourceRecords;
    }

    const result = detectProjectConflicts({
      projectId: req.project._id,
      tasks,
      documents,
      sourceRecords,
    });

    const validated = conflictDetectionResultSchema.parse(result);
    res.status(200).json(validated);
  } catch (err) {
    next(err);
  }
}

router.post(
  '/:id/conflicts/detect',
  requireAuth,
  attachProject(),
  requireRole('viewer'),
  handleDetectConflicts
);

router.get(
  '/:id/conflicts/candidates',
  requireAuth,
  attachProject(),
  requireRole('viewer'),
  handleDetectConflicts
);

export default router;
