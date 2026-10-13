import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import {
  createTeamSchema,
  updateTeamSchema,
  addTeamMemberSchema,
  updateTeamMemberSchema,
  linkTeamSchema,
  teamSearchQuerySchema,
  objectId,
} from '../contracts/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { ProjectTeam } from '../models/ProjectTeam.js';
import { TeamMembership } from '../models/TeamMembership.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { Project } from '../models/Project.js';
import { Handoff } from '../models/Handoff.js';
import { Task } from '../models/Task.js';
import { User } from '../models/User.js';
import { withTx } from '../db.js';
import { logActivity } from '../audit/service.js';
import { discoverableTeamFilter, linkLegacyTeams } from '../teams/legacy.js';
import { HANDOFF_OPEN_STATES } from '../constants.js';

const router = Router();
const projectViewer = [requireAuth, attachProject(), requireRole('viewer')];
const projectOwner = [requireAuth, attachProject(), requireRole('owner')];

const fail = (res, status, error, message) => res.status(status).json({ error, message });
const isId = (value) => mongoose.isValidObjectId(value);
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A team can serve many projects, so every lookup is scoped to the project in the URL: an unlinked team is simply "not found". */
async function loadTeam(req, res) {
  if (!isId(req.params.teamId)) { fail(res, 404, 'not_found', 'Team not found'); return null; }
  await linkLegacyTeams(req.project._id);
  const team = await ProjectTeam.findOne({ _id: req.params.teamId, projectIds: req.project._id });
  if (!team) { fail(res, 404, 'not_found', 'Team not found'); return null; }
  return team;
}

async function activeTeamRole(teamId, userId) {
  const membership = await TeamMembership.findOne({ teamId, userId, status: 'active' }).lean();
  return membership?.role || null;
}

/**
 * Team administration. Because a team can be shared, one project's owner must not be able to rewrite a team that other
 * projects depend on: admins are the team's creator, or the project owner when the team belongs to this project alone.
 */
function isTeamAdmin(req, team) {
  if (String(team.createdBy) === String(req.user._id)) return true;
  return req.membership.role === 'owner' && team.projectIds.length <= 1;
}
async function canManageRoster(req, team) {
  return isTeamAdmin(req, team) || (await activeTeamRole(team._id, req.user._id)) === 'leader';
}

/** Members must already be on the project the team is being edited from; leaders must be able to act (not viewers). */
async function assertProjectMembers(projectId, userIds, { leaderId = null } = {}) {
  const ids = [...new Set(userIds.map(String))];
  const rows = await ProjectMembership.find({ projectId, userId: { $in: ids } }).lean();
  const byUser = new Map(rows.map((row) => [String(row.userId), row]));
  for (const id of ids) {
    const row = byUser.get(id);
    if (!row) return `User ${id} is not a member of this project`;
    if (leaderId && id === String(leaderId) && row.role === 'viewer') return 'A viewer cannot lead a team';
  }
  return null;
}

async function linkedTeams(projectId) {
  await linkLegacyTeams(projectId);
  return ProjectTeam.find({ projectIds: projectId });
}

/** "Team 1", "Team 2", ... the lowest number not already used by an active team on this project. */
async function defaultTeamName(projectId) {
  const names = (await linkedTeams(projectId)).filter((team) => team.isActive).map((team) => team.name.toLowerCase());
  let n = names.length + 1;
  while (names.includes(`team ${n}`)) n += 1;
  return `Team ${n}`;
}

async function nameTaken(projectId, name, exceptId = null) {
  return (await linkedTeams(projectId)).some((team) => team.isActive && String(team._id) !== String(exceptId) && sameName(team.name, name));
}

async function serializeTeams(project, teams) {
  const teamIds = teams.map((team) => team._id);
  const [memberships, handoffs] = await Promise.all([
    TeamMembership.find({ teamId: { $in: teamIds }, status: 'active' }).lean(),
    Handoff.find({ projectId: project._id, $or: [{ fromTeamId: { $in: teamIds } }, { toTeamId: { $in: teamIds } }] }).select('fromTeamId toTeamId state').lean(),
  ]);
  const userIds = [...new Set(memberships.map((m) => String(m.userId)))];
  const [users, projectRows] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('name email').lean(),
    ProjectMembership.find({ projectId: project._id, userId: { $in: userIds } }).select('userId').lean(),
  ]);
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  const onProject = new Set(projectRows.map((row) => String(row.userId)));
  return teams.map((team) => {
    const members = memberships.filter((m) => String(m.teamId) === String(team._id)).map((m) => {
      const here = onProject.has(String(m.userId));
      return {
        userId: String(m.userId),
        name: userMap.get(String(m.userId))?.name || 'Unknown',
        // People who belong to the team but not to this project show a name only, never contact details.
        email: here ? userMap.get(String(m.userId))?.email || '' : '',
        role: m.role,
        onProject: here,
      };
    }).sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'leader' ? -1 : 1));
    const incoming = handoffs.filter((h) => String(h.toTeamId) === String(team._id));
    const outgoing = handoffs.filter((h) => String(h.fromTeamId) === String(team._id));
    const leader = members.find((m) => m.userId === String(team.leaderId));
    const owns = String(project.owningTeamId || '') === String(team._id);
    return {
      id: String(team._id),
      name: team.name,
      description: team.description,
      leaderId: String(team.leaderId),
      leader: leader ? { userId: leader.userId, name: leader.name } : null,
      isActive: team.isActive,
      members,
      projectCount: team.projectIds.length,
      otherProjects: Math.max(0, team.projectIds.length - 1),
      ownsProject: owns,
      activeCases: owns ? 1 : 0,
      incomingHandoffs: incoming.filter((h) => HANDOFF_OPEN_STATES.includes(h.state)).length,
      outgoingHandoffs: outgoing.filter((h) => HANDOFF_OPEN_STATES.includes(h.state)).length,
      totalIncoming: incoming.length,
      totalOutgoing: outgoing.length,
      createdBy: String(team.createdBy),
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
    };
  });
}

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof z.ZodError || err.name === 'ZodError') return fail(res, 400, 'validation_error', err.message);
    next(err);
  }
};

/** Search across the caller's visible teams, e.g. to reuse a team on another project. */
router.get('/teams', requireAuth, handle(async (req, res) => {
  const query = teamSearchQuerySchema.parse(req.query);
  const filter = { isActive: true, ...(await discoverableTeamFilter(req.user._id)) };
  if (query.search) filter.name = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const teams = await ProjectTeam.find(filter).sort({ name: 1 }).limit(50);
  const leaders = await User.find({ _id: { $in: teams.map((team) => team.leaderId) } }).select('name').lean();
  const counts = await TeamMembership.aggregate([{ $match: { teamId: { $in: teams.map((team) => team._id) }, status: 'active' } }, { $group: { _id: '$teamId', count: { $sum: 1 } } }]);
  const memberCount = new Map(counts.map((row) => [String(row._id), row.count]));
  let membership = null;
  if (query.projectId) membership = await ProjectMembership.findOne({ projectId: query.projectId, userId: req.user._id }).lean();
  // Show each team's projects, but only the ones the caller belongs to; others are counted, never named.
  const allProjectIds = [...new Set(teams.flatMap((team) => team.projectIds.map(String)))];
  const myProjects = await ProjectMembership.find({ userId: req.user._id, projectId: { $in: allProjectIds } }).select('projectId').lean();
  const visibleIds = new Set(myProjects.map((row) => String(row.projectId)));
  const projectRows = await Project.find({ _id: { $in: [...visibleIds] } }).select('name').lean();
  const projectName = new Map(projectRows.map((row) => [String(row._id), row.name]));
  res.json({
    teams: teams.map((team) => ({
      id: String(team._id),
      name: team.name,
      description: team.description,
      leaderName: leaders.find((leader) => String(leader._id) === String(team.leaderId))?.name || 'Unknown',
      memberCount: memberCount.get(String(team._id)) || 0,
      projectCount: team.projectIds.length,
      projects: team.projectIds.filter((id) => visibleIds.has(String(id))).map((id) => ({ id: String(id), name: projectName.get(String(id)) || 'Project' })),
      hiddenProjectCount: team.projectIds.filter((id) => !visibleIds.has(String(id))).length,
      // Only meaningful when the caller belongs to the project they asked about.
      linked: membership ? team.projectIds.some((id) => String(id) === query.projectId) : null,
    })),
  });
}));

router.get('/projects/:id/teams', ...projectViewer, handle(async (req, res) => {
  const teams = (await linkedTeams(req.project._id)).sort((a, b) => (a.isActive === b.isActive ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isActive ? -1 : 1));
  res.json({ teams: await serializeTeams(req.project, teams), owningTeamId: req.project.owningTeamId ? String(req.project.owningTeamId) : null, nextDefaultName: await defaultTeamName(req.project._id) });
}));

router.post('/projects/:id/teams', ...projectOwner, handle(async (req, res) => {
  const body = createTeamSchema.parse(req.body);
  const memberIds = [...new Set([body.leaderId, ...body.memberIds])];
  const problem = await assertProjectMembers(req.project._id, memberIds, { leaderId: body.leaderId });
  if (problem) return fail(res, 400, 'validation_error', problem);
  const name = body.name || await defaultTeamName(req.project._id);
  if (await nameTaken(req.project._id, name)) return fail(res, 409, 'conflict', `A team named “${name}” already exists in this project`);

  const team = await withTx(async (session) => {
    const opts = session ? { session } : {};
    const [created] = await ProjectTeam.create([{ projectIds: [req.project._id], name, description: body.description, leaderId: body.leaderId, createdBy: req.user._id }], opts);
    await TeamMembership.insertMany(memberIds.map((userId) => ({ teamId: created._id, userId, role: userId === body.leaderId ? 'leader' : 'member' })), opts);
    return created;
  });
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'TEAM_CREATED', targetType: 'ProjectTeam', targetId: team._id, payload: { name: team.name } });
  const [serialized] = await serializeTeams(req.project, [team]);
  res.status(201).json({ team: serialized });
}));

/**
 * One-click way to turn the people already on a project into a team: the owner leads it, everyone who can act joins it.
 * Useful for projects created before teams existed.
 */
router.post('/projects/:id/teams/from-members', ...projectOwner, handle(async (req, res) => {
  const rows = await ProjectMembership.find({ projectId: req.project._id, role: { $in: ['owner', 'member'] } }).lean();
  const name = await defaultTeamName(req.project._id);
  const leaderId = String(req.project.ownerId);
  const memberIds = [...new Set([leaderId, ...rows.map((row) => String(row.userId))])];
  const team = await withTx(async (session) => {
    const opts = session ? { session } : {};
    const [created] = await ProjectTeam.create([{ projectIds: [req.project._id], name, description: `Formed from the members of ${req.project.name}`, leaderId, createdBy: req.user._id }], opts);
    await TeamMembership.insertMany(memberIds.map((userId) => ({ teamId: created._id, userId, role: userId === leaderId ? 'leader' : 'member' })), opts);
    return created;
  });
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'TEAM_CREATED', targetType: 'ProjectTeam', targetId: team._id, payload: { name: team.name, fromMembers: memberIds.length } });
  const [serialized] = await serializeTeams(req.project, [team]);
  res.status(201).json({ team: serialized });
}));

/** Reuse an existing team on this project. Its people keep their own project access; only members already here can receive handoffs. */
router.post('/projects/:id/teams/link', ...projectOwner, handle(async (req, res) => {
  const { teamId } = linkTeamSchema.parse(req.body);
  const team = await ProjectTeam.findOne({ _id: teamId, isActive: true, ...(await discoverableTeamFilter(req.user._id)) });
  if (!team) return fail(res, 404, 'not_found', 'Team not found');
  await linkLegacyTeams(req.project._id);
  if (team.projectIds.some((id) => String(id) === String(req.project._id))) return fail(res, 409, 'conflict', 'This team is already on the project');
  if (await nameTaken(req.project._id, team.name)) return fail(res, 409, 'conflict', `A team named “${team.name}” is already on this project; rename one of them first`);
  await ProjectTeam.updateOne({ _id: team._id }, { $addToSet: { projectIds: req.project._id } });
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'TEAM_LINKED', targetType: 'ProjectTeam', targetId: team._id, payload: { name: team.name } });
  const fresh = await ProjectTeam.findById(team._id);
  const [serialized] = await serializeTeams(req.project, [fresh]);
  const memberRows = await TeamMembership.find({ teamId: team._id, status: 'active' }).select('userId').lean();
  const onProject = await ProjectMembership.countDocuments({ projectId: req.project._id, userId: { $in: memberRows.map((row) => row.userId) } });
  res.status(201).json({ team: serialized, membersNotOnProject: memberRows.length - onProject });
}));

router.delete('/projects/:id/teams/:teamId/link', ...projectOwner, handle(async (req, res) => {
  const team = await loadTeam(req, res);
  if (!team) return;
  if (String(req.project.owningTeamId || '') === String(team._id)) return fail(res, 409, 'conflict', 'This team currently owns the project; hand it off first');
  if (await Handoff.exists({ projectId: req.project._id, isOpen: true, $or: [{ fromTeamId: team._id }, { toTeamId: team._id }] })) return fail(res, 409, 'conflict', 'This team is part of an open handoff on this project');
  await ProjectTeam.updateOne({ _id: team._id }, { $pull: { projectIds: req.project._id } });
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'TEAM_UNLINKED', targetType: 'ProjectTeam', targetId: team._id, payload: { name: team.name } });
  res.json({ unlinked: true });
}));

router.get('/projects/:id/teams/:teamId', ...projectViewer, handle(async (req, res) => {
  const team = await loadTeam(req, res);
  if (!team) return;
  const [serialized] = await serializeTeams(req.project, [team]);
  const handoffs = await Handoff.find({ projectId: req.project._id, $or: [{ fromTeamId: team._id }, { toTeamId: team._id }] }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({
    team: serialized,
    cases: serialized.ownsProject ? [{ id: String(req.project._id), name: req.project.name, status: 'active' }] : [],
    handoffs: handoffs.map((h) => ({
      id: String(h._id), state: h.state, transferType: h.transferType, reason: h.reason,
      direction: String(h.toTeamId) === String(team._id) ? 'incoming' : 'outgoing',
      fromTeamId: h.fromTeamId ? String(h.fromTeamId) : null, toTeamId: h.toTeamId ? String(h.toTeamId) : null,
      submittedAt: h.submittedAt, createdAt: h.createdAt,
    })),
    permissions: { admin: isTeamAdmin(req, team), roster: await canManageRoster(req, team), unlink: req.membership.role === 'owner' },
  });
}));

router.patch('/projects/:id/teams/:teamId', ...projectViewer, handle(async (req, res) => {
  const team = await loadTeam(req, res);
  if (!team) return;
  const body = updateTeamSchema.parse(req.body);
  const admin = isTeamAdmin(req, team);
  const leaderOfTeam = (await activeTeamRole(team._id, req.user._id)) === 'leader';
  if (!admin && !(leaderOfTeam && body.leaderId === undefined && body.isActive === undefined)) {
    return fail(res, 403, 'forbidden', 'Only the team’s administrator can change its leader or deactivate it');
  }

  const update = {};
  if (body.name !== undefined && body.name !== team.name) {
    // Names are unique on every project the team works on.
    for (const projectId of team.projectIds) {
      if (await nameTaken(projectId, body.name, team._id)) return fail(res, 409, 'conflict', `A team named “${body.name}” already exists on one of this team’s projects`);
    }
    update.name = body.name;
  }
  if (body.description !== undefined) update.description = body.description;

  if (body.isActive === false && team.isActive) {
    // A shared team can own or be mid-handoff on any of its projects, not only this one.
    if (await Project.exists({ owningTeamId: team._id })) return fail(res, 409, 'conflict', 'This team currently owns a project; hand it off before deactivating the team');
    if (await Handoff.exists({ isOpen: true, $or: [{ fromTeamId: team._id }, { toTeamId: team._id }] })) return fail(res, 409, 'conflict', 'This team is part of an open handoff; finish or cancel it first');
    update.isActive = false;
  } else if (body.isActive === true) {
    update.isActive = true;
  }

  try {
    await withTx(async (session) => {
      const opts = session ? { session } : {};
      if (body.leaderId !== undefined && body.leaderId !== String(team.leaderId)) {
        const target = await TeamMembership.findOne({ teamId: team._id, userId: body.leaderId, status: 'active' }, null, opts);
        if (!target) throw Object.assign(new Error('The new leader must already be an active member of this team'), { http: 400 });
        const projectRole = await ProjectMembership.findOne({ projectId: req.project._id, userId: body.leaderId }, null, opts);
        if (!projectRole || projectRole.role === 'viewer') throw Object.assign(new Error('A viewer cannot lead a team'), { http: 400 });
        await TeamMembership.updateMany({ teamId: team._id, role: 'leader' }, { $set: { role: 'member' } }, opts);
        await TeamMembership.updateOne({ teamId: team._id, userId: body.leaderId }, { $set: { role: 'leader' } }, opts);
        update.leaderId = body.leaderId;
      }
      if (Object.keys(update).length) await ProjectTeam.updateOne({ _id: team._id }, { $set: update }, opts);
    });
  } catch (err) {
    if (err.http) return fail(res, err.http, 'validation_error', err.message);
    throw err;
  }
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'TEAM_UPDATED', targetType: 'ProjectTeam', targetId: team._id, payload: { fields: Object.keys(update) } });
  const [serialized] = await serializeTeams(req.project, [await ProjectTeam.findById(team._id)]);
  res.json({ team: serialized });
}));

async function promoteLeader(req, team, userId) {
  const projectRole = await ProjectMembership.findOne({ projectId: req.project._id, userId });
  if (!projectRole || projectRole.role === 'viewer') throw Object.assign(new Error('A viewer cannot lead a team'), { http: 400 });
  await TeamMembership.updateMany({ teamId: team._id, role: 'leader' }, { $set: { role: 'member' } });
  await TeamMembership.updateOne({ teamId: team._id, userId }, { $set: { role: 'leader' } });
  await ProjectTeam.updateOne({ _id: team._id }, { $set: { leaderId: userId } });
}

router.post('/projects/:id/teams/:teamId/members', ...projectViewer, handle(async (req, res) => {
  const team = await loadTeam(req, res);
  if (!team) return;
  if (!(await canManageRoster(req, team))) return fail(res, 403, 'forbidden', 'Only the team’s administrator or leader can add members');
  if (!team.isActive) return fail(res, 409, 'conflict', 'This team is inactive');
  const body = addTeamMemberSchema.parse(req.body);
  if (body.role === 'leader' && !isTeamAdmin(req, team)) return fail(res, 403, 'forbidden', 'Only the team’s administrator can assign a leader');
  const problem = await assertProjectMembers(req.project._id, [body.userId]);
  if (problem) return fail(res, 400, 'validation_error', problem);
  await TeamMembership.findOneAndUpdate(
    { teamId: team._id, userId: body.userId },
    { $set: { status: 'active', role: 'member' } },
    { upsert: true, setDefaultsOnInsert: true }
  );
  if (body.role === 'leader') {
    try { await promoteLeader(req, team, body.userId); } catch (err) { if (err.http) return fail(res, err.http, 'validation_error', err.message); throw err; }
  }
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'TEAM_MEMBER_ADDED', targetType: 'ProjectTeam', targetId: team._id, payload: { userId: body.userId, role: body.role } });
  const [serialized] = await serializeTeams(req.project, [await ProjectTeam.findById(team._id)]);
  res.status(201).json({ team: serialized });
}));

router.patch('/projects/:id/teams/:teamId/members/:userId', ...projectViewer, handle(async (req, res) => {
  const team = await loadTeam(req, res);
  if (!team) return;
  if (!isTeamAdmin(req, team)) return fail(res, 403, 'forbidden', 'Only the team’s administrator can change roles');
  if (!isId(req.params.userId)) return fail(res, 404, 'not_found', 'Member not found');
  const body = updateTeamMemberSchema.parse(req.body);
  const membership = await TeamMembership.findOne({ teamId: team._id, userId: req.params.userId, status: 'active' });
  if (!membership) return fail(res, 404, 'not_found', 'Member not found');
  if (body.role === 'leader') {
    try { await promoteLeader(req, team, req.params.userId); } catch (err) { if (err.http) return fail(res, err.http, 'validation_error', err.message); throw err; }
  } else if (membership.role === 'leader') {
    return fail(res, 409, 'conflict', 'Assign another leader first; a team cannot be left without one');
  }
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'TEAM_MEMBER_ROLE_CHANGED', targetType: 'ProjectTeam', targetId: team._id, payload: { userId: req.params.userId, role: body.role } });
  const [serialized] = await serializeTeams(req.project, [await ProjectTeam.findById(team._id)]);
  res.json({ team: serialized });
}));

router.delete('/projects/:id/teams/:teamId/members/:userId', ...projectViewer, handle(async (req, res) => {
  const team = await loadTeam(req, res);
  if (!team) return;
  if (!(await canManageRoster(req, team))) return fail(res, 403, 'forbidden', 'Only the team’s administrator or leader can remove members');
  if (!isId(req.params.userId)) return fail(res, 404, 'not_found', 'Member not found');
  const membership = await TeamMembership.findOne({ teamId: team._id, userId: req.params.userId, status: 'active' });
  if (!membership) return fail(res, 404, 'not_found', 'Member not found');
  if (membership.role === 'leader' || String(team.leaderId) === req.params.userId) return fail(res, 409, 'conflict', 'Assign another leader before removing the current one');
  // The person may be the named recipient of an open handoff on any project this team serves.
  if (await Handoff.exists({ isOpen: true, toTeamId: team._id, toUserId: req.params.userId })) return fail(res, 409, 'conflict', 'This person is the named recipient of an open handoff');
  await TeamMembership.updateOne({ _id: membership._id }, { $set: { status: 'removed' } });
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'TEAM_MEMBER_REMOVED', targetType: 'ProjectTeam', targetId: team._id, payload: { userId: req.params.userId } });
  const [serialized] = await serializeTeams(req.project, [await ProjectTeam.findById(team._id)]);
  res.json({ team: serialized });
}));

/** Active team members who are also on this project and can receive a handoff, with real workload (open assigned tasks here). */
router.get('/projects/:id/teams/:teamId/eligible-recipients', ...projectViewer, handle(async (req, res) => {
  // A team the caller can see but that isn't on this project yet may be previewed; it is added when a handoff is created.
  let team;
  if (isId(req.params.teamId)) {
    await linkLegacyTeams(req.project._id);
    team = await ProjectTeam.findOne({ _id: req.params.teamId, $or: [{ projectIds: req.project._id }, (await discoverableTeamFilter(req.user._id))] });
    if (team && !team.projectIds.some((id) => String(id) === String(req.project._id)) && req.membership.role !== 'owner') team = null;
  }
  if (!team) return fail(res, 404, 'not_found', 'Team not found');
  if (!team.isActive) return res.json({ team: { id: String(team._id), name: team.name, isActive: false }, recipients: [] });
  const memberships = await TeamMembership.find({ teamId: team._id, status: 'active' }).lean();
  const ids = memberships.map((m) => m.userId);
  const [projectRows, users, workload] = await Promise.all([
    ProjectMembership.find({ projectId: req.project._id, userId: { $in: ids } }).lean(),
    User.find({ _id: { $in: ids } }).select('name email').lean(),
    Task.aggregate([{ $match: { projectId: req.project._id, status: 'open', assignee: { $in: ids } } }, { $group: { _id: '$assignee', count: { $sum: 1 } } }]),
  ]);
  const projectRole = new Map(projectRows.map((row) => [String(row.userId), row.role]));
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  const load = new Map(workload.map((row) => [String(row._id), row.count]));
  const recipients = memberships
    .filter((m) => projectRole.has(String(m.userId)) && String(m.userId) !== String(req.project.ownerId))
    .map((m) => ({
      userId: String(m.userId),
      name: userMap.get(String(m.userId))?.name || 'Unknown',
      email: userMap.get(String(m.userId))?.email || '',
      teamRole: m.role,
      isLeader: m.role === 'leader',
      projectRole: projectRole.get(String(m.userId)),
      openTasks: load.get(String(m.userId)) || 0,
    }))
    .sort((a, b) => (a.isLeader === b.isLeader ? a.name.localeCompare(b.name) : a.isLeader ? -1 : 1));
  res.json({ team: { id: String(team._id), name: team.name, isActive: true }, recipients });
}));

/** Sets (or clears) the team that owns the project, so handoffs know their sending team. */
router.put('/projects/:id/owning-team', ...projectOwner, handle(async (req, res) => {
  const { teamId } = z.object({ teamId: objectId.nullable() }).strict().parse(req.body);
  if (await Handoff.exists({ projectId: req.project._id, isOpen: true })) return fail(res, 409, 'conflict', 'Finish or cancel the open handoff before changing the owning team');
  if (teamId) {
    await linkLegacyTeams(req.project._id);
    const team = await ProjectTeam.findOne({ _id: teamId, projectIds: req.project._id, isActive: true });
    if (!team) return fail(res, 400, 'validation_error', 'Team not found in this project');
  }
  await Project.updateOne({ _id: req.project._id }, { $set: { owningTeamId: teamId } });
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'TEAM_OWNERSHIP_SET', targetType: 'Project', targetId: req.project._id, payload: { teamId } });
  res.json({ owningTeamId: teamId });
}));

export default router;
