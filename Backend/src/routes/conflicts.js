import { Router } from 'express';
import crypto from 'node:crypto';
import {
  createConflictSchema,
  conflictQuerySchema,
  reviewConflictSchema,
  resolveConflictSchema,
} from '../contracts/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, attachConflictProjectContext, requireRole } from '../middleware/access.js';
import { Conflict } from '../models/Conflict.js';
import { ConflictEvidence } from '../models/ConflictEvidence.js';
import { logActivity } from '../audit/service.js';
import { emitNotificationEvent } from '../notifications/emitEvent.js';
import { stableStringify } from '../audit/hash.js';

const router = Router();

function computeFingerprint(body) {
  const excerpts = body.evidence.map((e) => e.excerpt.trim()).sort();
  const data = stableStringify({ title: body.title.trim(), excerpts });
  return crypto.createHash('sha256').update(data).digest('hex');
}

function serializeConflict(conflict, evidence = []) {
  return {
    id: String(conflict._id),
    projectId: String(conflict.projectId),
    fingerprint: conflict.fingerprint,
    title: conflict.title,
    description: conflict.description,
    severity: conflict.severity,
    status: conflict.status,
    createdBy: conflict.createdBy ? String(conflict.createdBy) : null,
    resolutionNote: conflict.resolutionNote,
    resolvedBy: conflict.resolvedBy ? String(conflict.resolvedBy) : null,
    resolvedAt: conflict.resolvedAt,
    createdAt: conflict.createdAt,
    updatedAt: conflict.updatedAt,
    evidence: evidence.map((e) => ({
      id: String(e._id),
      sourceType: e.sourceType,
      sourceRecordId: e.sourceRecordId ? String(e.sourceRecordId) : null,
      documentId: e.documentId ? String(e.documentId) : null,
      excerpt: e.excerpt,
      url: e.url,
    })),
  };
}

router.post(
  '/projects/:id/conflicts',
  requireAuth,
  attachProject(),
  requireRole('member'),
  async (req, res, next) => {
    try {
      const body = createConflictSchema.parse(req.body);
      const fingerprint = body.fingerprint || computeFingerprint(body);

      let conflict;
      let deduped = false;
      try {
        conflict = await Conflict.create({
          projectId: req.project._id,
          fingerprint,
          title: body.title,
          description: body.description,
          severity: body.severity,
          createdBy: req.user._id,
        });
      } catch (err) {
        if (err.code === 11000) {
          conflict = await Conflict.findOne({ projectId: req.project._id, fingerprint });
          deduped = true;
        } else {
          throw err;
        }
      }

      let evidenceDocs;
      if (deduped) {
        evidenceDocs = await ConflictEvidence.find({ conflictId: conflict._id }).lean();
      } else {
        evidenceDocs = await ConflictEvidence.insertMany(
          body.evidence.map((e) => ({
            conflictId: conflict._id,
            projectId: req.project._id,
            sourceType: e.sourceType,
            sourceRecordId: e.sourceRecordId || null,
            documentId: e.documentId || null,
            excerpt: e.excerpt,
            url: e.url || '',
          }))
        );

        await logActivity({
          projectId: req.project._id,
          actorId: req.user._id,
          action: 'CONFLICT_DETECTED',
          targetType: 'Conflict',
          targetId: conflict._id,
          payload: { title: conflict.title, severity: conflict.severity, fingerprint },
        });

        if (conflict.severity === 'critical') {
          await emitNotificationEvent({
            type: 'CRITICAL_CONFLICT_DETECTED',
            projectId: req.project._id,
            recipientUserId: req.project.ownerId,
            dedupeKey: `conflict-critical-${conflict._id}`,
            payload: {
              entityId: String(conflict._id),
              conflictType: conflict.title,
              description: conflict.description || conflict.title,
              severity: conflict.severity,
            },
          });
        }
      }

      res.status(deduped ? 200 : 201).json({ conflict: serializeConflict(conflict, evidenceDocs), deduped });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

router.get('/projects/:id/conflicts', requireAuth, attachProject(), requireRole('viewer'), async (req, res, next) => {
  try {
    const query = conflictQuerySchema.parse(req.query);
    const filter = { projectId: req.project._id };
    if (query.status) filter.status = query.status;

    const conflicts = await Conflict.find(filter).sort({ createdAt: -1 }).lean();
    const evidenceByConflict = await ConflictEvidence.find({
      conflictId: { $in: conflicts.map((c) => c._id) },
    }).lean();

    const evidenceMap = new Map();
    for (const e of evidenceByConflict) {
      const key = String(e.conflictId);
      if (!evidenceMap.has(key)) evidenceMap.set(key, []);
      evidenceMap.get(key).push(e);
    }

    res.json({
      conflicts: conflicts.map((c) => serializeConflict(c, evidenceMap.get(String(c._id)) || [])),
    });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    next(err);
  }
});

router.post(
  '/conflicts/:id/review',
  requireAuth,
  attachConflictProjectContext(),
  requireRole('member'),
  async (req, res, next) => {
    try {
      reviewConflictSchema.parse(req.body);

      const updated = await Conflict.findOneAndUpdate(
        { _id: req.conflict._id, status: 'open' },
        { $set: { status: 'reviewed' } },
        { new: true }
      );
      if (!updated) {
        return res.status(409).json({ error: 'conflict', message: 'Conflict is not in a reviewable state' });
      }

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'CONFLICT_REVIEWED',
        targetType: 'Conflict',
        targetId: updated._id,
        payload: {},
      });

      const evidence = await ConflictEvidence.find({ conflictId: updated._id }).lean();
      res.json({ conflict: serializeConflict(updated, evidence) });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

router.post(
  '/conflicts/:id/resolve',
  requireAuth,
  attachConflictProjectContext(),
  requireRole('member'),
  async (req, res, next) => {
    try {
      const body = resolveConflictSchema.parse(req.body);

      const updated = await Conflict.findOneAndUpdate(
        { _id: req.conflict._id, status: { $in: ['open', 'reviewed'] } },
        {
          $set: {
            status: body.outcome,
            resolutionNote: body.note,
            resolvedBy: req.user._id,
            resolvedAt: new Date(),
          },
        },
        { new: true }
      );
      if (!updated) {
        return res.status(409).json({ error: 'conflict', message: 'Conflict is not in a resolvable state' });
      }

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'CONFLICT_RESOLVED',
        targetType: 'Conflict',
        targetId: updated._id,
        payload: { outcome: body.outcome, note: body.note },
      });

      await emitNotificationEvent({
        type: 'CONFLICT_RESOLVED',
        projectId: req.project._id,
        recipientUserId: req.project.ownerId,
        dedupeKey: `conflict-resolved-${updated._id}`,
        payload: { entityId: String(updated._id), outcome: body.outcome, note: body.note },
      });

      const evidence = await ConflictEvidence.find({ conflictId: updated._id }).lean();
      res.json({ conflict: serializeConflict(updated, evidence) });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

export default router;
