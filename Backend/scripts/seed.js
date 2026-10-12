import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectDB } from '../src/db.js';
import { User } from '../src/models/User.js';
import { Project } from '../src/models/Project.js';
import { ProjectMembership } from '../src/models/ProjectMembership.js';
import { Task } from '../src/models/Task.js';
import { SourceConnection } from '../src/models/SourceConnection.js';
import { SourceRecord } from '../src/models/SourceRecord.js';
import { Conflict } from '../src/models/Conflict.js';
import { ConflictEvidence } from '../src/models/ConflictEvidence.js';
import { Handoff } from '../src/models/Handoff.js';

/**
 * Seeds the "Project Atlas" demo: a fictional payment-processing service
 * handoff scenario. Every record this script creates is either flagged
 * isDemo: true (on models that support it) or has "(Demo)" in its title —
 * no real/live data is ever created here. Safe to re-run: it deletes any
 * previous Atlas demo project (and everything scoped to it) before
 * recreating it; the two demo users are upserted by email so their ids
 * (and any JWTs issued for them) stay stable across re-seeds.
 */

const DEMO_PASSWORD = 'AtlasDemo123!';

async function upsertDemoUser(email, name) {
  const existing = await User.findOne({ email });
  if (existing) return existing;
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  return User.create({ email, name, passwordHash });
}

async function wipePreviousAtlasDemo() {
  const existing = await Project.findOne({ name: 'Project Atlas', isDemo: true });
  if (!existing) return;

  const projectId = existing._id;
  const conflicts = await Conflict.find({ projectId }).select('_id').lean();
  await ConflictEvidence.deleteMany({ conflictId: { $in: conflicts.map((c) => c._id) } });
  await Conflict.deleteMany({ projectId });
  await Handoff.deleteMany({ projectId });
  await Task.deleteMany({ projectId });
  await SourceRecord.deleteMany({ projectId });
  await SourceConnection.deleteMany({ projectId });
  await ProjectMembership.deleteMany({ projectId });
  await Project.deleteOne({ _id: projectId });
}

async function seed() {
  await connectDB();
  await wipePreviousAtlasDemo();

  const alex = await upsertDemoUser('alex@atlas-demo.example', 'Alex Morgan (Demo)');
  const priya = await upsertDemoUser('priya@atlas-demo.example', 'Priya Shah (Demo)');

  const project = await Project.create({
    name: 'Project Atlas',
    description: '(Demo) Payment processing service — handoff demo scenario for Relay.',
    ownerId: alex._id,
    createdBy: alex._id,
    isDemo: true,
  });

  await ProjectMembership.create({ projectId: project._id, userId: alex._id, role: 'owner', invitedBy: alex._id });
  await ProjectMembership.create({ projectId: project._id, userId: priya._id, role: 'member', invitedBy: alex._id });

  // Tasks: includes one unassigned task and one high-priority task with no
  // deadline, per the spec, so a fresh handoff attempt is blocked by the
  // completeness checks out of the box.
  await Task.create([
    {
      projectId: project._id,
      title: '(Demo) Rotate payment gateway API keys',
      description: 'Quarterly key rotation for the gateway integration.',
      origin: 'manual',
      assignee: alex._id,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      priority: 'medium',
      createdBy: alex._id,
    },
    {
      projectId: project._id,
      title: '(Demo) Investigate duplicate charge reports',
      description: 'No owner assigned yet — needs triage.',
      origin: 'manual',
      assignee: null,
      priority: 'medium',
      createdBy: alex._id,
    },
    {
      projectId: project._id,
      title: '(Demo) Patch PCI compliance gap in logging',
      description: 'High priority, deadline not yet set — flagged by completeness check.',
      origin: 'manual',
      assignee: alex._id,
      deadline: null,
      priority: 'high',
      createdBy: alex._id,
    },
  ]);

  const sourceConnection = await SourceConnection.create({
    projectId: project._id,
    provider: 'github',
    config: { repo: 'atlas-demo/payments-service' },
    connectedBy: alex._id,
    isDemo: true,
  });

  await SourceRecord.create([
    {
      projectId: project._id,
      provider: 'github',
      externalId: 'demo-pr-101',
      type: 'pull_request',
      title: '(Demo) Add retry logic for gateway timeouts',
      url: 'https://github.com/atlas-demo/payments-service/pull/101',
      content: '(Demo content) Adds exponential backoff around the gateway client.',
      isDemo: true,
    },
    {
      projectId: project._id,
      provider: 'github',
      externalId: 'demo-commit-9f2a',
      type: 'commit',
      title: '(Demo) Fix rounding error in currency conversion',
      url: 'https://github.com/atlas-demo/payments-service/commit/9f2a',
      content: '(Demo content) Corrects a float rounding bug affecting JPY conversions.',
      isDemo: true,
    },
  ]);
  void sourceConnection;

  // A conflict with two pieces of evidence, so the demo also shows the
  // completeness check blocking on unresolved critical conflicts.
  const conflict = await Conflict.create({
    projectId: project._id,
    fingerprint: 'demo-atlas-deploy-freeze-conflict',
    title: '(Demo) Conflicting deploy-freeze dates',
    description: 'One doc says the freeze starts March 1, another says March 15.',
    severity: 'critical',
    status: 'open',
    createdBy: alex._id,
  });
  await ConflictEvidence.create([
    {
      conflictId: conflict._id,
      projectId: project._id,
      sourceType: 'document',
      excerpt: '(Demo) Release runbook: "Freeze begins March 1."',
    },
    {
      conflictId: conflict._id,
      projectId: project._id,
      sourceType: 'document',
      excerpt: '(Demo) Compliance calendar: "Freeze begins March 15."',
    },
  ]);

  console.log('Seeded Project Atlas demo data:');
  console.log(`  Project: ${project.name} (${project._id})`);
  console.log(`  Outgoing owner: ${alex.email} / password: ${DEMO_PASSWORD}`);
  console.log(`  Incoming owner: ${priya.email} / password: ${DEMO_PASSWORD}`);
  console.log(`  Open conflict: ${conflict.title} (${conflict._id})`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
