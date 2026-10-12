import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo } from './harness.js';

let server, origin;
let ownerToken, memberToken, outsiderToken;
let projectId, otherProjectId;
let User, Project, ProjectMembership, ProjectOnboarding, Document, Task, SourceRecord;
let doc1Id, doc2Id, crossProjectDocId;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const urlStr = String(url);
  if (urlStr.includes('/api/v1/context-packs/generate')) {
    return new Response(JSON.stringify({
      case_id: 'mock-case',
      summary: 'Synthesized AI overview of the project and mission goals.',
      decisions: [
        { decision: 'Standardize on Node.js and MongoDB', rationale: 'High performance and developer velocity', source_ids: ['decision-1'], decided_at: new Date().toISOString() }
      ],
      attempted_actions: [
        { action: 'Initial cluster deployment', outcome: 'Succeeded with zero downtime', source_ids: [] }
      ],
      blockers: [],
      proposed_tasks: [
        { title: 'Set up staging environment', description: 'Configure staging cluster', priority: 'high', suggested_deadline: null, rationale: 'Testing prior to prod', source_ids: [] }
      ],
      missing_information: [],
      contradictions: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (urlStr.includes('/api/v1/project-brief/generate')) {
    return new Response(JSON.stringify({
      project_id: 'mock-case',
      project_name: 'Apollo Onboarding Project',
      project_overview: 'Autonomous mission planning and context platform.',
      technology_stack: ['Node.js', 'React', 'MongoDB'],
      current_status: 'Active',
      completed_work: ['Set up database clusters'],
      pending_actions: ['Configure production secrets'],
      blockers: [],
      recommended_next_steps: ['Review assigned documents', 'Verify cluster access'],
      missing_information: [],
      evidence_references: ['decision-1'],
      generated_at: new Date().toISOString()
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return originalFetch(url, opts);
};

const call = (path, method = 'GET', body, token = ownerToken) =>
  fetch(`${origin}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

before(async () => {
  await startMongo();

  ({ User } = await import('../../src/models/User.js'));
  ({ Project } = await import('../../src/models/Project.js'));
  ({ ProjectMembership } = await import('../../src/models/ProjectMembership.js'));
  ({ ProjectOnboarding } = await import('../../src/models/ProjectOnboarding.js'));
  ({ Document } = await import('../../src/models/Document.js'));
  ({ Task } = await import('../../src/models/Task.js'));
  ({ SourceRecord } = await import('../../src/models/SourceRecord.js'));

  const { signAuthToken } = await import('../../src/middleware/auth.js');

  const ownerUser = await User.create({ name: 'Owner User', email: 'owner@onboarding-test.com' });
  const memberUser = await User.create({ name: 'New Teammate', email: 'newteammate@onboarding-test.com' });
  const outsiderUser = await User.create({ name: 'Outsider User', email: 'outsider@onboarding-test.com' });

  ownerToken = signAuthToken(ownerUser);
  memberToken = signAuthToken(memberUser);
  outsiderToken = signAuthToken(outsiderUser);

  const { app } = await import('../../src/app.js');
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  origin = `http://127.0.0.1:${server.address().port}`;

  // Create Project 1 (Owned by ownerUser)
  const proj1 = await Project.create({
    name: 'Apollo Onboarding Project',
    description: 'Autonomous mission planning and context platform.',
    ownerId: ownerUser._id,
    createdBy: ownerUser._id,
  });
  projectId = String(proj1._id);

  await ProjectMembership.create({
    projectId: proj1._id,
    userId: ownerUser._id,
    role: 'owner',
    invitedBy: ownerUser._id,
  });

  // Create Project 2 for cross-project isolation tests
  const proj2 = await Project.create({
    name: 'Gemini Project',
    description: 'Unrelated project.',
    ownerId: outsiderUser._id,
    createdBy: outsiderUser._id,
  });
  otherProjectId = String(proj2._id);

  await ProjectMembership.create({
    projectId: proj2._id,
    userId: outsiderUser._id,
    role: 'owner',
    invitedBy: outsiderUser._id,
  });

  // Seed documents for Project 1
  const doc1 = await Document.create({
    projectId: proj1._id,
    title: 'Architecture Overview.pdf',
    filename: 'architecture.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    uploadedBy: ownerUser._id,
    status: 'indexed',
    extractedText: 'Apollo system is composed of an API gateway, auth module, and AI synthesis engine.',
  });
  doc1Id = String(doc1._id);

  const doc2 = await Document.create({
    projectId: proj1._id,
    title: 'Secret Internal Ops.docx',
    filename: 'secret_ops.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 2048,
    uploadedBy: ownerUser._id,
    status: 'indexed',
    extractedText: 'Internal operations runbook with private procedures.',
  });
  doc2Id = String(doc2._id);

  // Seed cross-project document in Project 2
  const crossDoc = await Document.create({
    projectId: proj2._id,
    title: 'Foreign Doc.pdf',
    filename: 'foreign.pdf',
    mimeType: 'application/pdf',
    size: 512,
    uploadedBy: outsiderUser._id,
    status: 'indexed',
    extractedText: 'Top secret foreign document.',
  });
  crossProjectDocId = String(crossDoc._id);

  // Seed tasks & source records for Project 1
  await Task.create({
    projectId: proj1._id,
    title: 'Configure production secrets',
    status: 'open',
    priority: 'high',
    createdBy: ownerUser._id,
  });

  await Task.create({
    projectId: proj1._id,
    title: 'Set up database clusters',
    status: 'completed',
    priority: 'critical',
    createdBy: ownerUser._id,
  });

  await SourceRecord.create({
    projectId: proj1._id,
    provider: 'manual',
    externalId: 'decision-1',
    type: 'decision',
    title: 'Use Node.js Express architecture',
    content: 'Selected Express for high throughput and modular route middleware.',
    metadata: { author: 'Owner User' },
  });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => server?.close(resolve));
  await stopMongo();
});

test('admin can create an onboarding assignment with selected documents', async () => {
  const res = await call(`/projects/${projectId}/onboarding`, 'POST', {
    email: 'newteammate@onboarding-test.com',
    role: 'member',
    selectedDocumentIds: [doc1Id],
    generateAiContext: true,
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.assignment.email, 'newteammate@onboarding-test.com');
  assert.equal(data.assignment.role, 'member');
  assert.equal(data.assignment.selectedDocumentCount, 1);
  assert.equal(data.assignment.status, 'ready');
  assert.ok(data.assignment.contextPack);
  assert.ok(data.assignment.contextPack.summary);
  assert.ok(data.assignment.contextPack.projectOverview);
  assert.ok(Array.isArray(data.assignment.contextPack.pendingTasks));
  assert.equal(data.assignment.contextPack.isDraft, true);
});

test('non-owner cannot create an onboarding assignment', async () => {
  const resOutsider = await call(`/projects/${projectId}/onboarding`, 'POST', {
    email: 'random@test.com',
    role: 'member',
    selectedDocumentIds: [doc1Id],
  }, outsiderToken);
  assert.equal(resOutsider.status, 404);

  const regularUser = await User.create({ name: 'Regular Member', email: 'regular@test.com' });
  const { signAuthToken } = await import('../../src/middleware/auth.js');
  const regMemberToken = signAuthToken(regularUser);
  await ProjectMembership.create({ projectId, userId: regularUser._id, role: 'member', invitedBy: regularUser._id });

  const resMember = await call(`/projects/${projectId}/onboarding`, 'POST', {
    email: 'random@test.com',
    role: 'member',
    selectedDocumentIds: [doc1Id],
  }, regMemberToken);
  assert.equal(resMember.status, 403);
});

test('cross-project document IDs are rejected with 400 validation error', async () => {
  const res = await call(`/projects/${projectId}/onboarding`, 'POST', {
    email: 'another@onboarding-test.com',
    role: 'member',
    selectedDocumentIds: [crossProjectDocId],
  });

  assert.equal(res.status, 400);
  const err = await res.json();
  assert.match(err.message, /One or more selected documents do not belong to this project/);
});

test('duplicate active onboarding assignment for same email is rejected with 409', async () => {
  const res = await call(`/projects/${projectId}/onboarding`, 'POST', {
    email: 'newteammate@onboarding-test.com',
    role: 'member',
    selectedDocumentIds: [doc1Id],
  });

  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error, 'duplicate_onboarding');
});

test('new member can retrieve their onboarding assignment via /me', async () => {
  // First add member to membership as viewer
  const user = await User.findOne({ email: 'newteammate@onboarding-test.com' });
  await ProjectMembership.create({
    projectId,
    userId: user._id,
    role: 'member',
    invitedBy: user._id,
  });

  const res = await call(`/projects/${projectId}/onboarding/me`, 'GET', undefined, memberToken);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.assignment.email, 'newteammate@onboarding-test.com');
  assert.equal(data.assignment.role, 'member');
  assert.ok(Array.isArray(data.assignment.selectedDocuments));
});

test('outsider cannot retrieve another project onboarding assignment', async () => {
  const onboarding = await ProjectOnboarding.findOne({ projectId, email: 'newteammate@onboarding-test.com' });
  const res = await call(`/projects/${projectId}/onboarding/${onboarding._id}`, 'GET', undefined, outsiderToken);
  assert.ok([403, 404].includes(res.status));
});

test('member can only retrieve documents selected for their onboarding', async () => {
  const onboarding = await ProjectOnboarding.findOne({ projectId, email: 'newteammate@onboarding-test.com' });
  const res = await call(`/projects/${projectId}/onboarding/${onboarding._id}/documents`, 'GET', undefined, memberToken);

  assert.equal(res.status, 200);
  const data = await res.json();
  // Only doc1Id was selected; doc2Id was not
  assert.equal(data.documents.length, 1);
  assert.equal(data.documents[0].id, doc1Id);
  assert.equal(data.documents.some((d) => d.id === doc2Id), false);
});

test('member previewing unassigned document returns 403 Forbidden', async () => {
  const onboarding = await ProjectOnboarding.findOne({ projectId, email: 'newteammate@onboarding-test.com' });
  // doc2Id is a project document, but not in onboarding assignment
  const res = await call(`/projects/${projectId}/onboarding/${onboarding._id}/documents/${doc2Id}/preview`, 'GET', undefined, memberToken);
  assert.equal(res.status, 403);
});

test('member can preview authorized assigned document', async () => {
  const onboarding = await ProjectOnboarding.findOne({ projectId, email: 'newteammate@onboarding-test.com' });
  const res = await call(`/projects/${projectId}/onboarding/${onboarding._id}/documents/${doc1Id}/preview`, 'GET', undefined, memberToken);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.id, doc1Id);
  assert.match(data.text, /Apollo system/);
});

test('member can record section review acknowledgements', async () => {
  const onboarding = await ProjectOnboarding.findOne({ projectId, email: 'newteammate@onboarding-test.com' });
  const res = await call(`/projects/${projectId}/onboarding/${onboarding._id}/review`, 'POST', {
    section: 'project_overview',
    documentId: doc1Id,
  }, memberToken);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.reviewedSections.includes('project_overview'));
  assert.ok(data.reviewedDocumentIds.includes(doc1Id));
  assert.equal(data.status, 'in_progress');
});

test('admin can update document selection and regenerate context', async () => {
  const onboarding = await ProjectOnboarding.findOne({ projectId, email: 'newteammate@onboarding-test.com' });

  // Update document selection to include doc1 and doc2
  const patchRes = await call(`/projects/${projectId}/onboarding/${onboarding._id}`, 'PATCH', {
    selectedDocumentIds: [doc1Id, doc2Id],
    notes: 'Please review both architectural and operational guidelines.',
  });
  assert.equal(patchRes.status, 200);

  // Regenerate context
  const regenRes = await call(`/projects/${projectId}/onboarding/${onboarding._id}/generate-context`, 'POST', {});
  assert.equal(regenRes.status, 200);
  const data = await regenRes.json();
  assert.equal(data.assignment.contextVersion, 2);
  assert.equal(data.assignment.selectedDocumentCount, 2);
});

test('member can complete onboarding workflow', async () => {
  const onboarding = await ProjectOnboarding.findOne({ projectId, email: 'newteammate@onboarding-test.com' });
  const res = await call(`/projects/${projectId}/onboarding/${onboarding._id}/complete`, 'POST', {}, memberToken);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.assignment.status, 'completed');
  assert.ok(data.assignment.completedAt);

  const updatedInDb = await ProjectOnboarding.findById(onboarding._id);
  assert.equal(updatedInDb.status, 'completed');
  assert.ok(updatedInDb.completedAt);
});

test('removed member cannot access onboarding after removal', async () => {
  const user = await User.findOne({ email: 'newteammate@onboarding-test.com' });
  const onboarding = await ProjectOnboarding.findOne({ projectId, email: 'newteammate@onboarding-test.com' });

  // Remove membership from project
  await ProjectMembership.deleteOne({ projectId, userId: user._id });

  const res = await call(`/projects/${projectId}/onboarding/${onboarding._id}`, 'GET', undefined, memberToken);
  assert.ok([403, 404].includes(res.status));
});
