import { ProjectTeam } from '../models/ProjectTeam.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { TeamMembership } from '../models/TeamMembership.js';

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
