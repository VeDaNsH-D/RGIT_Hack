import { Router } from 'express';
import {
  createHandoffSchema,
  updateHandoffSchema,
  exceptionSchema,
  clarificationNoteSchema,
  rejectHandoffSchema,
} from '../contracts/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, attachHandoffProjectContext, requireRole } from '../middleware/access.js';
import { Handoff } from '../models/Handoff.js';
import { Project } from '../models/Project.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { User } from '../models/User.js';
import { ProjectTeam } from '../models/ProjectTeam.js';
import { TeamMembership } from '../models/TeamMembership.js';
import { withTx } from '../db.js';
import { logActivity, listActivity } from '../audit/service.js';
import { emitNotificationEvent } from '../notifications/emitEvent.js';
import { applyEvent, ERROR_CODES } from '../handoffs/lifecycle.js';
import { assertItemSourceRecordsBelongToProject, ItemReferenceError } from '../handoffs/itemRefs.js';
import { DraftError, generateHandoffDraft } from '../services/handoffDraftService.js';
import { AiServiceError } from '../services/aiClient.js';
import { runValidation } from '../handoffs/service.js';
import { RoutingError, resolveRouting, assertDocumentsInProject, buildContextSnapshot, isContextStale } from '../handoffs/teamRouting.js';
import { HANDOFF_OPEN_STATES, NON_WAIVABLE_CHECKS } from '../constants.js';

const router = Router();

function serializeHandoff(h) {
  return {
    id: String(h._id),
    projectId: String(h.projectId),
    fromUserId: String(h.fromUserId),
    toUserId: String(h.toUserId),
    transferType: h.transferType || 'individual',
    fromTeamId: h.fromTeamId ? String(h.fromTeamId) : null,
    toTeamId: h.toTeamId ? String(h.toTeamId) : null,
    reason: h.reason || '',
    instructions: h.instructions || '',
    contextSnapshot: h.contextSnapshot ?? null,
    rejectedAt: h.rejectedAt || null,
    rejectionReason: h.rejectionReason || '',
    state: h.state,
    isOpen: h.isOpen,
    currentStatus: h.currentStatus,
    items: (h.items || []).map((i) => ({
      type: i.type,
      text: i.text,
      relatedTaskId: i.relatedTaskId ? String(i.relatedTaskId) : null,
      sourceRecordId: i.sourceRecordId ? String(i.sourceRecordId) : null,
    })),
    noPendingActionsConfirmed: h.noPendingActionsConfirmed,
    aiDraft: h.aiDraft ?? null,
    supportingLinks: h.supportingLinks,
    documentIds: (h.documentIds || []).map(String),
    exceptions: (h.exceptions || []).map((e) => ({
      checkName: e.checkName,
      reason: e.reason,
      recordedBy: String(e.recordedBy),
      recordedAt: e.recordedAt,
    })),
    lastValidation: h.lastValidation || null,
    clarifications: (h.clarifications || []).map((c) => ({
      type: c.type,
      author: String(c.author),
      note: c.note,
      createdAt: c.createdAt,
    })),
    submittedAt: h.submittedAt,
    acknowledgedAt: h.acknowledgedAt,
    version: h.version,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

function resolveActorRole(handoff, userId) {
  if (String(handoff.fromUserId) === String(userId)) return 'outgoing';
  if (String(handoff.toUserId) === String(userId)) return 'incoming';
  return null;
}

/** Maps a thrown LifecycleError to an HTTP response. Returns true if handled. */
function mapLifecycleError(err, res) {
  if (!err || err.name !== 'LifecycleError') return false;
  if (err.code === ERROR_CODES.WRONG_ACTOR) {
    res.status(403).json({ error: 'wrong_actor', message: err.message });
    return true;
  }
  // ILLEGAL_TRANSITION and TERMINAL_STATE are both "this can't happen from
  // here right now" — a conflict with current state, not a bad request.
  res.status(409).json({ error: 'illegal_transition', message: err.message });
  return true;
}

router.post(
  '/projects/:id/handoffs',
  requireAuth,
  attachProject(),
  requireRole('owner'),
  async (req, res, next) => {
    try {
      // requireRole('owner') checks membership rank; the OWNERSHIP RULE
      // requires the actual current project.ownerId, which is the real
      // source of truth and should always match but is checked explicitly.
      if (String(req.project.ownerId) !== String(req.user._id)) {
        return res
          .status(403)
          .json({ error: 'forbidden', message: 'Only the current project owner can create a handoff' });
      }

      const body = createHandoffSchema.parse(req.body);
      if (String(body.toUserId) === String(req.user._id)) {
        return res
          .status(400)
          .json({ error: 'validation_error', message: 'toUserId must be different from the current owner' });
      }
      const toUser = await User.findById(body.toUserId);
      if (!toUser) {
        return res.status(400).json({ error: 'validation_error', message: 'toUserId does not reference an existing user' });
      }

      let routing;
      try {
        routing = await resolveRouting(req.project, { toUserId: body.toUserId, toTeamId: body.toTeamId, linkAs: req.user._id });
        if (routing.linked) {
          await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'TEAM_LINKED', targetType: 'ProjectTeam', targetId: routing.toTeamId, payload: { name: routing.linked, via: 'handoff' } });
          delete routing.linked;
        }
      } catch (err) {
        if (err instanceof RoutingError) return res.status(err.status).json({ error: err.code, message: err.message });
        throw err;
      }

      let handoff;
      try {
        handoff = await Handoff.create({
          projectId: req.project._id,
          fromUserId: req.user._id,
          toUserId: body.toUserId,
          ...routing,
          reason: body.reason || '',
          instructions: body.instructions || '',
          state: 'DRAFT',
          isOpen: true,
        });
      } catch (err) {
        if (err.code === 11000) {
          return res
            .status(409)
            .json({ error: 'conflict', message: 'An open handoff already exists for this project' });
        }
        throw err;
      }

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'HANDOFF_CREATED',
        targetType: 'Handoff',
        targetId: handoff._id,
        payload: { toUserId: String(body.toUserId), transferType: routing.transferType, fromTeamId: routing.fromTeamId, toTeamId: routing.toTeamId, reason: body.reason || '' },
      });

      res.status(201).json({ handoff: serializeHandoff(handoff) });
    } catch (err) {
      if (err.name === 'ZodError') return res.status(400).json({ error: 'validation_error', message: err.message });
      next(err);
    }
  }
);

router.get('/projects/:id/handoffs', requireAuth, attachProject(), requireRole('viewer'), async (req, res, next) => {
  try {
    const handoffs = await Handoff.find({ projectId: req.project._id }).sort({ createdAt: -1 }).lean();
    res.json({ handoffs: handoffs.map(serializeHandoff) });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/handoffs/:id',
  requireAuth,
  attachHandoffProjectContext(),
  requireRole('viewer'),
  async (req, res, next) => {
    try {
      const teamIds = [req.handoff.fromTeamId, req.handoff.toTeamId].filter(Boolean);
      const [teams, contextStale] = await Promise.all([
        teamIds.length ? ProjectTeam.find({ _id: { $in: teamIds } }).select('name').lean() : [],
        req.handoff.state === 'SUBMITTED' ? isContextStale(req.project, req.handoff) : false,
      ]);
      const name = (id) => teams.find((team) => String(team._id) === String(id))?.name || null;
      res.json({
        handoff: serializeHandoff(req.handoff),
        fromTeam: req.handoff.fromTeamId ? { id: String(req.handoff.fromTeamId), name: name(req.handoff.fromTeamId) } : null,
        toTeam: req.handoff.toTeamId ? { id: String(req.handoff.toTeamId), name: name(req.handoff.toTeamId) } : null,
        contextStale,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.patch('/handoffs/:id', requireAuth, attachHandoffProjectContext(), async (req, res, next) => {
  try {
    if (String(req.handoff.fromUserId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'forbidden', message: 'Only the outgoing owner can edit this handoff' });
    }
    if (!['DRAFT', 'EDITING'].includes(req.handoff.state)) {
      return res
        .status(409)
        .json({ error: 'illegal_transition', message: `Cannot edit a handoff in state ${req.handoff.state}` });
    }

    const body = updateHandoffSchema.parse(req.body);
    if (body.items) {
      await assertItemSourceRecordsBelongToProject(req.project._id, body.items);
    }
    if (body.documentIds) await assertDocumentsInProject(req.project._id, body.documentIds);

    const update = {};
    if (body.currentStatus !== undefined) update.currentStatus = body.currentStatus;
    if (body.items !== undefined) update.items = body.items;
    if (body.noPendingActionsConfirmed !== undefined) update.noPendingActionsConfirmed = body.noPendingActionsConfirmed;
    if (body.supportingLinks !== undefined) update.supportingLinks = body.supportingLinks;
    if (body.documentIds !== undefined) update.documentIds = body.documentIds;
    if (body.reason !== undefined) update.reason = body.reason;
    if (body.instructions !== undefined) update.instructions = body.instructions;

    const updated = await Handoff.findOneAndUpdate(
      { _id: req.handoff._id, state: { $in: ['DRAFT', 'EDITING'] } },
      { $set: update, $inc: { version: 1 } },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ error: 'conflict', message: 'Handoff state changed concurrently' });
    }

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'HANDOFF_UPDATED',
      targetType: 'Handoff',
      targetId: updated._id,
      payload: { fields: Object.keys(update) },
    });

    res.json({ handoff: serializeHandoff(updated) });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'validation_error', message: err.message });
    if (err instanceof ItemReferenceError) return res.status(400).json({ error: err.code, message: err.message });
    if (err instanceof RoutingError) return res.status(err.status).json({ error: err.code, message: err.message });
    next(err);
  }
});

/**
 * Generates a source-grounded draft for review. Only the outgoing owner of an editable handoff may do this.
 * The draft is stored in handoff.aiDraft; items/currentStatus change only when the user applies and saves it.
 */
router.post('/handoffs/:id/ai-draft', requireAuth, attachHandoffProjectContext(), async (req, res, next) => {
  try {
    if (String(req.handoff.fromUserId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'forbidden', message: 'Only the outgoing owner can draft this handoff' });
    }
    if (!['DRAFT', 'EDITING'].includes(req.handoff.state)) {
      return res.status(409).json({ error: 'illegal_transition', message: `Cannot draft a handoff in state ${req.handoff.state}` });
    }
    const draft = await generateHandoffDraft(req.project);
    const updated = await Handoff.findOneAndUpdate(
      { _id: req.handoff._id, state: { $in: ['DRAFT', 'EDITING'] } },
      { $set: { aiDraft: { ...draft, generatedBy: String(req.user._id) } } },
      { new: true }
    );
    if (!updated) return res.status(409).json({ error: 'conflict', message: 'Handoff state changed concurrently' });
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'HANDOFF_AI_DRAFT_GENERATED', targetType: 'Handoff', targetId: updated._id, payload: { items: draft.items.length } });
    res.json({ handoff: serializeHandoff(updated) });
  } catch (err) {
    if (err instanceof DraftError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof AiServiceError) return res.status(err.status || 502).json({ error: err.code || 'ai_service_error', message: err.message });
    next(err);
  }
});

router.post('/handoffs/:id/validate', requireAuth, attachHandoffProjectContext(), async (req, res, next) => {
  try {
    if (String(req.handoff.fromUserId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'forbidden', message: 'Only the outgoing owner can validate this handoff' });
    }

    const result = await runValidation(req.project, req.handoff);
    req.handoff.lastValidation = { ...result, validatedAt: new Date() };
    await req.handoff.save();

    res.json({ validation: result });
  } catch (err) {
    next(err);
  }
});

router.post('/handoffs/:id/exceptions', requireAuth, attachHandoffProjectContext(), async (req, res, next) => {
  try {
    if (String(req.handoff.fromUserId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'forbidden', message: 'Only the outgoing owner can add an exception' });
    }
    if (!['DRAFT', 'EDITING'].includes(req.handoff.state)) {
      return res
        .status(409)
        .json({ error: 'illegal_transition', message: `Cannot add an exception in state ${req.handoff.state}` });
    }

    const body = exceptionSchema.parse(req.body);
    if (NON_WAIVABLE_CHECKS.includes(body.checkName)) {
      return res.status(400).json({ error: 'validation_error', message: `'${body.checkName}' can never be waived` });
    }

    const result = await runValidation(req.project, req.handoff);
    const check = result.checks.find((c) => c.name === body.checkName);
    if (!check || check.passed) {
      return res
        .status(400)
        .json({ error: 'validation_error', message: `'${body.checkName}' is not currently a failing check` });
    }

    req.handoff.exceptions.push({
      checkName: body.checkName,
      reason: body.reason,
      recordedBy: req.user._id,
      recordedAt: new Date(),
    });
    req.handoff.version += 1;
    await req.handoff.save();

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'HANDOFF_EXCEPTION_ADDED',
      targetType: 'Handoff',
      targetId: req.handoff._id,
      payload: { checkName: body.checkName, reason: body.reason },
    });

    res.status(201).json({ handoff: serializeHandoff(req.handoff) });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'validation_error', message: err.message });
    next(err);
  }
});

router.post('/handoffs/:id/submit', requireAuth, attachHandoffProjectContext(), async (req, res, next) => {
  try {
    const actorRole = resolveActorRole(req.handoff, req.user._id);
    if (actorRole !== 'outgoing') {
      return res.status(403).json({ error: 'forbidden', message: 'Only the outgoing owner can submit this handoff' });
    }

    // Never trust a client-provided "ready" flag — always re-run
    // validation against live DB state server-side.
    const result = await runValidation(req.project, req.handoff);

    // Team-routed handoffs must still point at a valid destination when they are submitted.
    if (req.handoff.toTeamId) {
      try {
        await resolveRouting(req.project, { toUserId: req.handoff.toUserId, toTeamId: req.handoff.toTeamId });
        if (!req.handoff.reason) throw new RoutingError('A transfer reason is required before submitting a team handoff');
        await assertDocumentsInProject(req.project._id, (req.handoff.documentIds || []).map(String));
      } catch (err) {
        if (err instanceof RoutingError) return res.status(err.status).json({ error: err.code, message: err.message });
        throw err;
      }
    }

    let nextState;
    try {
      ({ state: nextState } = applyEvent({
        state: req.handoff.state,
        event: 'SUBMIT',
        actorRole,
        validationReady: result.ready,
      }));
    } catch (err) {
      if (mapLifecycleError(err, res)) return;
      throw err;
    }

    const now = new Date();
    const setFields = { lastValidation: { ...result, validatedAt: now }, state: nextState };
    let snapshot = null;
    if (nextState === 'SUBMITTED') {
      setFields.submittedAt = now;
      setFields.ackReminderSentAt = null;
      snapshot = await buildContextSnapshot(req.project, req.handoff, result);
      setFields.contextSnapshot = snapshot;
    }

    const updated = await Handoff.findOneAndUpdate(
      { _id: req.handoff._id, state: req.handoff.state },
      {
        $set: setFields,
        $inc: { version: 1 },
        ...(snapshot && req.handoff.contextSnapshot
          ? { $push: { contextSnapshotHistory: { hash: req.handoff.contextSnapshot.hash, capturedAt: req.handoff.contextSnapshot.capturedAt, handoffVersion: req.handoff.contextSnapshot.handoffVersion } } }
          : {}),
      },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ error: 'conflict', message: 'Handoff state changed concurrently' });
    }

    if (nextState === 'SUBMITTED') {
      // Give the recipient read access to the project context immediately,
      // without downgrading them if they already hold a higher role.
      await ProjectMembership.findOneAndUpdate(
        { projectId: req.project._id, userId: updated.toUserId },
        { $setOnInsert: { role: 'viewer', invitedBy: req.user._id } },
        { upsert: true }
      );

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'HANDOFF_SUBMITTED',
        targetType: 'Handoff',
        targetId: updated._id,
        payload: { score: result.score, transferType: updated.transferType, toTeamId: updated.toTeamId ? String(updated.toTeamId) : null },
      });
      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'HANDOFF_CONTEXT_SNAPSHOT',
        targetType: 'Handoff',
        targetId: updated._id,
        payload: { hash: snapshot.hash, handoffVersion: snapshot.handoffVersion },
      });

      await emitNotificationEvent({
        type: 'HANDOFF_SUBMITTED',
        projectId: req.project._id,
        recipientUserId: updated.toUserId,
        dedupeKey: `handoff-submitted-${updated._id}-${updated.version}`,
        payload: {
          entityId: String(updated._id),
          outgoingUserId: String(updated.fromUserId),
          handoffTitle: req.project.name,
        },
      });
    } else {
      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'HANDOFF_SUBMIT_BLOCKED',
        targetType: 'Handoff',
        targetId: updated._id,
        payload: { score: result.score, missingFields: result.missingFields },
      });
    }

    res.json({ handoff: serializeHandoff(updated), validation: result });
  } catch (err) {
    next(err);
  }
});

router.post('/handoffs/:id/acknowledge', requireAuth, attachHandoffProjectContext(), async (req, res, next) => {
  try {
    const actorRole = resolveActorRole(req.handoff, req.user._id);
    if (actorRole !== 'incoming') {
      return res.status(403).json({ error: 'forbidden', message: 'Only the incoming owner can acknowledge this handoff' });
    }

    try {
      applyEvent({ state: req.handoff.state, event: 'ACKNOWLEDGE', actorRole });
    } catch (err) {
      if (mapLifecycleError(err, res)) return;
      throw err;
    }

    const now = new Date();
    const handoffId = req.handoff._id;
    const fromUserId = req.handoff.fromUserId;
    const toUserId = req.handoff.toUserId;
    const projectId = req.project._id;
    const toTeamId = req.handoff.toTeamId || null;

    // Revalidate the destination at the moment of acceptance: the team may have been deactivated or the
    // recipient may have left the team/project while the request was waiting.
    if (toTeamId) {
      try {
        await resolveRouting(req.project, { toUserId, toTeamId });
      } catch (err) {
        if (err instanceof RoutingError) return res.status(409).json({ error: 'conflict', message: `Cannot accept: ${err.message}` });
        throw err;
      }
    }

    let conflict = false;

    try {
      await withTx(async (session) => {
        const opts = session ? { session } : {};

        const updatedHandoff = await Handoff.findOneAndUpdate(
          { _id: handoffId, state: 'SUBMITTED' },
          { $set: { state: 'ACKNOWLEDGED', isOpen: false, acknowledgedAt: now }, $inc: { version: 1 } },
          { new: true, ...opts }
        );
        if (!updatedHandoff) {
          conflict = true;
          throw new Error('ABORT_ACK_CONFLICT');
        }

        // Accountability guard: the outgoing owner must still actually be
        // the project owner right now (OWNERSHIP RULE — they stay
        // accountable until this exact moment).
        const project = await Project.findOne({ _id: projectId, ownerId: fromUserId }, null, opts);
        if (!project) {
          conflict = true;
          throw new Error('ABORT_ACK_CONFLICT');
        }

        const fromTeamId = project.owningTeamId || null;
        project.ownerId = toUserId;
        if (toTeamId) project.owningTeamId = toTeamId;
        project.ownershipHistory.push({
          fromUserId, toUserId, handoffId, changedAt: now,
          fromTeamId, toTeamId: toTeamId || fromTeamId,
          reason: updatedHandoff.reason || '',
          initiatedBy: fromUserId, acceptedBy: toUserId,
        });
        await project.save(opts);

        // Open tasks deliberately keep their current assignees — nothing
        // to do here.
        await ProjectMembership.findOneAndUpdate(
          { projectId, userId: fromUserId },
          { $set: { role: 'member' } },
          opts
        );
        await ProjectMembership.findOneAndUpdate(
          { projectId, userId: toUserId },
          { $set: { role: 'owner' }, $setOnInsert: { invitedBy: fromUserId } },
          { upsert: true, ...opts }
        );
      });
    } catch (err) {
      if (err.message !== 'ABORT_ACK_CONFLICT') throw err;
    }

    if (conflict) {
      return res
        .status(409)
        .json({ error: 'conflict', message: 'Handoff could not be acknowledged (already processed, or ownership changed)' });
    }

    // Audit only after the transaction has committed.
    await logActivity({
      projectId,
      actorId: req.user._id,
      action: 'HANDOFF_ACKNOWLEDGED',
      targetType: 'Handoff',
      targetId: handoffId,
      payload: {},
    });
    await logActivity({
      projectId,
      actorId: req.user._id,
      action: 'OWNERSHIP_TRANSFERRED',
      targetType: 'Handoff',
      targetId: handoffId,
      payload: { fromUserId: String(fromUserId), toUserId: String(toUserId), toTeamId: toTeamId ? String(toTeamId) : null, transferType: req.handoff.transferType },
    });

    await emitNotificationEvent({
      type: 'HANDOFF_ACKNOWLEDGED',
      projectId,
      recipientUserId: fromUserId,
      dedupeKey: `handoff-acknowledged-${handoffId}`,
      payload: { entityId: String(handoffId), acceptedByUserId: String(toUserId) },
    });

    const refreshed = await Handoff.findById(handoffId);
    res.json({ handoff: serializeHandoff(refreshed) });
  } catch (err) {
    next(err);
  }
});

router.post('/handoffs/:id/clarify', requireAuth, attachHandoffProjectContext(), async (req, res, next) => {
  try {
    const actorRole = resolveActorRole(req.handoff, req.user._id);
    if (actorRole !== 'incoming') {
      return res.status(403).json({ error: 'forbidden', message: 'Only the incoming owner can request clarification' });
    }

    try {
      applyEvent({ state: req.handoff.state, event: 'REQUEST_CLARIFICATION', actorRole });
    } catch (err) {
      if (mapLifecycleError(err, res)) return;
      throw err;
    }

    const body = clarificationNoteSchema.parse(req.body);
    const now = new Date();

    const updated = await Handoff.findOneAndUpdate(
      { _id: req.handoff._id, state: 'SUBMITTED' },
      {
        $set: { state: 'CLARIFICATION_REQUESTED' },
        $inc: { version: 1 },
        $push: { clarifications: { type: 'request', author: req.user._id, note: body.note, createdAt: now } },
      },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ error: 'conflict', message: 'Handoff state changed concurrently' });
    }

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'HANDOFF_CLARIFICATION_REQUESTED',
      targetType: 'Handoff',
      targetId: updated._id,
      payload: { note: body.note },
    });

    await emitNotificationEvent({
      type: 'HANDOFF_NEEDS_CLARIFICATION',
      projectId: req.project._id,
      recipientUserId: updated.fromUserId,
      dedupeKey: `handoff-clarify-${updated._id}-${updated.version}`,
      payload: {
        entityId: String(updated._id),
        requestedByUserId: String(req.user._id),
        clarificationNote: body.note,
      },
    });

    res.json({ handoff: serializeHandoff(updated) });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'validation_error', message: err.message });
    next(err);
  }
});

router.post('/handoffs/:id/respond', requireAuth, attachHandoffProjectContext(), async (req, res, next) => {
  try {
    const actorRole = resolveActorRole(req.handoff, req.user._id);
    if (actorRole !== 'outgoing') {
      return res
        .status(403)
        .json({ error: 'forbidden', message: 'Only the outgoing owner can respond to a clarification request' });
    }

    try {
      applyEvent({ state: req.handoff.state, event: 'RESPOND', actorRole });
    } catch (err) {
      if (mapLifecycleError(err, res)) return;
      throw err;
    }

    const body = clarificationNoteSchema.parse(req.body);
    const now = new Date();

    const updated = await Handoff.findOneAndUpdate(
      { _id: req.handoff._id, state: 'CLARIFICATION_REQUESTED' },
      {
        $set: { state: 'EDITING' },
        $inc: { version: 1 },
        $push: { clarifications: { type: 'response', author: req.user._id, note: body.note, createdAt: now } },
      },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ error: 'conflict', message: 'Handoff state changed concurrently' });
    }

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'HANDOFF_CLARIFICATION_RESPONDED',
      targetType: 'Handoff',
      targetId: updated._id,
      payload: { note: body.note },
    });

    await emitNotificationEvent({
      type: 'HANDOFF_CLARIFICATION_ANSWERED',
      projectId: req.project._id,
      recipientUserId: updated.toUserId,
      dedupeKey: `handoff-respond-${updated._id}-${updated.version}`,
      payload: { entityId: String(updated._id), answeredByUserId: String(req.user._id), note: body.note },
    });

    res.json({ handoff: serializeHandoff(updated) });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'validation_error', message: err.message });
    next(err);
  }
});

router.post('/handoffs/:id/reject', requireAuth, attachHandoffProjectContext(), async (req, res, next) => {
  try {
    const actorRole = resolveActorRole(req.handoff, req.user._id);
    if (actorRole !== 'incoming') {
      return res.status(403).json({ error: 'forbidden', message: 'Only the incoming owner can reject this handoff' });
    }

    try {
      applyEvent({ state: req.handoff.state, event: 'REJECT', actorRole });
    } catch (err) {
      if (mapLifecycleError(err, res)) return;
      throw err;
    }

    const body = rejectHandoffSchema.parse(req.body);
    const now = new Date();

    // Ownership is untouched on rejection: the project owner, owning team and history stay exactly as they were.
    const updated = await Handoff.findOneAndUpdate(
      { _id: req.handoff._id, state: 'SUBMITTED' },
      { $set: { state: 'REJECTED', isOpen: false, rejectedAt: now, rejectionReason: body.reason }, $inc: { version: 1 } },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ error: 'conflict', message: 'Handoff state changed concurrently' });
    }

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'HANDOFF_REJECTED',
      targetType: 'Handoff',
      targetId: updated._id,
      payload: { reason: body.reason },
    });

    await emitNotificationEvent({
      type: 'HANDOFF_REJECTED',
      projectId: req.project._id,
      recipientUserId: updated.fromUserId,
      dedupeKey: `handoff-rejected-${updated._id}`,
      payload: { entityId: String(updated._id), rejectedByUserId: String(req.user._id), rejectionReason: body.reason },
    });

    res.json({ handoff: serializeHandoff(updated) });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'validation_error', message: err.message });
    next(err);
  }
});

router.post('/handoffs/:id/cancel', requireAuth, attachHandoffProjectContext(), async (req, res, next) => {
  try {
    const actorRole = resolveActorRole(req.handoff, req.user._id);
    if (actorRole !== 'outgoing') {
      return res.status(403).json({ error: 'forbidden', message: 'Only the outgoing owner can cancel this handoff' });
    }

    try {
      applyEvent({ state: req.handoff.state, event: 'CANCEL', actorRole });
    } catch (err) {
      if (mapLifecycleError(err, res)) return;
      throw err;
    }

    const updated = await Handoff.findOneAndUpdate(
      { _id: req.handoff._id, state: { $in: HANDOFF_OPEN_STATES } },
      { $set: { state: 'CANCELLED', isOpen: false }, $inc: { version: 1 } },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ error: 'conflict', message: 'Handoff state changed concurrently' });
    }

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'HANDOFF_CANCELLED',
      targetType: 'Handoff',
      targetId: updated._id,
      payload: {},
    });

    res.json({ handoff: serializeHandoff(updated) });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/handoffs/:id/activity',
  requireAuth,
  attachHandoffProjectContext(),
  requireRole('viewer'),
  async (req, res, next) => {
    try {
      const events = await listActivity(String(req.project._id), { limit: 1000 });
      const related = events.filter(
        (e) => e.targetType === 'Handoff' && String(e.targetId) === String(req.handoff._id)
      );
      res.json({
        activity: related.map((e) => ({
          id: String(e._id),
          action: e.action,
          actorId: e.actorId ? String(e.actorId) : null,
          actorType: e.actorType,
          payload: e.payload,
          occurredAt: e.occurredAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
