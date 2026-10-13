import { ProjectTeam } from '../models/ProjectTeam.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { TeamMembership } from '../models/TeamMembership.js';
import { Project } from '../models/Project.js';

let indexCleanup = null;

/**
 * Teams used to be unique per project through a partial unique index on (projectId, name). Shared teams have no single
 * projectId, so that index would reject a second "Team 1". Drop it once per process; uniqueness is now checked per project in code.
 */
function dropLegacyIndex() {
  indexCleanup ||= ProjectTeam.collection.dropIndex('projectId_1_name_1').catch(() => {});
  return indexCleanup;
}

/** Teams created before sharing existed carry a single `projectId`; fold it into `projectIds` the first time the project is touched. */
export async function linkLegacyTeams(projectId) {
  await dropLegacyIndex();
  await ProjectTeam.updateMany({ projectId, projectIds: { $ne: projectId } }, { $addToSet: { projectIds: projectId } });
}

/** Teams a person can discover: ones on projects they belong to, plus ones they lead, belong to or created. */
export async function discoverableTeamFilter(userId) {
  const [projects, mine] = await Promise.all([
    ProjectMembership.find({ userId }).select('projectId').lean(),
    TeamMembership.find({ userId, status: 'active' }).select('teamId').lean(),
  ]);
  return { $or: [
    { projectIds: { $in: projects.map((row) => row.projectId) } },
    { projectId: { $in: projects.map((row) => row.projectId) } },
    { _id: { $in: mine.map((row) => row.teamId) } },
    { createdBy: userId },
  ] };
}

/** Ensures every project with an owner and members has a corresponding team in the team directory. */
export async function ensureProjectTeams(projectId = null) {
  const query = projectId ? { _id: projectId } : {};
  const projects = await Project.find(query).lean();
  for (const project of projects) {
    const existingTeam = await ProjectTeam.findOne({
      $or: [{ projectIds: project._id }, ...(project.owningTeamId ? [{ _id: project.owningTeamId }] : [])],
      isActive: true,
    });
    if (!existingTeam) {
      const memberships = await ProjectMembership.find({
        projectId: project._id,
        role: { $in: ['owner', 'member'] },
      }).lean();
      const leaderId = project.ownerId || memberships.find((m) => m.role === 'owner')?.userId;
      if (!leaderId) continue;

      let name = `${project.name} Team`;
      if (await ProjectTeam.exists({ name, isActive: true })) {
        let n = 2;
        while (await ProjectTeam.exists({ name: `${project.name} Team ${n}`, isActive: true })) n += 1;
        name = `${project.name} Team ${n}`;
      }

      const created = await ProjectTeam.create({
        projectIds: [project._id],
        name,
        description: `Team for ${project.name}`,
        leaderId,
        createdBy: leaderId,
        isActive: true,
      });

      await Project.updateOne({ _id: project._id }, { $set: { owningTeamId: created._id } });

      const memberIds = [...new Set([String(leaderId), ...memberships.map((m) => String(m.userId))])];
      for (const uid of memberIds) {
        await TeamMembership.findOneAndUpdate(
          { teamId: created._id, userId: uid },
          { $set: { status: 'active', role: uid === String(leaderId) ? 'leader' : 'member' } },
          { upsert: true }
        );
      }
    } else {
      if (!project.owningTeamId) {
        await Project.updateOne({ _id: project._id }, { $set: { owningTeamId: existingTeam._id } });
      }
      const memberships = await ProjectMembership.find({
        projectId: project._id,
        role: { $in: ['owner', 'member'] },
      }).lean();
      for (const m of memberships) {
        const uid = String(m.userId);
        const isLeader = uid === String(existingTeam.leaderId);
        await TeamMembership.findOneAndUpdate(
          { teamId: existingTeam._id, userId: uid },
          { $set: { status: 'active' }, $setOnInsert: { role: isLeader ? 'leader' : 'member' } },
          { upsert: true }
        );
      }
    }
  }
}

