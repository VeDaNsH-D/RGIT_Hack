import { ProjectChatTurn } from '../models/ProjectChatTurn.js';
import { Router } from 'express';
import { z } from 'zod';
import { createProjectSchema, updateProjectSchema, addMemberSchema, sourceRecordQuerySchema } from '../contracts/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { Project } from '../models/Project.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { Task } from '../models/Task.js';
import { Document } from '../models/Document.js';
import { DocumentChunk } from '../models/DocumentChunk.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { Conflict } from '../models/Conflict.js';
import { Handoff } from '../models/Handoff.js';
import { User } from '../models/User.js';
import { purgeRepositoryKnowledge } from '../services/repositoryAnalysisService.js';
import { HandoffReport } from '../models/HandoffReport.js';
import { RepositorySnapshot } from '../models/RepositorySnapshot.js';
import { RepositoryFile } from '../models/RepositoryFile.js';
import { SyncError, syncConnection } from '../services/githubSyncEngine.js';
import { ACTIVITY_KINDS, listActivity, repositoryStats } from '../services/githubActivityService.js';
import { RepositoryError, linkRepository, resolveAccessibleRepository, serializeConnection } from '../services/githubRepositoryService.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { SlackConnection } from '../models/SlackConnection.js';
import { JiraConnection } from '../models/JiraConnection.js';
import { JIRA_KEY, serializeJiraLink, syncJiraLink } from '../services/jiraProjectSync.js';
import { SlackConnector } from '../modules/ingestion/providers/slack/slackConnector.js';
import { persistSourceRecordCandidates } from '../modules/ingestion/persistence/sourceRecordStore.js';
import { NotificationModel as Notification } from '../models/Notification.js';
import { ConflictEvidence } from '../models/ConflictEvidence.js';
import { EmailReview } from '../models/EmailReview.js';
import { createLocalDocumentStorage } from '../modules/ingestion/documents/index.js';
import { config } from '../config.js';
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
    // Validate the repository BEFORE creating anything, so a bad id never leaves a half-made project.
    const requestedRepo = body.integrations?.github
      ? await resolveAccessibleRepository(String(req.user._id), body.integrations.github.repositoryId)
      : null;
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
    // Association failure after creation is reported, never hidden: the project exists, and the
    // client can retry via POST /:id/integrations/github.
    let integrations;
    if (requestedRepo) {
      try {
        integrations = { github: { status: 'connected', ...(await linkRepository({ projectId: project._id, userId: req.user._id, repository: requestedRepo })) } };
      } catch {
        integrations = { github: { status: 'failed', error: 'association_failed' } };
      }
    }
    res.status(201).json({ project: serializeProject(project), ...(integrations ? { integrations } : {}) });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    if (err instanceof RepositoryError) return res.status(err.status).json({ error: err.code, message: err.message });
    next(err);
  }
});

router.get('/:id/integrations', requireAuth, attachProject(), requireRole('viewer'), async (req, res, next) => {
  try {
    const rows = await SourceConnection.find({ projectId: req.project._id, provider: 'github' }).sort({ createdAt: 1 }).lean();
    const stats = await repositoryStats(req.project._id, rows.map((r) => r.config?.repositoryId).filter(Number.isSafeInteger));
    const slackRows = await SourceConnection.find({ projectId: req.project._id, provider: 'slack' }).sort({ createdAt: 1 }).lean();
    const jiraRows = await SourceConnection.find({ projectId: req.project._id, provider: 'jira' }).sort({ createdAt: 1 }).lean();
    const notionRows = await SourceConnection.find({ projectId: req.project._id, provider: 'notion' }).sort({ createdAt: 1 }).lean();
    res.json({
      integrations: {
        github: rows.map((r) => serializeConnection(r, stats.get(r.config?.repositoryId))),
        jira: jiraRows.map(serializeJiraLink),
        slack: slackRows.map((r) => ({
          id: String(r._id),
          channelId: r.config?.channelId,
          channelName: r.config?.channelName,
          teamDomain: r.config?.teamDomain,
          teamName: r.config?.teamName,
          sync: r.config?.sync || { status: 'pending' },
          createdAt: r.createdAt,
        })),
        notion: notionRows.map((r) => ({
          id: String(r._id),
          pageId: r.config?.pageId,
          title: r.config?.title || 'Notion page',
          url: r.config?.url,
          sync: r.config?.sync || {
            status: r.config?.syncedAt ? 'completed' : 'pending',
            lastSuccessAt: r.config?.syncedAt,
            remainingCount: r.config?.sync?.remainingCount ?? 0,
            completedCount: r.config?.sync?.completedCount ?? 0,
            totalCount: r.config?.sync?.totalCount ?? 0,
            remainingItems: r.config?.sync?.remainingItems || [],
            completedItems: r.config?.sync?.completedItems || [],
          },
          createdAt: r.createdAt,
        })),
      },
    });
  } catch (err) { next(err); }
});

/** Runs a real synchronization now. Members and owners may trigger it; viewers may not. */
router.post('/:id/integrations/github/:connectionId/sync', requireAuth, attachProject(), requireRole('member'), async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.connectionId)) return res.status(400).json({ error: 'validation_error', message: 'Invalid connection id' });
    const owned = await SourceConnection.exists({ _id: req.params.connectionId, projectId: req.project._id, provider: 'github' });
    if (!owned) return res.status(404).json({ error: 'not_found', message: 'Repository connection not found' });
    const doc = await syncConnection(req.params.connectionId);
    const stats = await repositoryStats(req.project._id, [doc.config?.repositoryId].filter(Number.isSafeInteger));
    res.json({ integration: { github: serializeConnection(doc, stats.get(doc.config?.repositoryId)) } });
  } catch (err) {
    if (err instanceof SyncError) return res.status(err.status).json({ error: err.code, message: err.message });
    next(err);
  }
});

router.get('/:id/github/activity', requireAuth, attachProject(), requireRole('viewer'), async (req, res, next) => {
  try {
    const one = (v) => (typeof v === 'string' ? v : undefined);
    const kind = one(req.query.kind) || 'issues';
    if (!ACTIVITY_KINDS.includes(kind)) return res.status(400).json({ error: 'validation_error', message: `kind must be one of ${ACTIVITY_KINDS.join(', ')}` });
    const state = one(req.query.state) || 'open';
    if (!['open', 'closed', 'all'].includes(state)) return res.status(400).json({ error: 'validation_error', message: 'state must be open, closed or all' });
    const page = Math.min(Math.max(parseInt(one(req.query.page), 10) || 1, 1), 500);
    const limit = Math.min(Math.max(parseInt(one(req.query.limit), 10) || 20, 1), 50);
    const repositoryId = one(req.query.repositoryId) ? Number(req.query.repositoryId) : undefined;
    if (repositoryId !== undefined && !Number.isSafeInteger(repositoryId)) return res.status(400).json({ error: 'validation_error', message: 'Invalid repositoryId' });
    res.json(await listActivity(req.project._id, { kind, state, page, limit, repositoryId }));
  } catch (err) { next(err); }
});

/** Removes only the association row. The project and any SourceRecords already ingested are untouched. */
router.delete('/:id/integrations/github/:connectionId', requireAuth, attachProject(), requireRole('owner'), async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.connectionId)) return res.status(400).json({ error: 'validation_error', message: 'Invalid connection id' });
    const removed = await SourceConnection.findOneAndDelete({ _id: req.params.connectionId, projectId: req.project._id, provider: 'github' }).lean();
    if (!removed) return res.status(404).json({ error: 'not_found', message: 'Repository connection not found' });
    // Stored repository content and snapshots go with the association; ingested activity records are kept.
    await purgeRepositoryKnowledge({ projectId: req.project._id, repositoryId: removed.config?.repositoryId, connectionId: removed._id });
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'PROJECT_UPDATED', targetType: 'Project', targetId: req.project._id, payload: { githubRepositoryRemoved: removed.config?.fullName } });
    res.json({ removed: true });
  } catch (err) { next(err); }
});

router.post('/:id/integrations/github', requireAuth, attachProject(), requireRole('owner'), async (req, res, next) => {
  try {
    const { repositoryId } = z.object({ repositoryId: z.number().int().positive() }).strict().parse(req.body);
    const repository = await resolveAccessibleRepository(String(req.user._id), repositoryId);
    const connection = await linkRepository({ projectId: req.project._id, userId: req.user._id, repository });
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'PROJECT_UPDATED', targetType: 'Project', targetId: req.project._id, payload: { githubRepository: connection.repository.fullName } });
    res.status(201).json({ integration: { github: connection } });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'validation_error', message: err.message });
    if (err instanceof RepositoryError) return res.status(err.status).json({ error: err.code, message: err.message });
    next(err);
  }
});

router.post('/:id/integrations/slack', requireAuth, attachProject(), requireRole('owner'), async (req, res, next) => {
  try {
    const { channelId, channelName } = req.body || {};
    if (!channelId || typeof channelId !== 'string') {
      return res.status(400).json({ error: 'validation_error', message: 'channelId is required' });
    }
    const slackConn = await SlackConnection.findOne({ userId: req.user._id, active: true });
    if (!slackConn) {
      return res.status(400).json({ error: 'not_connected', message: 'Slack workspace is not connected. Connect Slack in Connections first.' });
    }

    let connection = await SourceConnection.findOne({ projectId: req.project._id, provider: 'slack', 'config.channelId': channelId });
    if (!connection) {
      connection = new SourceConnection({
        projectId: req.project._id,
        provider: 'slack',
        connectedBy: req.user._id,
        config: {
          channelId,
          channelName: channelName || channelId,
          teamDomain: slackConn.teamDomain,
          teamName: slackConn.teamName,
          sync: { status: 'syncing' },
        },
      });
    } else {
      connection.config = {
        ...connection.config,
        channelName: channelName || connection.config?.channelName || channelId,
        teamDomain: slackConn.teamDomain,
        teamName: slackConn.teamName,
        sync: { status: 'syncing' },
      };
    }
    await connection.save();

    let syncedCount = 0;
    try {
      const connector = new SlackConnector({
        token: slackConn.botToken,
        teamDomain: slackConn.teamDomain,
      });
      const result = await connector.sync({
        channelId,
        projectId: String(req.project._id),
        maxPages: 3,
        perPage: 50,
        includeThreads: true,
        asCandidate: true,
      });
      if (result.records?.length) {
        await persistSourceRecordCandidates({
          projectId: String(req.project._id),
          records: result.records,
        });
        syncedCount = result.records.length;
      }
      const firstErr = result.errors?.[0]?.message || result.errors?.[0]?.error;
      const notInChannel = firstErr && (firstErr.includes('not_in_channel') || firstErr.includes('access_denied'));

      if (notInChannel) {
        connection.config.sync = {
          status: 'partial',
          error: `Bot is not in #${channelName || connection.config.channelName}. Invite the bot by typing /invite @Over2u in the Slack channel.`,
          syncedMessageCount: 0,
        };
      } else if (result.errors?.length && !syncedCount) {
        connection.config.sync = {
          status: 'failed',
          error: firstErr || 'Failed to read channel messages.',
          syncedMessageCount: 0,
        };
      } else {
        connection.config.sync = {
          status: result.errors?.length ? 'partial' : 'completed',
          lastSuccessAt: new Date(),
          syncedMessageCount: syncedCount,
          ...(result.errors?.length ? { error: firstErr } : {}),
        };
      }
    } catch (syncErr) {
      connection.config.sync = {
        status: 'partial',
        error: syncErr.message,
        syncedMessageCount: syncedCount,
      };
    }
    connection.markModified('config');
    await connection.save();

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'PROJECT_UPDATED',
      targetType: 'Project',
      targetId: req.project._id,
      payload: { slackChannel: channelName || channelId, syncedCount },
    });

    res.status(201).json({
      integration: {
        slack: {
          id: String(connection._id),
          channelId: connection.config.channelId,
          channelName: connection.config.channelName,
          teamDomain: connection.config.teamDomain,
          teamName: connection.config.teamName,
          sync: connection.config.sync,
          createdAt: connection.createdAt,
        },
      },
    });
  } catch (err) { next(err); }
});

/** Links one Jira project key to this Relay project (owner) using the owner's own Jira connection, then syncs it. */
router.post('/:id/integrations/jira', requireAuth, attachProject(), requireRole('owner'), async (req, res, next) => {
  try {
    const projectKey = String(req.body?.projectKey || '').trim().toUpperCase();
    if (!JIRA_KEY.test(projectKey)) return res.status(400).json({ error: 'validation_error', message: 'Enter a Jira project key such as PROJ.' });
    const jiraConn = await JiraConnection.findOne({ userId: req.user._id, active: true });
    if (!jiraConn) return res.status(400).json({ error: 'not_connected', message: 'Jira is not connected. Connect Jira in Connections first.' });
    let link = await SourceConnection.findOne({ projectId: req.project._id, provider: 'jira', 'config.projectKey': projectKey });
    if (!link) link = new SourceConnection({ projectId: req.project._id, provider: 'jira', connectedBy: req.user._id, config: { projectKey, sync: { status: 'syncing' } } });
    else link.connectedBy = req.user._id;
    await link.save();
    await syncJiraLink(link);
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'PROJECT_UPDATED', targetType: 'Project', targetId: req.project._id, payload: { jiraProject: projectKey } });
    res.status(201).json({ integration: { jira: serializeJiraLink(link) } });
  } catch (err) { next(err); }
});

router.post('/:id/integrations/jira/:connectionId/sync', requireAuth, attachProject(), requireRole('member'), async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.connectionId)) return res.status(400).json({ error: 'validation_error', message: 'Invalid connection id' });
    const link = await SourceConnection.findOne({ _id: req.params.connectionId, projectId: req.project._id, provider: 'jira' });
    if (!link) return res.status(404).json({ error: 'not_found', message: 'Jira connection not found' });
    await syncJiraLink(link);
    res.json({ integration: { jira: serializeJiraLink(link) } });
  } catch (err) { next(err); }
});

router.delete('/:id/integrations/jira/:connectionId', requireAuth, attachProject(), requireRole('owner'), async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.connectionId)) return res.status(400).json({ error: 'validation_error', message: 'Invalid connection id' });
    const removed = await SourceConnection.findOneAndDelete({ _id: req.params.connectionId, projectId: req.project._id, provider: 'jira' }).lean();
    if (!removed) return res.status(404).json({ error: 'not_found', message: 'Jira connection not found' });
    // Issues of the unlinked Jira project stop feeding this project's handoffs.
    await SourceRecord.deleteMany({ projectId: req.project._id, provider: 'jira', externalId: { $regex: `^${removed.config.projectKey}-\\d+$` } });
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'PROJECT_UPDATED', targetType: 'Project', targetId: req.project._id, payload: { jiraProjectRemoved: removed.config?.projectKey } });
    res.json({ removed: true });
  } catch (err) { next(err); }
});

router.post('/:id/integrations/slack/:connectionId/sync', requireAuth, attachProject(), requireRole('member'), async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.connectionId)) return res.status(400).json({ error: 'validation_error', message: 'Invalid connection id' });
    const connection = await SourceConnection.findOne({ _id: req.params.connectionId, projectId: req.project._id, provider: 'slack' });
    if (!connection) return res.status(404).json({ error: 'not_found', message: 'Slack connection not found' });
    const slackConn = await SlackConnection.findOne({ userId: req.user._id, active: true });
    if (!slackConn) return res.status(400).json({ error: 'not_connected', message: 'Slack workspace is not connected.' });

    connection.config.sync = { ...connection.config.sync, status: 'syncing' };
    connection.markModified('config');
    await connection.save();

    let syncedCount = 0;
    try {
      const connector = new SlackConnector({
        token: slackConn.botToken,
        teamDomain: slackConn.teamDomain,
      });
      const result = await connector.sync({
        channelId: connection.config.channelId,
        projectId: String(req.project._id),
        maxPages: 3,
        perPage: 50,
        includeThreads: true,
        asCandidate: true,
      });
      if (result.records?.length) {
        await persistSourceRecordCandidates({
          projectId: String(req.project._id),
          records: result.records,
        });
        syncedCount = result.records.length;
      }
      const firstErr = result.errors?.[0]?.message || result.errors?.[0]?.error;
      const notInChannel = firstErr && (firstErr.includes('not_in_channel') || firstErr.includes('access_denied'));

      if (notInChannel) {
        connection.config.sync = {
          status: 'partial',
          error: `Bot is not in #${connection.config.channelName}. Invite the bot by typing /invite @Over2u in the Slack channel.`,
          syncedMessageCount: connection.config.sync?.syncedMessageCount || 0,
        };
      } else if (result.errors?.length && !syncedCount) {
        connection.config.sync = {
          status: 'failed',
          error: firstErr || 'Failed to read channel messages.',
          syncedMessageCount: connection.config.sync?.syncedMessageCount || 0,
        };
      } else {
        connection.config.sync = {
          status: result.errors?.length ? 'partial' : 'completed',
          lastSuccessAt: new Date(),
          syncedMessageCount: syncedCount,
          ...(result.errors?.length ? { error: firstErr } : {}),
        };
      }
    } catch (syncErr) {
      connection.config.sync = {
        status: 'partial',
        error: syncErr.message,
        syncedMessageCount: connection.config.sync?.syncedMessageCount || 0,
      };
    }
    connection.markModified('config');
    await connection.save();

    res.json({
      integration: {
        slack: {
          id: String(connection._id),
          channelId: connection.config.channelId,
          channelName: connection.config.channelName,
          teamDomain: connection.config.teamDomain,
          teamName: connection.config.teamName,
          sync: connection.config.sync,
          createdAt: connection.createdAt,
        },
      },
    });
  } catch (err) { next(err); }
});

router.delete('/:id/integrations/slack/:connectionId', requireAuth, attachProject(), requireRole('owner'), async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.connectionId)) return res.status(400).json({ error: 'validation_error', message: 'Invalid connection id' });
    const removed = await SourceConnection.findOneAndDelete({ _id: req.params.connectionId, projectId: req.project._id, provider: 'slack' }).lean();
    if (!removed) return res.status(404).json({ error: 'not_found', message: 'Slack connection not found' });
    await SourceRecord.deleteMany({ projectId: req.project._id, provider: 'slack', 'metadata.providerMetadata.channelId': removed.config?.channelId });
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'PROJECT_UPDATED', targetType: 'Project', targetId: req.project._id, payload: { slackChannelRemoved: removed.config?.channelName || removed.config?.channelId } });
    res.json({ removed: true });
  } catch (err) { next(err); }
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

/**
 * Owner-only permanent delete. MongoDB transactions aren't assumed, so children go first and the
 * project last: a failure part-way leaves the project in place and the call can simply be retried.
 * The append-only audit log (ActivityEvent) is intentionally kept.
 */
router.delete('/:id', requireAuth, attachProject(), requireRole('owner'), async (req, res, next) => {
  try {
    const projectId = req.project._id;
    const documents = await Document.find({ projectId }).select('storageRef').lean();
    await Promise.all([
      ProjectChatTurn.deleteMany({ projectId }), Task.deleteMany({ projectId }), Handoff.deleteMany({ projectId }), Conflict.deleteMany({ projectId }),
      ConflictEvidence.deleteMany({ projectId }), SourceRecord.deleteMany({ projectId }), SourceConnection.deleteMany({ projectId }),
      Document.deleteMany({ projectId }), DocumentChunk.deleteMany({ projectId }), EmailReview.deleteMany({ projectId }), Notification.deleteMany({ projectId }),
      RepositorySnapshot.deleteMany({ projectId }), RepositoryFile.deleteMany({ projectId }), HandoffReport.deleteMany({ projectId }),
    ]);
    await ProjectMembership.deleteMany({ projectId });
    await Project.deleteOne({ _id: projectId });
    // Best-effort cleanup of uploaded files; the records are already gone.
    const storage = createLocalDocumentStorage(config.documents.storageDir ? { rootDir: config.documents.storageDir } : {});
    await Promise.allSettled(documents.map((d) => (d.storageRef?.key ? storage.delete(d.storageRef.key) : null)));
    await logActivity({ projectId, actorId: req.user._id, action: 'PROJECT_DELETED', targetType: 'Project', targetId: projectId, payload: { name: req.project.name } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
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
