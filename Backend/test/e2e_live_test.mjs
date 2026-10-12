/**
 * @file e2e_live_test.mjs
 * @description End-to-end live integration test verifying Express, MongoDB Atlas, FastAPI, and Groq.
 */

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { User } from '../src/models/User.js';
import { Project } from '../src/models/Project.js';
import { ProjectMembership } from '../src/models/ProjectMembership.js';
import { Task } from '../src/models/Task.js';
import { Document } from '../src/models/Document.js';
import { SourceRecord } from '../src/models/SourceRecord.js';
import { signAuthToken } from '../src/middleware/auth.js';

const EXPRESS_BASE = `http://localhost:${config.port || 5001}`;
const FASTAPI_BASE = 'http://127.0.0.1:8001';

async function runE2ETest() {
  console.log('=== STARTING END-TO-END VERIFICATION ===\n');
  console.log(`Express Base URL: ${EXPRESS_BASE}`);
  console.log(`FastAPI Base URL: ${FASTAPI_BASE}`);

  // 1. Verify health of both services
  console.log('\n[1/6] Verifying service availability...');
  const fastApiHealthRes = await fetch(`${FASTAPI_BASE}/health`);
  const fastApiHealth = await fastApiHealthRes.json();
  console.log('FastAPI /health response:', fastApiHealth);
  if (fastApiHealthRes.status !== 200 || fastApiHealth.status !== 'healthy') {
    throw new Error(`FastAPI health check failed: status ${fastApiHealthRes.status}`);
  }

  const expressHealthRes = await fetch(`${EXPRESS_BASE}/api/health`);
  const expressHealth = await expressHealthRes.json();
  console.log('Express /api/health response:', expressHealth);
  if (expressHealthRes.status !== 200 || expressHealth.status !== 'ok') {
    throw new Error(`Express health check failed: status ${expressHealthRes.status}`);
  }

  // 2. Connect to MongoDB Atlas
  console.log('\n[2/6] Connecting to MongoDB Atlas...');
  await mongoose.connect(config.mongodbUri);
  console.log('MongoDB Atlas connected.');

  let testProject = null;
  let testMembership = null;
  let docWithText = null;
  let docEmpty = null;
  let sourcePr = null;
  let sourceDecision = null;
  let taskHigh = null;
  let taskLow = null;
  let unauthorizedUser = null;

  try {
    // 3. Setup test fixtures in MongoDB
    console.log('\n[3/6] Setting up live test fixtures in MongoDB Atlas...');
    const ownerUser = await User.findOne({ email: 'anandnisarg3441@gmail.com' });
    if (!ownerUser) {
      throw new Error('Default owner user not found in database');
    }

    // Create unauthorized non-member user
    unauthorizedUser = await User.create({
      name: 'Unauthorized E2E User',
      email: `unauthorized_${Date.now()}@example.com`,
      passwordHash: 'dummyhash',
      role: 'developer',
    });

    // Create test project
    testProject = await Project.create({
      name: 'E2E OAuth2 PKCE Handoff Project',
      description: 'Production migration of identity provider to OAuth2 PKCE authorization flow.',
      ownerId: ownerUser._id,
      createdBy: ownerUser._id,
      isDemo: false,
    });

    testMembership = await ProjectMembership.create({
      projectId: testProject._id,
      userId: ownerUser._id,
      role: 'owner',
      invitedBy: ownerUser._id,
    });

    // Create document with full extracted text
    docWithText = await Document.create({
      projectId: testProject._id,
      title: 'OAuth2 Security Baseline Specification',
      filename: 'oauth2-baseline-spec.pdf',
      mimeType: 'application/pdf',
      size: 15420,
      extractedText: 'All client authentication must use OAuth2 with PKCE code verification. Hard migration deadline is 2026-10-30T00:00:00Z. Legacy session tokens will be permanently disabled.',
      uploadedBy: ownerUser._id,
    });

    // Create document without extracted text (empty/missing)
    docEmpty = await Document.create({
      projectId: testProject._id,
      title: 'Architecture Diagram Attachment',
      filename: 'architecture-diagram.png',
      mimeType: 'image/png',
      size: 40210,
      extractedText: '',
      uploadedBy: ownerUser._id,
    });

    // Create ingested SourceRecord (GitHub PR)
    sourcePr = await SourceRecord.create({
      projectId: testProject._id,
      provider: 'github',
      externalId: `pr_e2e_${Date.now()}`,
      type: 'pull_request',
      title: 'PR #104: Implement PKCE Code Verifier Exchange',
      url: 'https://github.com/relay/repo/pull/104',
      content: 'Added SHA-256 PKCE code challenge verification on /oauth/token. Tested against mobile iOS and Android clients.',
      metadata: { author: 'dev-lead', fetchedAt: new Date().toISOString() },
    });

    // Create manual Decision SourceRecord
    sourceDecision = await SourceRecord.create({
      projectId: testProject._id,
      provider: 'manual',
      externalId: `decision_e2e_${Date.now()}`,
      type: 'decision',
      title: 'Architecture Decision: Enforce PKCE for All Clients',
      content: 'We decided to require PKCE for both public and confidential clients to eliminate secret storage vulnerabilities.',
      metadata: { author: 'lead-architect' },
    });

    // Create high-priority task with deadline and assignee
    taskHigh = await Task.create({
      projectId: testProject._id,
      title: 'Deploy PKCE authorization service to production',
      description: 'Roll out PKCE token gateway to production cluster behind feature flag.',
      origin: 'manual',
      assignee: ownerUser._id,
      deadline: new Date('2026-10-30T00:00:00Z'),
      priority: 'high',
      status: 'open',
      createdBy: ownerUser._id,
    });

    // Create low-priority task without deadline
    taskLow = await Task.create({
      projectId: testProject._id,
      title: 'Update telemetry dashboards for OAuth token exchange',
      description: 'Add Grafana metrics dashboard for token validation latency.',
      origin: 'manual',
      assignee: ownerUser._id,
      deadline: null,
      priority: 'low',
      status: 'open',
      createdBy: ownerUser._id,
    });

    console.log(`Fixtures created successfully for Project: ${testProject._id}`);

    const ownerToken = signAuthToken(ownerUser);
    const unauthorizedToken = signAuthToken(unauthorizedUser);

    // 4. Security & Access Control Tests
    console.log('\n[4/6] Testing Authentication & Authorization security controls...');

    // 4a. No token -> 401
    const noTokenRes = await fetch(`${EXPRESS_BASE}/api/projects/${testProject._id}/ai/generate-context`, {
      method: 'POST',
    });
    console.log(`4a. Missing token response: status ${noTokenRes.status} (expected 401)`);
    if (noTokenRes.status !== 401) throw new Error(`Expected 401 for missing token, got ${noTokenRes.status}`);

    // 4b. Unauthorized user (not a project member) -> 404 (does not leak project existence)
    const unauthorizedRes = await fetch(`${EXPRESS_BASE}/api/projects/${testProject._id}/ai/generate-context`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${unauthorizedToken}` },
    });
    console.log(`4b. Unauthorized non-member response: status ${unauthorizedRes.status} (expected 404)`);
    if (unauthorizedRes.status !== 404) throw new Error(`Expected 404 for unauthorized non-member, got ${unauthorizedRes.status}`);

    // 4c. Nonexistent project ID -> 404
    const fakeId = new mongoose.Types.ObjectId();
    const notFoundRes = await fetch(`${EXPRESS_BASE}/api/projects/${fakeId}/ai/generate-context`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    console.log(`4c. Nonexistent project response: status ${notFoundRes.status} (expected 404)`);
    if (notFoundRes.status !== 404) throw new Error(`Expected 404 for nonexistent project, got ${notFoundRes.status}`);

    // 5. Live End-to-End Context Generation Call
    console.log('\n[5/6] Executing live context generation: Express -> FastAPI -> Groq -> Express...');
    const startTime = Date.now();
    const generateRes = await fetch(`${EXPRESS_BASE}/api/projects/${testProject._id}/ai/generate-context`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
    });
    const durationMs = Date.now() - startTime;
    console.log(`Context generation completed in ${durationMs}ms with HTTP status ${generateRes.status}`);

    if (generateRes.status !== 200) {
      const errBody = await generateRes.text();
      throw new Error(`Context generation failed with status ${generateRes.status}: ${errBody}`);
    }

    const aiData = await generateRes.json();

    // 6. Inspect and Validate the AI Response
    console.log('\n[6/6] Validating AI response structure, evidence traceability, and citations...');
    console.log(`- case_id: ${aiData.case_id} (matches project: ${aiData.case_id === String(testProject._id)})`);
    console.log(`- summary: "${aiData.summary}"`);
    console.log(`- decisions count: ${aiData.decisions?.length || 0}`);
    console.log(`- attempted_actions count: ${aiData.attempted_actions?.length || 0}`);
    console.log(`- blockers count: ${aiData.blockers?.length || 0}`);
    console.log(`- proposed_tasks count: ${aiData.proposed_tasks?.length || 0}`);
    console.log(`- missing_information count: ${aiData.missing_information?.length || 0}`);
    console.log(`- contradictions count: ${aiData.contradictions?.length || 0}`);

    // Check case_id match
    if (aiData.case_id !== String(testProject._id)) {
      throw new Error(`case_id mismatch: expected ${testProject._id}, got ${aiData.case_id}`);
    }

    if (!aiData.summary || typeof aiData.summary !== 'string') {
      throw new Error('summary is missing or not a string');
    }

    // Verify all source_ids cited across decisions, attempted_actions, blockers, proposed_tasks, contradictions
    const validSourceIds = new Set([
      String(docWithText._id),
      String(docEmpty._id),
      String(sourcePr._id),
      String(sourcePr.externalId),
      String(sourceDecision._id),
      String(sourceDecision.externalId),
      String(taskHigh._id),
      String(taskLow._id),
    ]);

    const citedIds = [];
    (aiData.decisions || []).forEach((d) => (d.source_ids || []).forEach((id) => citedIds.push(id)));
    (aiData.attempted_actions || []).forEach((a) => (a.source_ids || []).forEach((id) => citedIds.push(id)));
    (aiData.blockers || []).forEach((b) => (b.source_ids || []).forEach((id) => citedIds.push(id)));
    (aiData.proposed_tasks || []).forEach((t) => (t.source_ids || []).forEach((id) => citedIds.push(id)));
    (aiData.contradictions || []).forEach((c) => (c.sources || []).forEach((s) => citedIds.push(s.source_id)));

    console.log(`Total source citations made by AI: ${citedIds.length}`);
    for (const citedId of citedIds) {
      if (!validSourceIds.has(citedId)) {
        throw new Error(`AI cited invalid or fabricated source ID: ${citedId}`);
      }
      console.log(`  -> Verified citation: ${citedId} maps to real record`);
    }

    // 7. Test Project Brief Endpoint ("Understand This Project")
    console.log('\n[7/8] Calling live Project Brief endpoint: POST /api/projects/:id/ai/brief...');
    const briefRes = await fetch(`${EXPRESS_BASE}/api/projects/${testProject._id}/ai/brief`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`Project Brief status: ${briefRes.status} (expected 200)`);
    if (briefRes.status !== 200) {
      const errText = await briefRes.text();
      console.log('Project Brief error response body:', errText);
      throw new Error(`Project Brief failed with status ${briefRes.status}: ${errText}`);
    }
    const briefData = await briefRes.json();
    console.log(`- Project Name: ${briefData.projectName}`);
    console.log(`- Overview: "${briefData.projectOverview.slice(0, 80)}..."`);
    console.log(`- Tech Stack: [${briefData.technologyStack.join(', ')}]`);
    console.log(`- Completed: ${briefData.completedWork.length}, Pending: ${briefData.pendingActions.length}, Blockers: ${briefData.blockers.length}`);
    assert.ok(briefData.projectId === String(testProject._id));
    assert.ok(Array.isArray(briefData.technologyStack));
    assert.ok(Array.isArray(briefData.evidenceReferences));

    // 8. Test Conflict Detection Endpoint
    console.log('\n[8/8] Calling live Conflict Detection endpoint: POST /api/projects/:id/conflicts/detect...');
    const conflictRes = await fetch(`${EXPRESS_BASE}/api/projects/${testProject._id}/conflicts/detect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`Conflict Detection status: ${conflictRes.status} (expected 200)`);
    if (conflictRes.status !== 200) {
      throw new Error(`Conflict Detection failed with status ${conflictRes.status}`);
    }
    const conflictData = await conflictRes.json();
    console.log(`- Initial Conflict Count: ${conflictData.conflictCount}`);
    console.log(`- Evaluated Facts: ${conflictData.evaluatedFactCount}`);
    assert.equal(conflictData.conflictCount, 0);

    // 8b. Add conflicting records to verify live detection of both categories
    console.log('\n[8b/8] Inserting conflicting records to verify deadline & status mismatch detection...');
    const conflictingRecord = await SourceRecord.create({
      projectId: testProject._id,
      provider: 'manual',
      externalId: `conflict_note_${Date.now()}`,
      type: 'note',
      title: 'DevOps Update on PKCE Deployment',
      content: 'Deploy PKCE authorization service to production is completed and merged. Final deadline rescheduled to 2026-11-15 due to infrastructure maintenance.',
      metadata: { author: 'devops-lead' },
    });

    const activeConflictRes = await fetch(`${EXPRESS_BASE}/api/projects/${testProject._id}/conflicts/detect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`Active Conflict Detection status: ${activeConflictRes.status}`);
    if (activeConflictRes.status !== 200) {
      throw new Error(`Active Conflict Detection failed: ${activeConflictRes.status}`);
    }
    const detected = await activeConflictRes.json();
    console.log(`- Detected Conflict Count: ${detected.conflictCount}`);
    console.log(`- Evaluated Facts: ${detected.evaluatedFactCount}`);

    const categories = detected.conflicts.map((c) => c.category);
    console.log(`- Detected Categories: [${categories.join(', ')}]`);
    assert.ok(categories.includes('deadline_mismatch'), 'Must detect deadline_mismatch');
    assert.ok(categories.includes('status_mismatch'), 'Must detect status_mismatch');

    // Verify both competing sources are preserved in evidence
    for (const c of detected.conflicts) {
      assert.ok(c.evidence.length >= 2, 'Candidate must preserve at least 2 competing evidence items');
      const sourceIds = c.evidence.map((e) => e.sourceRecordId || e.documentId).filter(Boolean);
      assert.ok(sourceIds.length >= 2, 'Candidate must preserve distinct source IDs');
      console.log(`  -> Confirmed candidate '${c.title}': sources [${sourceIds.join(', ')}]`);
    }

    // Verify conflict candidates are NOT automatically persisted to Conflict collection (lifecycle preserved)
    const { Conflict } = await import('../src/models/Conflict.js');
    const persistedConflicts = await Conflict.find({ projectId: testProject._id });
    console.log(`- Persisted conflicts in MongoDB: ${persistedConflicts.length} (expected 0, returned for review)`);
    assert.equal(persistedConflicts.length, 0, 'Candidates must not bypass review lifecycle');

    console.log('\n=== ALL END-TO-END VERIFICATION CHECKS PASSED SUCCESSFULLY ===');
    return { success: true, aiData, briefData, conflictData: detected, durationMs };
  } finally {
    // Cleanup fixtures
    console.log('\n[Cleanup] Cleaning up test records from MongoDB Atlas...');
    if (testProject) {
      await Project.deleteOne({ _id: testProject._id });
      await ProjectMembership.deleteMany({ projectId: testProject._id });
      await Document.deleteMany({ projectId: testProject._id });
      await SourceRecord.deleteMany({ projectId: testProject._id });
      await Task.deleteMany({ projectId: testProject._id });
    }
    if (unauthorizedUser) {
      await User.deleteOne({ _id: unauthorizedUser._id });
    }
    await mongoose.disconnect();
    console.log('MongoDB connection closed. Cleanup complete.');
  }
}

runE2ETest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nE2E VERIFICATION FAILED:', err);
    process.exit(1);
  });
