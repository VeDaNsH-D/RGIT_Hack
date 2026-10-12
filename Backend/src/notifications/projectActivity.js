import { NotificationModel } from '../models/Notification.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { Project } from '../models/Project.js';
import { User } from '../models/User.js';
import mongoose from 'mongoose';
import { Handoff } from '../models/Handoff.js';
const actions = {
  INVITATION_ACCEPTED: ['Invitation accepted', 'accepted the invitation and joined the team'],
  INVITATION_SENT: ['Teammate invited', 'sent a teammate invitation'],
  INVITATION_REVOKED: ['Invitation cancelled', 'cancelled a teammate invitation'],
  PROJECT_UPDATED: ['Project updated', 'updated the project'],
  MEMBER_ADDED: ['Teammate added', 'added a teammate'],
  TASK_CREATED: ['New task', 'created a task'], TASK_UPDATED: ['Task updated', 'updated a task'],
  NOTE_CREATED: ['New project note', 'added a note'], NOTE_UPDATED: ['Note updated', 'updated a note'], NOTE_DELETED: ['Note removed', 'removed a note'],
  HANDOFF_CREATED: ['New handoff', 'created a handoff'], HANDOFF_UPDATED: ['Handoff updated', 'updated a handoff'],
  HANDOFF_SUBMITTED: ['Handoff submitted', 'submitted a handoff'], HANDOFF_ACKNOWLEDGED: ['Handoff accepted', 'accepted a handoff'],
  HANDOFF_CLARIFICATION_REQUESTED: ['Clarification requested', 'requested handoff clarification'], HANDOFF_CLARIFICATION_RESPONDED: ['Clarification answered', 'answered handoff clarification'],
  HANDOFF_EXCEPTION_ADDED: ['Handoff exception added', 'added a handoff exception'], HANDOFF_CANCELLED: ['Handoff cancelled', 'cancelled a handoff'],
  CONFLICT_DETECTED: ['Project conflict detected', 'detected a project conflict'], CONFLICT_REVIEWED: ['Conflict reviewed', 'reviewed a conflict'], CONFLICT_RESOLVED: ['Conflict resolved', 'resolved a conflict'],
  EMAIL_CONVERSATION_IMPORTED: ['Email imported', 'imported an email conversation'], EMAIL_WORKFLOW_PROPOSED: ['Workflow suggestions ready', 'generated workflow suggestions from email'],
  EMAIL_WORKFLOW_CHANGE_APPLIED: ['Workflow updated', 'applied an email workflow change'], EMAIL_PROPOSAL_DISMISSED: ['Suggestion dismissed', 'dismissed a workflow suggestion'],
  NOTION_PAGE_SYNCED: ['Notion page synced', 'synced a Notion page'], NOTION_DISCONNECTED: ['Notion disconnected', 'disconnected a Notion page'],
  DOCUMENT_UPLOADED: ['Document uploaded', 'uploaded a document'], DOCUMENT_REINDEXED: ['Document updated', 'reindexed a document'],
};
export async function notifyProjectActivity(event) {
  const presentation = actions[event?.action];
  if (!event?.projectId || !presentation || mongoose.connection.readyState !== 1) return;
  try {
    const dedicatedHandoffRecipient = { HANDOFF_SUBMITTED: 'toUserId', HANDOFF_ACKNOWLEDGED: 'fromUserId', HANDOFF_CLARIFICATION_REQUESTED: 'fromUserId', HANDOFF_CLARIFICATION_RESPONDED: 'toUserId' }[event.action];
    const [members, project, actor, handoff] = await Promise.all([
      ProjectMembership.find({ projectId: event.projectId }).select('userId').lean(),
      Project.findById(event.projectId).select('name ownerId').lean(),
      event.actorId ? User.findById(event.actorId).select('name').lean() : null,
      dedicatedHandoffRecipient && event.targetId ? Handoff.findById(event.targetId).select('fromUserId toUserId').lean() : null,
    ]);
    if (!project) return;
    // Existing domain notifications already cover the handoff recipient and resolved-conflict owner.
    const dedicatedRecipient = handoff?.[dedicatedHandoffRecipient] || (event.action === 'CONFLICT_RESOLVED' ? project.ownerId : null);
    const recipients = [...new Set(members.map(member => String(member.userId)))].filter(id => id !== String(event.actorId) && id !== String(dedicatedRecipient));
    if (!recipients.length) return;
    const [title, verb] = presentation;
    await NotificationModel.bulkWrite(recipients.map(recipientUserId => {
      const eventId = `activity:${event._id}:${recipientUserId}`;
      return { updateOne: { filter: { eventId }, update: { $setOnInsert: { id: eventId, eventId, recipientUserId, type: 'PROJECT_ACTIVITY', title, message: `${actor?.name || 'Your team'} ${verb} in ${project.name}.`, projectId: String(event.projectId), entityId: String(event.targetId || event.projectId), readAt: null, createdAt: new Date(event.occurredAt).toISOString(), deliveryStatus: 'SENT' } }, upsert: true } };
    }), { ordered: false });
  } catch (error) { console.warn('[in-app-notifications] Could not store project activity:', error.code || error.name); }
}
