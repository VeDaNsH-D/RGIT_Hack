import { Router } from 'express';
import crypto from 'node:crypto';
import { CreateNoteBody, updateNoteSchema, noteQuerySchema } from '../contracts/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, attachNoteProjectContext, requireRole } from '../middleware/access.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { logActivity } from '../audit/service.js';

const router = Router();

function serializeNote(note) {
  return {
    id: String(note._id),
    projectId: String(note.projectId),
    recordType: note.type,
    title: note.title,
    content: note.content,
    url: note.url,
    author: note.metadata?.author || null,
    authorId: note.metadata?.authorId ? String(note.metadata.authorId) : null,
    observedAt: note.metadata?.observedAt || null,
    fetchedAt: note.metadata?.fetchedAt || null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

router.post(
  '/projects/:id/notes',
  requireAuth,
  attachProject(),
  requireRole('member'),
  async (req, res, next) => {
    try {
      const body = CreateNoteBody.parse(req.body);
      // Manual records are never upserted/looked-up by externalId, so this
      // is just a unique placeholder to satisfy SourceRecord's
      // (projectId, provider, externalId) unique index.
      const externalId = crypto.randomUUID();

      const note = await SourceRecord.create({
        projectId: req.project._id,
        provider: 'manual',
        externalId,
        type: body.recordType,
        title: body.title,
        content: body.content,
        url: body.url || '',
        metadata: {
          author: req.user.name,
          authorId: req.user._id,
          observedAt: body.observedAt || null,
          fetchedAt: new Date(),
        },
      });

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'NOTE_CREATED',
        targetType: 'SourceRecord',
        targetId: note._id,
        payload: { recordType: body.recordType, title: body.title },
      });

      res.status(201).json({ note: serializeNote(note) });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

router.get(
  '/projects/:id/notes',
  requireAuth,
  attachProject(),
  requireRole('viewer'),
  async (req, res, next) => {
    try {
      const query = noteQuerySchema.parse(req.query);
      const filter = { projectId: req.project._id, provider: 'manual' };
      if (query.recordType) filter.type = query.recordType;

      const skip = (query.page - 1) * query.limit;
      const [items, total] = await Promise.all([
        SourceRecord.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
        SourceRecord.countDocuments(filter),
      ]);

      res.json({ notes: items.map(serializeNote), total, page: query.page, limit: query.limit });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

function canModifyNote(req) {
  const isAuthor = req.note.metadata?.authorId && String(req.note.metadata.authorId) === String(req.user._id);
  const isOwner = String(req.project.ownerId) === String(req.user._id);
  return isAuthor || isOwner;
}

router.patch('/notes/:id', requireAuth, attachNoteProjectContext(), async (req, res, next) => {
  try {
    if (!canModifyNote(req)) {
      return res
        .status(403)
        .json({ error: 'forbidden', message: 'Only the original author or the project owner can modify this note' });
    }

    const body = updateNoteSchema.parse(req.body);
    if (body.title !== undefined) req.note.title = body.title;
    if (body.content !== undefined) req.note.content = body.content;
    if (body.url !== undefined) req.note.url = body.url;
    if (body.observedAt !== undefined) {
      req.note.metadata = { ...req.note.metadata, observedAt: body.observedAt };
    }
    await req.note.save();

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'NOTE_UPDATED',
      targetType: 'SourceRecord',
      targetId: req.note._id,
      payload: { recordType: req.note.type, title: req.note.title },
    });

    res.json({ note: serializeNote(req.note) });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    next(err);
  }
});

router.delete('/notes/:id', requireAuth, attachNoteProjectContext(), async (req, res, next) => {
  try {
    if (!canModifyNote(req)) {
      return res
        .status(403)
        .json({ error: 'forbidden', message: 'Only the original author or the project owner can delete this note' });
    }

    const { recordType, title } = { recordType: req.note.type, title: req.note.title };
    await SourceRecord.deleteOne({ _id: req.note._id });

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'NOTE_DELETED',
      targetType: 'SourceRecord',
      targetId: req.note._id,
      payload: { recordType, title },
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
