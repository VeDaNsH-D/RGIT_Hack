/**
 * One-off helper: gives every existing project that has no team a "Team N" made of its owner (leader) and members.
 *
 *   node scripts/backfill-teams.js            # dry run, prints what would be created
 *   node scripts/backfill-teams.js --apply    # creates the teams
 *
 * Projects that already have a team are left alone, and the script is safe to re-run.
 */
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { Project } from '../src/models/Project.js';
import { ProjectMembership } from '../src/models/ProjectMembership.js';
import { ProjectTeam } from '../src/models/ProjectTeam.js';
import { TeamMembership } from '../src/models/TeamMembership.js';
import { linkLegacyTeams } from '../src/teams/legacy.js';

const apply = process.argv.includes('--apply');
await mongoose.connect(config.mongodbUri);
let created = 0;
for (const project of await Project.find({}).select('name ownerId createdBy').lean()) {
  await linkLegacyTeams(project._id);
  const existing = await ProjectTeam.find({ projectIds: project._id }).select('name').lean();
  if (existing.length) continue;
  const rows = await ProjectMembership.find({ projectId: project._id, role: { $in: ['owner', 'member'] } }).lean();
  const leaderId = String(project.ownerId);
  const memberIds = [...new Set([leaderId, ...rows.map((row) => String(row.userId))])];
  console.log(`${apply ? 'Creating' : 'Would create'} “Team 1” for ${project.name} (${memberIds.length} people)`);
  if (!apply) continue;
  const team = await ProjectTeam.create({ projectIds: [project._id], name: 'Team 1', description: `Formed from the members of ${project.name}`, leaderId, createdBy: project.ownerId });
  await TeamMembership.insertMany(memberIds.map((userId) => ({ teamId: team._id, userId, role: userId === leaderId ? 'leader' : 'member' })));
  created += 1;
}
console.log(apply ? `Created ${created} team(s).` : 'Dry run only. Re-run with --apply to create them.');
await mongoose.disconnect();
