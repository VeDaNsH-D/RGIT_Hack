/**
 * Inter-team handoffs end to end: real app + disposable MongoDB. Covers team management, intra/inter-team transfers,
 * the state machine (submit / request changes / reject / accept), atomic ownership, context snapshots and authorization.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMongo, stopMongo, resetCollections } from './harness.js';

// A developer's .env may hold live Twilio/Meta credentials; handoff events would otherwise try to message a real number.
for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'META_WHATSAPP_TOKEN', 'META_WHATSAPP_PHONE_NUMBER_ID']) process.env[key] = '';

await startMongo();
process.env.MONGODB_URI_TEST = process.env.MONGODB_URI; // db.js prefers this in test mode; keep it on the disposable server
const { app } = await import('../../src/app.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { User, Project, ProjectMembership, Handoff, ActivityEvent, Document } = await import('../../src/models/index.js');
after(async () => { await stopMongo(); });

describe('teams and inter-team handoffs', () => {
  let server, base, alice, bob, carol, dave, viewer, outsider, project, other;
  const tok = (u) => `Bearer ${signAuthToken(u)}`;
  const call = async (method, path, u, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(u ? { Authorization: tok(u) } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  const P = () => `/api/projects/${project._id}`;
  const member = (p, u, role, by) => ProjectMembership.create({ projectId: p._id, userId: u._id, role, invitedBy: (by || alice)._id });
  const mkTeam = async (name, leader, members = []) => {
    const r = await call('POST', `${P()}/teams`, alice, { name, leaderId: String(leader._id), memberIds: members.map((m) => String(m._id)) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.team;
  };
  const ready = (id, u) => call('PATCH', `/api/handoffs/${id}`, u, { currentStatus: 'Everything is in a stable state.', noPendingActionsConfirmed: true, supportingLinks: ['https://example.com/runbook'] });
  /** Creates + prepares + submits an inter-team handoff from alice to `to` on `team`. */
  const submitTo = async (team, to, extra = {}) => {
    const created = await call('POST', `${P()}/handoffs`, alice, { toUserId: String(to._id), toTeamId: team.id, reason: 'Needs model expertise', ...extra });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.handoff.id;
    assert.equal((await ready(id, alice)).status, 200);
    const submitted = await call('POST', `/api/handoffs/${id}/submit`, alice);
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    return { id, handoff: submitted.body.handoff };
  };

  before(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((r) => server.close(r)); });

  beforeEach(async () => {
    await resetCollections();
    [alice, bob, carol, dave, viewer, outsider] = await Promise.all(
      ['alice', 'bob', 'carol', 'dave', 'viewer', 'outsider'].map((n) => User.create({ email: `${n}@example.com`, name: n[0].toUpperCase() + n.slice(1) }))
    );
    project = await Project.create({ name: 'Relay', ownerId: alice._id, createdBy: alice._id });
    other = await Project.create({ name: 'Other', ownerId: outsider._id, createdBy: outsider._id });
    await member(project, alice, 'owner');
    await member(project, bob, 'member');
    await member(project, carol, 'member');
    await member(project, dave, 'member');
    await member(project, viewer, 'viewer');
    await member(other, outsider, 'owner', outsider);
  });

  describe('team management', () => {
    it('creates, lists and loads teams with leader and members', async () => {
      const team = await mkTeam('Backend', alice, [carol]);
      assert.equal(team.leader.name, 'Alice');
      assert.deepEqual(team.members.map((m) => m.role), ['leader', 'member']);
      const list = await call('GET', `${P()}/teams`, bob);
      assert.equal(list.status, 200);
      assert.equal(list.body.teams.length, 1);
      const detail = await call('GET', `${P()}/teams/${team.id}`, bob);
      assert.equal(detail.body.team.name, 'Backend');
    });

    it('enforces who may manage teams and which users are valid', async () => {
      assert.equal((await call('POST', `${P()}/teams`, bob, { name: 'X', leaderId: String(bob._id) })).status, 403);
      assert.equal((await call('POST', `${P()}/teams`, null, { name: 'X', leaderId: String(bob._id) })).status, 401);
      assert.equal((await call('POST', `${P()}/teams`, outsider, { name: 'X', leaderId: String(bob._id) })).status, 404);
      // a person who is not on the project cannot lead or join
      assert.equal((await call('POST', `${P()}/teams`, alice, { name: 'X', leaderId: String(outsider._id) })).status, 400);
      assert.equal((await call('POST', `${P()}/teams`, alice, { name: 'X', leaderId: String(viewer._id) })).status, 400);
      const team = await mkTeam('Backend', alice);
      assert.equal((await call('POST', `${P()}/teams/${team.id}/members`, alice, { userId: String(outsider._id) })).status, 400);
      // duplicate active team name in one project
      assert.equal((await call('POST', `${P()}/teams`, alice, { name: 'backend', leaderId: String(bob._id) })).status, 409);
    });

    it('does not expose a team through another project', async () => {
      const team = await mkTeam('Backend', alice);
      const r = await call('GET', `/api/projects/${other._id}/teams/${team.id}`, outsider);
      assert.equal(r.status, 404);
    });

    it('manages the roster and keeps exactly one valid leader', async () => {
      const team = await mkTeam('AI', bob);
      assert.equal((await call('POST', `${P()}/teams/${team.id}/members`, alice, { userId: String(carol._id) })).status, 201);
      // the team leader may manage their own roster
      assert.equal((await call('POST', `${P()}/teams/${team.id}/members`, bob, { userId: String(dave._id) })).status, 201);
      // but a plain member cannot
      assert.equal((await call('POST', `${P()}/teams/${team.id}/members`, carol, { userId: String(viewer._id) })).status, 403);
      // leader cannot be removed or demoted without a replacement
      assert.equal((await call('DELETE', `${P()}/teams/${team.id}/members/${bob._id}`, alice)).status, 409);
      assert.equal((await call('PATCH', `${P()}/teams/${team.id}/members/${bob._id}`, alice, { role: 'member' })).status, 409);
      const promoted = await call('PATCH', `${P()}/teams/${team.id}`, alice, { leaderId: String(carol._id) });
      assert.equal(promoted.status, 200);
      assert.equal(promoted.body.team.members.filter((m) => m.role === 'leader').length, 1);
      assert.equal(promoted.body.team.leader.name, 'Carol');
      assert.equal((await call('DELETE', `${P()}/teams/${team.id}/members/${bob._id}`, alice)).status, 200);
      // non-members cannot be made leader
      assert.equal((await call('PATCH', `${P()}/teams/${team.id}`, alice, { leaderId: String(viewer._id) })).status, 400);
    });

    it('lists eligible recipients with real workload and excludes the current owner', async () => {
      const team = await mkTeam('AI', bob, [carol, alice]);
      const r = await call('GET', `${P()}/teams/${team.id}/eligible-recipients`, alice);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.recipients.map((x) => x.name), ['Bob', 'Carol']);
      assert.equal(r.body.recipients[0].isLeader, true);
      assert.equal(r.body.recipients[0].openTasks, 0);
    });
  });

  describe('handoff workflow', () => {
    it('inter-team: ownership stays put until acceptance, then team and owner move together', async () => {
      const backend = await mkTeam('Backend', alice);
      const ai = await mkTeam('AI/ML', bob, [carol]);
      assert.equal((await call('PUT', `${P()}/owning-team`, alice, { teamId: backend.id })).status, 200);

      const { id, handoff } = await submitTo(ai, carol);
      assert.equal(handoff.state, 'SUBMITTED');
      assert.equal(handoff.transferType, 'inter_team');
      assert.equal(handoff.fromTeamId, backend.id);
      assert.equal(handoff.toTeamId, ai.id);
      assert.equal(handoff.contextSnapshot.sender.teamId, backend.id);
      assert.match(handoff.contextSnapshot.hash, /^[0-9a-f]{64}$/);

      let fresh = await Project.findById(project._id);
      assert.equal(String(fresh.ownerId), String(alice._id), 'owner unchanged before acceptance');
      assert.equal(String(fresh.owningTeamId), backend.id, 'owning team unchanged before acceptance');

      const accepted = await call('POST', `/api/handoffs/${id}/acknowledge`, carol);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      fresh = await Project.findById(project._id);
      assert.equal(String(fresh.ownerId), String(carol._id));
      assert.equal(String(fresh.owningTeamId), ai.id);
      assert.equal(fresh.ownershipHistory.length, 1);
      assert.equal(fresh.ownershipHistory[0].reason, 'Needs model expertise');

      const timeline = await call('GET', `${P()}/ownership-history`, bob);
      assert.equal(timeline.body.current.owner.name, 'Carol');
      assert.equal(timeline.body.current.team.name, 'AI/ML');
      assert.equal(timeline.body.ownershipHistory[0].fromTeam.name, 'Backend');
      assert.equal(timeline.body.ownershipHistory[0].toTeam.name, 'AI/ML');
      assert.equal(timeline.body.ownershipHistory[0].acceptedBy.name, 'Carol');

      const actions = (await ActivityEvent.find({ projectId: project._id }).lean()).map((e) => e.action);
      for (const action of ['HANDOFF_CREATED', 'HANDOFF_CONTEXT_SNAPSHOT', 'HANDOFF_SUBMITTED', 'HANDOFF_ACKNOWLEDGED', 'OWNERSHIP_TRANSFERRED']) assert.ok(actions.includes(action), action);
    });

    it('intra-team: a transfer inside the owning team is labelled as such', async () => {
      const backend = await mkTeam('Backend', alice, [bob]);
      await call('PUT', `${P()}/owning-team`, alice, { teamId: backend.id });
      const { handoff } = await submitTo(backend, bob);
      assert.equal(handoff.transferType, 'intra_team');
    });

    it('requires a reason, a valid team and a recipient who belongs to that team', async () => {
      const ai = await mkTeam('AI/ML', bob);
      assert.equal((await call('POST', `${P()}/handoffs`, alice, { toUserId: String(bob._id), toTeamId: ai.id })).status, 400);
      // carol is a project member but not on the AI team
      assert.equal((await call('POST', `${P()}/handoffs`, alice, { toUserId: String(carol._id), toTeamId: ai.id, reason: 'x' })).status, 400);
      const foreign = await call('POST', `/api/projects/${other._id}/teams`, outsider, { name: 'Foreign', leaderId: String(outsider._id) });
      assert.equal((await call('POST', `${P()}/handoffs`, alice, { toUserId: String(bob._id), toTeamId: foreign.body.team.id, reason: 'x' })).status, 400);
      // the legacy person-to-person flow still works
      const legacy = await call('POST', `${P()}/handoffs`, alice, { toUserId: String(bob._id) });
      assert.equal(legacy.status, 201);
      assert.equal(legacy.body.handoff.transferType, 'individual');
    });

    it('cannot target an inactive team', async () => {
      const ai = await mkTeam('AI/ML', bob);
      assert.equal((await call('PATCH', `${P()}/teams/${ai.id}`, alice, { isActive: false })).status, 200);
      assert.equal((await call('POST', `${P()}/handoffs`, alice, { toUserId: String(bob._id), toTeamId: ai.id, reason: 'x' })).status, 409);
    });

    it('rejection needs a reason, keeps ownership, closes the handoff and notifies the sender', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      const { id } = await submitTo(ai, carol);
      assert.equal((await call('POST', `/api/handoffs/${id}/reject`, carol, {})).status, 400);
      assert.equal((await call('POST', `/api/handoffs/${id}/reject`, alice, { reason: 'no' })).status, 403);
      const rejected = await call('POST', `/api/handoffs/${id}/reject`, carol, { reason: 'Out of scope for our team' });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.handoff.state, 'REJECTED');
      assert.equal(rejected.body.handoff.rejectionReason, 'Out of scope for our team');
      const fresh = await Project.findById(project._id);
      assert.equal(String(fresh.ownerId), String(alice._id));
      assert.equal(fresh.ownershipHistory.length, 0);
      // terminal: cannot be accepted afterwards, and a new handoff can be opened
      assert.equal((await call('POST', `/api/handoffs/${id}/acknowledge`, carol)).status, 409);
      assert.equal((await call('POST', `${P()}/handoffs`, alice, { toUserId: String(bob._id), toTeamId: ai.id, reason: 'Retry' })).status, 201);
      const { NotificationModel } = await import('../../src/models/index.js');
      const note = await NotificationModel.findOne({ type: 'HANDOFF_REJECTED' }).lean();
      assert.ok(note, 'sender is notified of the rejection');
      assert.equal(String(note.recipientUserId), String(alice._id));
    });

    it('request changes needs a note, returns to editing, and resubmission keeps a snapshot trail', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      const { id, handoff } = await submitTo(ai, carol);
      assert.equal((await call('POST', `/api/handoffs/${id}/clarify`, carol, { note: '  ' })).status, 400);
      assert.equal((await call('POST', `/api/handoffs/${id}/clarify`, carol, { note: 'Which model version?' })).status, 200);
      assert.equal((await Project.findById(project._id)).ownerId.equals(alice._id), true);
      const responded = await call('POST', `/api/handoffs/${id}/respond`, alice, { note: 'v2.1' });
      assert.equal(responded.body.handoff.state, 'EDITING');
      const resubmitted = await call('POST', `/api/handoffs/${id}/submit`, alice);
      assert.equal(resubmitted.body.handoff.state, 'SUBMITTED');
      const stored = await Handoff.findById(id).lean();
      assert.equal(stored.contextSnapshotHistory.length, 1);
      assert.equal(stored.contextSnapshotHistory[0].hash, handoff.contextSnapshot.hash);
    });

    it('accepting twice or concurrently transfers ownership exactly once', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      const { id } = await submitTo(ai, carol);
      const results = await Promise.all([call('POST', `/api/handoffs/${id}/acknowledge`, carol), call('POST', `/api/handoffs/${id}/acknowledge`, carol)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      const fresh = await Project.findById(project._id);
      assert.equal(fresh.ownershipHistory.length, 1);
      assert.equal(String((await call('POST', `/api/handoffs/${id}/acknowledge`, carol)).status), '409');
    });

    it('revalidates at acceptance: recipient removed from the team or team deactivated blocks the transfer', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol, dave]);
      const { id } = await submitTo(ai, carol);
      // the named recipient cannot be removed while the request is open
      assert.equal((await call('DELETE', `${P()}/teams/${ai.id}/members/${carol._id}`, alice)).status, 409);
      // the team cannot be deactivated while part of an open handoff
      assert.equal((await call('PATCH', `${P()}/teams/${ai.id}`, alice, { isActive: false })).status, 409);
      // simulate the data changing underneath (e.g. direct removal) and prove acceptance still refuses
      const { TeamMembership } = await import('../../src/models/index.js');
      await TeamMembership.updateOne({ teamId: ai.id, userId: carol._id }, { $set: { status: 'removed' } });
      const blocked = await call('POST', `/api/handoffs/${id}/acknowledge`, carol);
      assert.equal(blocked.status, 409);
      const fresh = await Project.findById(project._id);
      assert.equal(String(fresh.ownerId), String(alice._id));
      assert.equal((await Handoff.findById(id)).state, 'SUBMITTED');
    });
  });

  describe('team names and sharing across projects', () => {
    let second;
    const mkNamed = async (body, as = alice, proj = project) => call('POST', `/api/projects/${proj._id}/teams`, as, body);
    beforeEach(async () => {
      second = await Project.create({ name: 'Second', ownerId: alice._id, createdBy: alice._id });
      await member(second, alice, 'owner');
      await member(second, bob, 'member');
      await member(second, carol, 'member');
    });

    it('numbers teams automatically (Team 1, Team 2, ...) and never reuses a taken name', async () => {
      const names = [];
      for (let i = 0; i < 3; i += 1) names.push((await mkNamed({ leaderId: String(alice._id) })).body.team.name);
      assert.deepEqual(names, ['Team 1', 'Team 2', 'Team 3']);
      const list = await call('GET', `${P()}/teams`, alice);
      assert.equal(list.body.nextDefaultName, 'Team 4');
      // renaming and deactivating keep the numbering collision-free
      const t2 = list.body.teams.find((t) => t.name === 'Team 2');
      assert.equal((await call('PATCH', `${P()}/teams/${t2.id}`, alice, { name: 'Alpha' })).status, 200);
      assert.equal((await mkNamed({ leaderId: String(alice._id) })).body.team.name, 'Team 4');
      // an explicit name still works, and duplicates are refused
      assert.equal((await mkNamed({ name: 'Backend', leaderId: String(alice._id) })).status, 201);
      assert.equal((await mkNamed({ name: 'BACKEND', leaderId: String(alice._id) })).status, 409);
      // each project numbers independently
      assert.equal((await mkNamed({ leaderId: String(alice._id) }, alice, second)).body.team.name, 'Team 1');
    });

    it('the same team can serve several projects, and only its project members can receive handoffs there', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol, dave]);
      const linked = await call('POST', `/api/projects/${second._id}/teams/link`, alice, { teamId: ai.id });
      assert.equal(linked.status, 201, JSON.stringify(linked.body));
      assert.equal(linked.body.membersNotOnProject, 1); // dave is not on "Second"
      assert.equal(linked.body.team.projectCount, 2);
      // visible on both projects
      for (const proj of [project, second]) assert.ok((await call('GET', `/api/projects/${proj._id}/teams`, alice)).body.teams.some((t) => t.id === ai.id));
      // recipients on the second project exclude people who are not on it
      const recipients = await call('GET', `/api/projects/${second._id}/teams/${ai.id}/eligible-recipients`, alice);
      assert.deepEqual(recipients.body.recipients.map((r) => r.name), ['Bob', 'Carol']);
      // contact details of people outside the project are not exposed
      const detail = await call('GET', `/api/projects/${second._id}/teams/${ai.id}`, alice);
      const outsiderMember = detail.body.team.members.find((m) => m.name === 'Dave');
      assert.equal(outsiderMember.email, '');
      assert.equal(outsiderMember.onProject, false);
      // a real handoff on the second project through the shared team
      const created = await call('POST', `/api/projects/${second._id}/handoffs`, alice, { toUserId: String(carol._id), toTeamId: ai.id, reason: 'Shared team takes over' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.handoff.transferType, 'inter_team');
      // Dave is on the team but not on Second, so he cannot be named there
      assert.equal((await call('POST', `/api/projects/${second._id}/handoffs`, alice, { toUserId: String(dave._id), toTeamId: ai.id, reason: 'x' })).status, 409);
    });

    it('linking is owner-only, limited to teams the caller can discover, and refuses name clashes', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      assert.equal((await call('POST', `/api/projects/${second._id}/teams/link`, bob, { teamId: ai.id })).status, 403);
      assert.equal((await call('POST', `/api/projects/${other._id}/teams/link`, outsider, { teamId: ai.id })).status, 404);
      assert.equal((await call('POST', `/api/projects/${project._id}/teams/link`, alice, { teamId: ai.id })).status, 409); // already linked
      await mkNamed({ name: 'ai/ml', leaderId: String(alice._id) }, alice, second);
      assert.equal((await call('POST', `/api/projects/${second._id}/teams/link`, alice, { teamId: ai.id })).status, 409);
    });

    it('searches the teams a person can see, and reports whether each is on the project', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      await mkTeam('Platform', alice);
      const mine = await call('GET', `/api/teams?search=ai&projectId=${second._id}`, alice);
      assert.deepEqual(mine.body.teams.map((t) => t.name), ['AI/ML']);
      assert.equal(mine.body.teams[0].linked, false);
      assert.equal(mine.body.teams[0].leaderName, 'Bob');
      assert.equal(mine.body.teams[0].memberCount, 2);
      await call('POST', `/api/projects/${second._id}/teams/link`, alice, { teamId: ai.id });
      assert.equal((await call('GET', `/api/teams?search=AI&projectId=${second._id}`, alice)).body.teams[0].linked, true);
      // someone with no connection to the team cannot discover it
      assert.deepEqual((await call('GET', '/api/teams', outsider)).body.teams, []);
      assert.equal((await call('GET', '/api/teams', null)).status, 401);
    });

    it('unlinking is blocked while the team owns the project or is in an open handoff, and keeps other projects intact', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      await call('POST', `/api/projects/${second._id}/teams/link`, alice, { teamId: ai.id });
      await call('PUT', `/api/projects/${second._id}/owning-team`, alice, { teamId: ai.id });
      assert.equal((await call('DELETE', `/api/projects/${second._id}/teams/${ai.id}/link`, alice)).status, 409);
      await call('PUT', `/api/projects/${second._id}/owning-team`, alice, { teamId: null });
      assert.equal((await call('DELETE', `/api/projects/${second._id}/teams/${ai.id}/link`, alice)).status, 200);
      assert.equal((await call('GET', `/api/projects/${second._id}/teams/${ai.id}`, alice)).status, 404);
      assert.equal((await call('GET', `${P()}/teams/${ai.id}`, alice)).status, 200);
    });

    it('lists every distinct team you can see with the projects it works on, naming only projects you belong to', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      await call('POST', `/api/projects/${second._id}/teams/link`, alice, { teamId: ai.id });
      const hidden = await Project.create({ name: 'Secret', ownerId: outsider._id, createdBy: outsider._id });
      const { ProjectTeam } = await import('../../src/models/index.js');
      await ProjectTeam.updateOne({ _id: ai.id }, { $addToSet: { projectIds: hidden._id } });
      const found = (await call('GET', `/api/teams?search=ai/ml`, alice)).body.teams;
      assert.equal(found.length, 1, 'one distinct team, not one row per project');
      assert.deepEqual(found[0].projects.map((p) => p.name).sort(), ['Relay', 'Second']);
      assert.equal(found[0].hiddenProjectCount, 1);
      assert.equal(found[0].projectCount, 3);
    });

    it('a team you can see but that is not on this project can be previewed and is added when the handoff is created', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      await call('POST', `/api/projects/${second._id}/teams/link`, alice, { teamId: ai.id }); // not yet on `second` otherwise
      await call('DELETE', `/api/projects/${second._id}/teams/${ai.id}/link`, alice);
      assert.equal((await call('GET', `/api/projects/${second._id}/teams/${ai.id}`, alice)).status, 404);
      // owner can preview recipients; a plain member cannot
      const preview = await call('GET', `/api/projects/${second._id}/teams/${ai.id}/eligible-recipients`, alice);
      assert.equal(preview.status, 200);
      assert.deepEqual(preview.body.recipients.map((r) => r.name), ['Bob', 'Carol']);
      assert.equal((await call('GET', `/api/projects/${second._id}/teams/${ai.id}/eligible-recipients`, bob)).status, 404);
      // creating the handoff adds the team to the project
      const created = await call('POST', `/api/projects/${second._id}/handoffs`, alice, { toUserId: String(carol._id), toTeamId: ai.id, reason: 'Adding the team as we hand over' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.handoff.transferType, 'inter_team');
      assert.ok((await call('GET', `/api/projects/${second._id}/teams`, alice)).body.teams.some((t) => t.id === ai.id));
    });

    it('refuses to route to a team that is hidden from the sender or whose recipient is not on the project', async () => {
      const hiddenTeam = await call('POST', `/api/projects/${other._id}/teams`, outsider, { leaderId: String(outsider._id) });
      assert.equal((await call('POST', `/api/projects/${second._id}/handoffs`, alice, { toUserId: String(bob._id), toTeamId: hiddenTeam.body.team.id, reason: 'x' })).status, 400);
      const ai = await mkTeam('AI/ML', bob, [carol, dave]);
      await call('POST', `/api/projects/${second._id}/teams/link`, alice, { teamId: ai.id });
      await call('DELETE', `/api/projects/${second._id}/teams/${ai.id}/link`, alice);
      // dave is on the team but not on the second project
      assert.equal((await call('POST', `/api/projects/${second._id}/handoffs`, alice, { toUserId: String(dave._id), toTeamId: ai.id, reason: 'x' })).status, 400);
    });

    it('forms a team from the people already on a project', async () => {
      const r = await call('POST', `${P()}/teams/from-members`, alice, {});
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.team.name, 'Team 1');
      assert.equal(r.body.team.leader.name, 'Alice');
      assert.deepEqual(r.body.team.members.map((m) => m.name).sort(), ['Alice', 'Bob', 'Carol', 'Dave']); // the viewer is not added
      assert.equal((await call('POST', `${P()}/teams/from-members`, bob, {})).status, 403);
    });

    it('a shared team is administered by its creator, and cannot be deactivated while it owns any project', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      await call('POST', `/api/projects/${second._id}/teams/link`, alice, { teamId: ai.id });
      await call('PUT', `/api/projects/${second._id}/owning-team`, alice, { teamId: ai.id });
      // the leader may rename but not deactivate
      assert.equal((await call('PATCH', `${P()}/teams/${ai.id}`, bob, { description: 'Models' })).status, 200);
      assert.equal((await call('PATCH', `${P()}/teams/${ai.id}`, bob, { isActive: false })).status, 403);
      // even the creator cannot deactivate it while it owns "Second", a different project from the one being edited
      assert.equal((await call('PATCH', `${P()}/teams/${ai.id}`, alice, { isActive: false })).status, 409);
    });
  });

  describe('authorization', () => {
    it('only the owner can start a handoff and only the named recipient can decide', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      assert.equal((await call('POST', `${P()}/handoffs`, bob, { toUserId: String(carol._id), toTeamId: ai.id, reason: 'x' })).status, 403);
      assert.equal((await call('POST', `${P()}/handoffs`, null, { toUserId: String(carol._id), toTeamId: ai.id, reason: 'x' })).status, 401);
      const { id } = await submitTo(ai, carol);
      for (const who of [bob, dave, alice]) assert.equal((await call('POST', `/api/handoffs/${id}/acknowledge`, who)).status, 403);
      for (const who of [bob, dave]) assert.equal((await call('POST', `/api/handoffs/${id}/reject`, who, { reason: 'x' })).status, 403);
    });

    it('hides handoffs from people outside the project, even with the id', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      const { id } = await submitTo(ai, carol);
      assert.equal((await call('GET', `/api/handoffs/${id}`, outsider)).status, 404);
      assert.equal((await call('POST', `/api/handoffs/${id}/reject`, outsider, { reason: 'x' })).status, 404);
      assert.equal((await call('GET', `/api/handoffs/${id}`, null)).status, 401);
    });

    it('rejects supporting documents that belong to another project', async () => {
      const ai = await mkTeam('AI/ML', bob);
      const created = await call('POST', `${P()}/handoffs`, alice, { toUserId: String(bob._id), toTeamId: ai.id, reason: 'x' });
      const foreignDoc = await Document.create({ projectId: other._id, title: 'Secret', uploadedBy: outsider._id });
      const r = await call('PATCH', `/api/handoffs/${created.body.handoff.id}`, alice, { documentIds: [String(foreignDoc._id)] });
      assert.equal(r.status, 400);
      const ownDoc = await Document.create({ projectId: project._id, title: 'Runbook', uploadedBy: alice._id });
      const ok = await call('PATCH', `/api/handoffs/${created.body.handoff.id}`, alice, { documentIds: [String(ownDoc._id)] });
      assert.equal(ok.status, 200);
    });

    it('flags a snapshot as stale when project data changes while the request is pending', async () => {
      const ai = await mkTeam('AI/ML', bob, [carol]);
      const { id } = await submitTo(ai, carol);
      assert.equal((await call('GET', `/api/handoffs/${id}`, carol)).body.contextStale, false);
      assert.equal((await call('POST', `${P()}/tasks`, alice, { title: 'New urgent task', priority: 'high' })).status, 201);
      const detail = await call('GET', `/api/handoffs/${id}`, carol);
      assert.equal(detail.body.contextStale, true);
      assert.equal(detail.body.toTeam.name, 'AI/ML');
    });
  });
});
