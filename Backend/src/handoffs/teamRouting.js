import { createHash } from 'node:crypto';
import { ProjectTeam } from '../models/ProjectTeam.js';
import { discoverableTeamFilter, linkLegacyTeams } from '../teams/legacy.js';
import { TeamMembership } from '../models/TeamMembership.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { Document } from '../models/Document.js';
import { Task } from '../models/Task.js';
import { Conflict } from '../models/Conflict.js';

export class RoutingError extends Error {
  constructor(message, status = 400, code = 'validation_error') {
    super(message);
    this.name = 'RoutingError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Resolves and validates where a handoff is going. The receiving team and the named recipient are
 * separate: the recipient must be an active member of the receiving team AND of the project.
 * Nothing here trusts client-supplied ownership; the sending team always comes from the project record.
 */
export async function resolveRouting(project, { toUserId, toTeamId, linkAs = null }) {
  if (!toTeamId) return { transferType: 'individual', fromTeamId: null, toTeamId: null };

  await linkLegacyTeams(project._id);
  let team = await ProjectTeam.findOne({ _id: toTeamId, projectIds: project._id });
  if (!team && linkAs) {
    // The sender picked a team they can see but that isn't on this project yet: add it, then route to it.
    const visible = await ProjectTeam.findOne({ _id: toTeamId, isActive: true, ...(await discoverableTeamFilter(linkAs)) });
    if (!visible) throw new RoutingError('The destination team does not exist or is not available to you');
    const onProject = await ProjectTeam.find({ projectIds: project._id, isActive: true }).select('name').lean();
    if (onProject.some((row) => row.name.trim().toLowerCase() === visible.name.trim().toLowerCase())) {
      throw new RoutingError(`A different team named “${visible.name}” is already on this project; rename one of them first`, 409, 'conflict');
    }
    team = visible;
    const teamMembers = await TeamMembership.find({ teamId: team._id, status: 'active' }).select('userId').lean();
    const eligible = Boolean(await ProjectMembership.exists({ projectId: project._id, userId: toUserId })) && teamMembers.some((row) => String(row.userId) === String(toUserId));
    if (!eligible) throw new RoutingError('The proposed recipient must belong to the team and be a member of this project');
    await ProjectTeam.updateOne({ _id: team._id }, { $addToSet: { projectIds: project._id } });
    return { ...(await resolveRouting(project, { toUserId, toTeamId })), linked: team.name };
  }
  if (!team) throw new RoutingError('The destination team does not exist in this project');
  if (!team.isActive) throw new RoutingError('The destination team is inactive', 409, 'conflict');

  const [teamMembership, projectMembership] = await Promise.all([
    TeamMembership.findOne({ teamId: team._id, userId: toUserId, status: 'active' }).lean(),
    ProjectMembership.findOne({ projectId: project._id, userId: toUserId }).lean(),
  ]);
  if (!projectMembership) throw new RoutingError('The proposed recipient is no longer a member of this project', 409, 'conflict');
  if (!teamMembership) throw new RoutingError('The proposed recipient is not an active member of the destination team');

  const fromTeamId = project.owningTeamId ? String(project.owningTeamId) : null;
  return {
    transferType: fromTeamId && fromTeamId === String(team._id) ? 'intra_team' : 'inter_team',
    fromTeamId,
    toTeamId: String(team._id),
  };
}

/** Selected documents must belong to the handoff's own project; anything else is rejected, never silently dropped. */
export async function assertDocumentsInProject(projectId, documentIds = []) {
  if (!documentIds.length) return;
  const unique = [...new Set(documentIds.map(String))];
  const count = await Document.countDocuments({ _id: { $in: unique }, projectId });
  if (count !== unique.length) throw new RoutingError('One or more selected documents do not belong to this project');
}

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Captures what the recipient is being asked to review. Stores references plus the generated context
 * (not copies of document bodies), and a content hash so the submitted version can always be identified.
 */
export async function buildContextSnapshot(project, handoff, validation) {
  const [tasks, documents, conflicts] = await Promise.all([
    Task.find({ projectId: project._id, status: 'open' }).select('title assignee deadline priority').lean(),
    Document.find({ _id: { $in: handoff.documentIds || [] }, projectId: project._id }).select('title filename contentHash updatedAt').lean(),
    Conflict.find({ projectId: project._id, status: 'open' }).select('title severity').lean(),
  ]);
  const body = {
    capturedAt: new Date().toISOString(),
    handoffVersion: handoff.version + 1,
    sender: { userId: String(handoff.fromUserId), teamId: handoff.fromTeamId ? String(handoff.fromTeamId) : null },
    recipient: { userId: String(handoff.toUserId), teamId: handoff.toTeamId ? String(handoff.toTeamId) : null },
    transferType: handoff.transferType,
    reason: handoff.reason || '',
    instructions: handoff.instructions || '',
    currentStatus: handoff.currentStatus || '',
    items: (handoff.items || []).map((item) => ({ type: item.type, text: item.text, relatedTaskId: item.relatedTaskId ? String(item.relatedTaskId) : null, sourceRecordId: item.sourceRecordId ? String(item.sourceRecordId) : null })),
    supportingLinks: handoff.supportingLinks || [],
    documents: documents.map((doc) => ({ id: String(doc._id), title: doc.title || doc.filename, contentHash: doc.contentHash || '' })),
    openTasks: tasks.map((task) => ({ id: String(task._id), title: task.title, assignee: task.assignee ? String(task.assignee) : null, deadline: task.deadline, priority: task.priority })),
    openConflicts: conflicts.map((conflict) => ({ id: String(conflict._id), title: conflict.title, severity: conflict.severity })),
    // AI-generated content is kept apart from user-entered fields and is only ever a draft the sender reviewed.
    aiGenerated: handoff.aiDraft ? { generatedAt: handoff.aiDraft.generatedAt || null, evidenceRefs: handoff.aiDraft.evidence || handoff.aiDraft.sources || null } : null,
    readiness: validation ? { score: validation.score, ready: validation.ready, missingFields: validation.missingFields } : null,
  };
  return { ...body, hash: sha(body) };
}

/** True when project data the recipient relies on changed after the snapshot was taken. */
export async function isContextStale(project, handoff) {
  const snapshot = handoff.contextSnapshot;
  if (!snapshot?.capturedAt) return false;
  const since = new Date(snapshot.capturedAt);
  const [task, doc, conflict] = await Promise.all([
    Task.exists({ projectId: project._id, updatedAt: { $gt: since } }),
    Document.exists({ projectId: project._id, updatedAt: { $gt: since } }),
    Conflict.exists({ projectId: project._id, updatedAt: { $gt: since } }),
  ]);
  return Boolean(task || doc || conflict);
}
