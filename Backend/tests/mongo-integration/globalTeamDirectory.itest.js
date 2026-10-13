import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMongo, stopMongo, resetCollections } from './harness.js';

await startMongo();
process.env.MONGODB_URI_TEST = process.env.MONGODB_URI;
const { app } = await import('../../src/app.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { User, Project, ProjectTeam, TeamMembership, ProjectMembership } = await import('../../src/models/index.js');
after(async () => { await stopMongo(); });

describe('global team directory and auto-team creation', () => {
  let server, base, alice, bob, charlie;
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

  before(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((r) => server.close(r)); });

  beforeEach(async () => {
    await resetCollections();
    [alice, bob, charlie] = await Promise.all([
      User.create({ email: 'alice@example.com', name: 'Alice' }),
      User.create({ email: 'bob@example.com', name: 'Bob' }),
      User.create({ email: 'charlie@example.com', name: 'Charlie' }),
    ]);
  });

  it('automatically adds a team to the team directory when a project is created with owner and members', async () => {
    const res = await call('POST', '/api/projects', alice, {
      name: 'Phoenix',
      description: 'Project Phoenix',
      memberEmails: ['bob@example.com'],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const project = res.body.project;

    // Check Project record has owningTeamId
    const projectDoc = await Project.findById(project.id);
    assert.ok(projectDoc.owningTeamId, 'project should have owningTeamId');

    // Check ProjectTeam record
    const team = await ProjectTeam.findById(projectDoc.owningTeamId);
    assert.ok(team, 'ProjectTeam should exist');
    assert.equal(team.name, 'Phoenix Team');
    assert.equal(String(team.leaderId), String(alice._id));
    assert.ok(team.projectIds.map(String).includes(String(project.id)));

    // Check TeamMembership records
    const members = await TeamMembership.find({ teamId: team._id }).lean();
    assert.equal(members.length, 2);
    const aliceMember = members.find((m) => String(m.userId) === String(alice._id));
    const bobMember = members.find((m) => String(m.userId) === String(bob._id));
    assert.ok(aliceMember);
    assert.equal(aliceMember.role, 'leader');
    assert.ok(bobMember);
    assert.equal(bobMember.role, 'member');
  });

  it('global team directory is visible to all users and displays leader, member count, and project names', async () => {
    // Alice creates Phoenix with Bob
    await call('POST', '/api/projects', alice, {
      name: 'Phoenix',
      description: 'Project Phoenix',
      memberEmails: ['bob@example.com'],
    });

    // Charlie creates a separate project Titan
    const titanRes = await call('POST', '/api/projects', charlie, {
      name: 'Titan',
      description: 'Project Titan',
    });
    const titanId = titanRes.body.project.id;

    // Charlie queries global directory
    const dirRes = await call('GET', `/api/teams?directory=global&projectId=${titanId}`, charlie);
    assert.equal(dirRes.status, 200);
    const teams = dirRes.body.teams;
    assert.ok(teams.length >= 2, `expected at least 2 teams, got ${teams.length}`);

    const phoenixTeam = teams.find((t) => t.name === 'Phoenix Team');
    assert.ok(phoenixTeam, 'Charlie should see Phoenix Team in global directory');
    assert.equal(phoenixTeam.leaderName, 'Alice');
    assert.equal(phoenixTeam.memberCount, 2);
    assert.equal(phoenixTeam.projectCount, 1);
    assert.equal(phoenixTeam.hiddenProjectCount, 0);
    assert.deepEqual(phoenixTeam.projects.map((p) => p.name), ['Phoenix']);
    assert.equal(phoenixTeam.linked, false);

    // Charlie can add Phoenix Team members to Titan project
    const addRes = await call('POST', `/api/projects/${titanId}/teams/${phoenixTeam.id}/add-members`, charlie, {});
    assert.equal(addRes.status, 200);

    // Now Alice and Bob are eligible recipients for a handoff on Titan
    const recipRes = await call('GET', `/api/projects/${titanId}/teams/${phoenixTeam.id}/eligible-recipients`, charlie);
    assert.equal(recipRes.status, 200);
    const recips = recipRes.body.recipients;
    assert.deepEqual(recips.map((r) => r.name).sort(), ['Alice', 'Bob']);

    // Charlie creates handoff to Bob on Phoenix Team
    const handoffRes = await call('POST', `/api/projects/${titanId}/handoffs`, charlie, {
      toUserId: String(bob._id),
      toTeamId: phoenixTeam.id,
      reason: 'Handing off to Phoenix team expertise',
    });
    assert.equal(handoffRes.status, 201, JSON.stringify(handoffRes.body));
    assert.equal(handoffRes.body.handoff.toTeamId, phoenixTeam.id);
  });
});
