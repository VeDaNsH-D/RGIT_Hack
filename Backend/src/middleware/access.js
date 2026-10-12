import { Project } from '../models/Project.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { ROLE_RANK } from '../constants.js';

export async function getMembership(projectId, userId) {
  return ProjectMembership.findOne({ projectId, userId });
}

/**
 * Loads :id as req.project and the caller's membership as req.membership.
 * Non-members (and non-existent projects) both get 404, so project
 * existence is never leaked to someone who isn't on the project.
 */
export function attachProject() {
  return async (req, res, next) => {
    try {
      const project = await Project.findById(req.params.id);
      if (!project) {
        return res.status(404).json({ error: 'not_found', message: 'Project not found' });
      }
      const membership = await getMembership(project._id, req.user._id);
      if (!membership) {
        return res.status(404).json({ error: 'not_found', message: 'Project not found' });
      }
      req.project = project;
      req.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Same as attachProject(), but for routes keyed by a manual-note id
 * (/api/notes/:id) rather than a project id. Resolves the note's project
 * and applies the identical non-member-gets-404 rule.
 */
export function attachNoteProjectContext() {
  return async (req, res, next) => {
    try {
      const note = await SourceRecord.findById(req.params.id);
      if (!note || note.provider !== 'manual') {
        return res.status(404).json({ error: 'not_found', message: 'Note not found' });
      }
      const project = await Project.findById(note.projectId);
      if (!project) {
        return res.status(404).json({ error: 'not_found', message: 'Note not found' });
      }
      const membership = await getMembership(project._id, req.user._id);
      if (!membership) {
        return res.status(404).json({ error: 'not_found', message: 'Note not found' });
      }
      req.note = note;
      req.project = project;
      req.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Requires req.membership (set by attachProject/attachNoteProjectContext)
 * to be at least minRole. Membership presence is already enforced
 * upstream (404), so a role that's too low is a 403, not a 404.
 */
export function requireRole(minRole) {
  return (req, res, next) => {
    const rank = ROLE_RANK[req.membership?.role];
    if (rank === undefined || rank < ROLE_RANK[minRole]) {
      return res
        .status(403)
        .json({ error: 'forbidden', message: `Requires role '${minRole}' or higher` });
    }
    next();
  };
}
