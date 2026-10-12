import mongoose from 'mongoose';
import { Project } from '../models/Project.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { Task } from '../models/Task.js';
import { Handoff } from '../models/Handoff.js';
import { Conflict } from '../models/Conflict.js';
import { ROLE_RANK } from '../constants.js';

export async function getMembership(projectId, userId) {
  return ProjectMembership.findOne({ projectId, userId });
}

/**
 * A malformed :id can never match a real document, so it's treated exactly
 * like "not found" (consistent with the non-member-gets-404 rule) rather
 * than a separate 400 shape. Without this check, Mongoose throws a
 * CastError on findById() that would otherwise surface as a bare 500.
 */
function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

/** Shared by the "resolve some entity's project, then check membership" middlewares below. */
async function resolveProjectAndMembership(projectId, userId) {
  const project = await Project.findById(projectId);
  if (!project) return null;
  const membership = await getMembership(project._id, userId);
  if (!membership) return null;
  return { project, membership };
}

/**
 * Loads :id as req.project and the caller's membership as req.membership.
 * Non-members (and non-existent projects) both get 404, so project
 * existence is never leaked to someone who isn't on the project.
 */
export function attachProject() {
  return async (req, res, next) => {
    try {
      if (!isValidId(req.params.id)) {
        return res.status(404).json({ error: 'not_found', message: 'Project not found' });
      }
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
      if (!isValidId(req.params.id)) {
        return res.status(404).json({ error: 'not_found', message: 'Note not found' });
      }
      const note = await SourceRecord.findById(req.params.id);
      if (!note || note.provider !== 'manual') {
        return res.status(404).json({ error: 'not_found', message: 'Note not found' });
      }
      const resolved = await resolveProjectAndMembership(note.projectId, req.user._id);
      if (!resolved) {
        return res.status(404).json({ error: 'not_found', message: 'Note not found' });
      }
      req.note = note;
      req.project = resolved.project;
      req.membership = resolved.membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Same pattern, for routes keyed by a task id (/api/tasks/:id).
 */
export function attachTaskProjectContext() {
  return async (req, res, next) => {
    try {
      if (!isValidId(req.params.id)) {
        return res.status(404).json({ error: 'not_found', message: 'Task not found' });
      }
      const task = await Task.findById(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'not_found', message: 'Task not found' });
      }
      const resolved = await resolveProjectAndMembership(task.projectId, req.user._id);
      if (!resolved) {
        return res.status(404).json({ error: 'not_found', message: 'Task not found' });
      }
      req.task = task;
      req.project = resolved.project;
      req.membership = resolved.membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Same pattern, for routes keyed by a handoff id (/api/handoffs/:id, ...).
 */
export function attachHandoffProjectContext() {
  return async (req, res, next) => {
    try {
      if (!isValidId(req.params.id)) {
        return res.status(404).json({ error: 'not_found', message: 'Handoff not found' });
      }
      const handoff = await Handoff.findById(req.params.id);
      if (!handoff) {
        return res.status(404).json({ error: 'not_found', message: 'Handoff not found' });
      }
      const resolved = await resolveProjectAndMembership(handoff.projectId, req.user._id);
      if (!resolved) {
        return res.status(404).json({ error: 'not_found', message: 'Handoff not found' });
      }
      req.handoff = handoff;
      req.project = resolved.project;
      req.membership = resolved.membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Same pattern, for routes keyed by a conflict id (/api/conflicts/:id, ...).
 */
export function attachConflictProjectContext() {
  return async (req, res, next) => {
    try {
      if (!isValidId(req.params.id)) {
        return res.status(404).json({ error: 'not_found', message: 'Conflict not found' });
      }
      const conflict = await Conflict.findById(req.params.id);
      if (!conflict) {
        return res.status(404).json({ error: 'not_found', message: 'Conflict not found' });
      }
      const resolved = await resolveProjectAndMembership(conflict.projectId, req.user._id);
      if (!resolved) {
        return res.status(404).json({ error: 'not_found', message: 'Conflict not found' });
      }
      req.conflict = conflict;
      req.project = resolved.project;
      req.membership = resolved.membership;
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
