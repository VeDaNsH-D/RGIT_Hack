import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { ProjectInvitation } from '../models/ProjectInvitation.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { ProjectOnboarding } from '../models/ProjectOnboarding.js';
import { Project } from '../models/Project.js';
import { User } from '../models/User.js';
import { config } from '../config.js';
import { logActivity } from '../audit/service.js';
import { ProjectTeam } from '../models/ProjectTeam.js';
import { TeamMembership } from '../models/TeamMembership.js';
import { invitationEmailConfigured, sendInvitationEmail } from '../services/invitationEmail.js';
import rateLimit from 'express-rate-limit';
const router = Router();
const hash = token => createHash('sha256').update(token).digest('hex');
const schema = z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()), role: z.enum(['member', 'viewer']).default('member') });
const handle = fn => async (req, res, next) => { try { res.set('Cache-Control', 'no-store'); await fn(req, res); } catch (error) { if (error.name === 'ZodError') return res.status(400).json({ message: 'Enter a valid email and teammate role.' }); next(error); } };
const owner = [requireAuth, attachProject(), requireRole('owner')];
const limit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many invitations. Please try again later.' } });
router.get('/projects/:id/invitations', ...owner, handle(async (req, res) => {
  const rows = await ProjectInvitation.find({ projectId: req.project._id, status: 'pending', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ configured: invitationEmailConfigured(), invitations: rows.map(row => ({ id: String(row._id), email: row.email, role: row.role, expiresAt: row.expiresAt })) });
}));
router.post('/projects/:id/invitations', ...owner, limit, handle(async (req, res) => {
  const body = schema.parse(req.body);
  if (!invitationEmailConfigured()) return res.status(503).json({ message: 'Invitation email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and INVITE_FROM_EMAIL on the backend.' });
  const user = await User.findOne({ email: body.email });
  if (user && await ProjectMembership.exists({ projectId: req.project._id, userId: user._id })) return res.status(409).json({ message: 'This person is already on the project team.' });
  const token = randomBytes(32).toString('hex');
  const invitation = await ProjectInvitation.create({ projectId: req.project._id, invitedBy: req.user._id, ...body, tokenHash: hash(token), expiresAt: new Date(Date.now() + 7 * 86400000) });
  const url = new URL('/invite', config.frontendUrl);
  url.hash = token;
  try { await sendInvitationEmail({ id: String(invitation._id), email: body.email, projectName: req.project.name, inviterName: req.user.name || 'Your teammate', url: url.toString() }); }
  catch (error) { await ProjectInvitation.updateOne({ _id: invitation._id }, { $set: { status: 'failed' } }); return res.status(error.status || 502).json({ message: error.message }); }
  await ProjectInvitation.updateOne({ _id: invitation._id }, { $set: { status: 'pending' } });
  await ProjectInvitation.updateMany({ _id: { $ne: invitation._id }, projectId: req.project._id, email: body.email, status: 'pending' }, { $set: { status: 'revoked' } });
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'INVITATION_SENT', targetType: 'ProjectInvitation', targetId: invitation._id, payload: body });
  res.status(201).json({ invitation: { id: String(invitation._id), email: body.email, role: body.role, expiresAt: invitation.expiresAt }, message: 'Invitation email sent. They will join after accepting.' });
}));
router.delete('/projects/:id/invitations/:inviteId', ...owner, handle(async (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.inviteId)) return res.status(400).json({ message: 'Invalid invitation.' });
  const result = await ProjectInvitation.updateOne({ _id: req.params.inviteId, projectId: req.project._id, status: 'pending' }, { $set: { status: 'revoked' } });
  if (result.modifiedCount) await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'INVITATION_REVOKED', targetType: 'ProjectInvitation', targetId: req.params.inviteId });
  res.json({ revoked: true });
}));
async function findInvite(req, res) {
  const token = req.body?.token;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) { res.status(404).json({ message: 'This invitation link is invalid.' }); return null; }
  const invitation = await ProjectInvitation.findOne({ tokenHash: hash(token) });
  const user = await User.findById(req.user._id);
  if (!user || user.disabled) { res.status(401).json({ message: 'Please sign in again.' }); return null; }
  if (!invitation || !['pending', 'accepted'].includes(invitation.status) || (invitation.status === 'pending' && invitation.expiresAt <= new Date())) { res.status(410).json({ message: 'This invitation expired or was cancelled. Ask the project owner for a new invitation.' }); return null; }
  if (user.email.toLowerCase() !== invitation.email || (invitation.acceptedBy && String(invitation.acceptedBy) !== String(user._id))) { res.status(403).json({ message: 'Sign in using the email address that received this invitation.' }); return null; }
  const project = await Project.findById(invitation.projectId);
  if (!project) { res.status(410).json({ message: 'This project is no longer available.' }); return null; }
  return { invitation, project, user };
}
router.post('/invitations/preview', requireAuth, handle(async (req, res) => {
  const found = await findInvite(req, res); if (!found) return;
  res.json({ project: { id: String(found.project._id), name: found.project.name }, email: found.invitation.email, role: found.invitation.role, status: found.invitation.status, expiresAt: found.invitation.expiresAt });
}));
router.post('/invitations/accept', requireAuth, handle(async (req, res) => {
  const found = await findInvite(req, res); if (!found) return;
  const { invitation, user, project } = found;
  const accepted = await ProjectInvitation.findOneAndUpdate({ _id: invitation._id, $or: [{ status: 'pending', expiresAt: { $gt: new Date() } }, { status: 'accepted', acceptedBy: user._id }] }, { $set: { status: 'accepted', acceptedBy: user._id, acceptedAt: invitation.acceptedAt || new Date() } }, { new: true });
  if (!accepted) return res.status(410).json({ message: 'This invitation is no longer available.' });
  // Insert only: an invite must never overwrite an existing member or owner role.
  await ProjectMembership.updateOne({ projectId: project._id, userId: user._id }, { $setOnInsert: { projectId: project._id, userId: user._id, role: invitation.role, invitedBy: invitation.invitedBy } }, { upsert: true });
  const projectTeam = project.owningTeamId
    ? await ProjectTeam.findById(project.owningTeamId)
    : await ProjectTeam.findOne({ projectIds: project._id, isActive: true });
  if (projectTeam) {
    await TeamMembership.findOneAndUpdate(
      { teamId: projectTeam._id, userId: user._id },
      { $set: { status: 'active' }, $setOnInsert: { role: 'member' } },
      { upsert: true }
    );
  }
  if (invitation.status !== 'accepted') await logActivity({ projectId: project._id, actorId: user._id, action: 'INVITATION_ACCEPTED', targetType: 'ProjectInvitation', targetId: invitation._id, payload: { role: invitation.role } });
  const onboarding = await ProjectOnboarding.findOneAndUpdate({ projectId: project._id, email: invitation.email.toLowerCase() }, { $set: { userId: user._id } }, { new: true });
  res.json({ projectId: String(project._id), accepted: true, onboardingId: onboarding ? String(onboarding._id) : null });
}));
export default router;
