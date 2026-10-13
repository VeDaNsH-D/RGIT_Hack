import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { ProjectOnboarding } from '../models/ProjectOnboarding.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { ProjectInvitation } from '../models/ProjectInvitation.js';
import { Document } from '../models/Document.js';
import { User } from '../models/User.js';
import { config } from '../config.js';
import { logActivity } from '../audit/service.js';
import { createLocalDocumentStorage } from '../modules/ingestion/documents/index.js';
import { generateOnboardingContextPack } from '../services/onboardingService.js';
import { invitationEmailConfigured, sendInvitationEmail } from '../services/invitationEmail.js';
import {
  createOnboardingSchema,
  updateOnboardingSchema,
  reviewOnboardingSchema,
} from '../contracts/schemas.js';

const router = Router();
const hash = (token) => createHash('sha256').update(token).digest('hex');

const PREVIEW_CHARS = 20000;

function safeFilename(name) {
  return String(name || 'document').replace(/[\r\n"]/g, '_');
}

function getStorage() {
  return createLocalDocumentStorage(config.documents.storageDir ? { rootDir: config.documents.storageDir } : {});
}

/**
 * Helper to verify authorization on an onboarding assignment.
 * Returns the assignment if authorized, or sends error response and returns null.
 */
async function loadAuthorizedOnboarding(req, res) {
  const { onboardingId } = req.params;
  if (!/^[a-f0-9]{24}$/i.test(onboardingId)) {
    res.status(400).json({ error: 'validation_error', message: 'Invalid onboarding ID.' });
    return null;
  }

  const assignment = await ProjectOnboarding.findOne({
    _id: onboardingId,
    projectId: req.project._id,
  });

  if (!assignment) {
    res.status(404).json({ error: 'not_found', message: 'Onboarding assignment not found.' });
    return null;
  }

  const isOwner = req.membership?.role === 'owner';
  const userEmail = (req.user?.email || '').toLowerCase();
  const isAssigned = (assignment.userId && String(assignment.userId) === String(req.user._id)) ||
    (assignment.email && assignment.email.toLowerCase() === userEmail);

  if (!isOwner && !isAssigned) {
    res.status(403).json({ error: 'forbidden', message: 'You are not authorized to view this onboarding assignment.' });
    return null;
  }

  return assignment;
}

/**
 * POST /api/projects/:id/onboarding
 * Create an onboarding assignment for a teammate.
 */
router.post(
  '/:id/onboarding',
  requireAuth,
  attachProject(),
  requireRole('owner'),
  async (req, res, next) => {
    try {
      const body = createOnboardingSchema.parse(req.body);
      const email = body.email.toLowerCase();

      // Validate selected documents belong to this project
      const docIds = body.selectedDocumentIds || [];
      if (docIds.length > 0) {
        const matchingCount = await Document.countDocuments({
          _id: { $in: docIds },
          projectId: req.project._id,
        });
        if (matchingCount !== docIds.length) {
          return res.status(400).json({
            error: 'validation_error',
            message: 'One or more selected documents do not belong to this project.',
          });
        }
      }

      // Check for active duplicate onboarding assignment
      const existing = await ProjectOnboarding.findOne({
        projectId: req.project._id,
        email,
      });

      if (existing && existing.status !== 'completed') {
        return res.status(409).json({
          error: 'duplicate_onboarding',
          message: `An active onboarding assignment already exists for ${email}.`,
          onboardingId: String(existing._id),
        });
      }

      // Check if user account already exists
      const user = await User.findOne({ email });

      // Generate AI context pack
      let contextPack = null;
      let contextGenerationStatus = 'ready';
      let contextGenerationError = null;

      if (body.generateAiContext) {
        try {
          contextPack = await generateOnboardingContextPack({
            projectId: req.project._id,
            selectedDocumentIds: docIds,
          });
        } catch (genErr) {
          console.warn('[onboarding] context generation failed:', genErr.message);
          contextGenerationStatus = 'failed';
          contextGenerationError = genErr.message;
        }
      }

      // Handle invitation if requested and user is not yet an active member
      let invitationId = null;
      const isAlreadyMember = user && (await ProjectMembership.exists({ projectId: req.project._id, userId: user._id }));

      if (body.sendInvitation && !isAlreadyMember && invitationEmailConfigured()) {
        try {
          const token = randomBytes(32).toString('hex');
          const invitation = await ProjectInvitation.create({
            projectId: req.project._id,
            invitedBy: req.user._id,
            email,
            role: body.role,
            tokenHash: hash(token),
            expiresAt: new Date(Date.now() + 7 * 86400000),
          });
          invitationId = invitation._id;

          const url = new URL('/invite', config.frontendUrl || 'http://localhost:5173');
          url.hash = token;

          await sendInvitationEmail({
            id: String(invitation._id),
            email,
            projectName: req.project.name,
            inviterName: req.user.name || 'Your team admin',
            url: url.toString(),
          });
          await ProjectInvitation.updateOne({ _id: invitation._id }, { $set: { status: 'pending' } });
        } catch (inviteErr) {
          console.warn('[onboarding] invitation send failure:', inviteErr.message);
        }
      }

      // If user is already on the project, link membership userId immediately
      const userId = user ? user._id : null;

      const assignment = await ProjectOnboarding.findOneAndUpdate(
        { projectId: req.project._id, email },
        {
          $set: {
            projectId: req.project._id,
            userId,
            email,
            role: body.role,
            assignedBy: req.user._id,
            invitationId,
            selectedDocumentIds: docIds,
            status: 'ready',
            contextVersion: 1,
            contextGeneratedAt: new Date(),
            contextGenerationStatus,
            contextGenerationError,
            contextPack,
            reviewedSections: [],
            reviewedDocumentIds: [],
            completedAt: null,
            completedBy: null,
          },
        },
        { upsert: true, new: true }
      );

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'ONBOARDING_ASSIGNMENT_CREATED',
        targetType: 'ProjectOnboarding',
        targetId: assignment._id,
        payload: {
          email,
          role: body.role,
          documentCount: docIds.length,
        },
      });

      res.status(201).json({
        assignment: serializeAssignment(assignment),
        message: 'Onboarding assignment created successfully.',
      });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

/**
 * GET /api/projects/:id/onboarding
 * List onboarding assignments for this project (owner only).
 */
router.get(
  '/:id/onboarding',
  requireAuth,
  attachProject(),
  requireRole('owner'),
  async (req, res, next) => {
    try {
      const assignments = await ProjectOnboarding.find({ projectId: req.project._id })
        .sort({ createdAt: -1 })
        .populate('userId', 'name email')
        .populate('selectedDocumentIds', 'title filename mimeType size')
        .lean();

      res.json({
        assignments: assignments.map(serializeAssignment),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/projects/:id/onboarding/me
 * Retrieve the current user's onboarding assignment for this project.
 */
router.get(
  '/:id/onboarding/me',
  requireAuth,
  attachProject(),
  async (req, res, next) => {
    try {
      const email = req.user.email.toLowerCase();
      const assignment = await ProjectOnboarding.findOne({
        projectId: req.project._id,
        $or: [{ userId: req.user._id }, { email }],
      })
        .populate('selectedDocumentIds', 'title filename mimeType size createdAt')
        .lean();

      if (!assignment) {
        return res.status(404).json({
          error: 'not_found',
          message: 'No onboarding assignment found for your account in this project.',
        });
      }

      res.json({
        assignment: serializeAssignment(assignment),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/projects/:id/onboarding/:onboardingId
 * Retrieve a specific onboarding assignment (owner or assigned member).
 */
router.get(
  '/:id/onboarding/:onboardingId',
  requireAuth,
  attachProject(),
  async (req, res, next) => {
    try {
      const assignment = await loadAuthorizedOnboarding(req, res);
      if (!assignment) return;

      const populated = await ProjectOnboarding.findById(assignment._id)
        .populate('selectedDocumentIds', 'title filename mimeType size createdAt')
        .lean();

      res.json({
        assignment: serializeAssignment(populated),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/projects/:id/onboarding/:onboardingId
 * Update document selection, role, status, or notes (owner only).
 */
router.patch(
  '/:id/onboarding/:onboardingId',
  requireAuth,
  attachProject(),
  requireRole('owner'),
  async (req, res, next) => {
    try {
      const body = updateOnboardingSchema.parse(req.body);
      const assignment = await ProjectOnboarding.findOne({
        _id: req.params.onboardingId,
        projectId: req.project._id,
      });

      if (!assignment) {
        return res.status(404).json({ error: 'not_found', message: 'Onboarding assignment not found.' });
      }

      if (body.selectedDocumentIds) {
        const matchingCount = await Document.countDocuments({
          _id: { $in: body.selectedDocumentIds },
          projectId: req.project._id,
        });
        if (matchingCount !== body.selectedDocumentIds.length) {
          return res.status(400).json({
            error: 'validation_error',
            message: 'One or more selected documents do not belong to this project.',
          });
        }
        assignment.selectedDocumentIds = body.selectedDocumentIds;
      }

      if (body.role) assignment.role = body.role;
      if (body.status) assignment.status = body.status;
      if (body.notes !== undefined) assignment.notes = body.notes;

      await assignment.save();

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'ONBOARDING_UPDATED',
        targetType: 'ProjectOnboarding',
        targetId: assignment._id,
        payload: body,
      });

      res.json({
        assignment: serializeAssignment(assignment),
      });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

/**
 * POST /api/projects/:id/onboarding/:onboardingId/generate-context
 * Generate or regenerate onboarding AI context pack (owner only).
 */
router.post(
  '/:id/onboarding/:onboardingId/generate-context',
  requireAuth,
  attachProject(),
  requireRole('owner'),
  async (req, res, next) => {
    try {
      const assignment = await ProjectOnboarding.findOne({
        _id: req.params.onboardingId,
        projectId: req.project._id,
      });

      if (!assignment) {
        return res.status(404).json({ error: 'not_found', message: 'Onboarding assignment not found.' });
      }

      try {
        const newContext = await generateOnboardingContextPack({
          projectId: req.project._id,
          selectedDocumentIds: assignment.selectedDocumentIds,
        });

        assignment.contextPack = newContext;
        assignment.contextVersion = (assignment.contextVersion || 1) + 1;
        assignment.contextGeneratedAt = new Date();
        assignment.contextGenerationStatus = 'ready';
        assignment.contextGenerationError = null;
        await assignment.save();

        await logActivity({
          projectId: req.project._id,
          actorId: req.user._id,
          action: 'ONBOARDING_CONTEXT_REGENERATED',
          targetType: 'ProjectOnboarding',
          targetId: assignment._id,
          payload: { version: assignment.contextVersion },
        });

        res.json({
          assignment: serializeAssignment(assignment),
          message: 'Onboarding context regenerated successfully.',
        });
      } catch (genErr) {
        // Retain previous valid context version on failure
        assignment.contextGenerationStatus = 'failed';
        assignment.contextGenerationError = genErr.message;
        await assignment.save();

        return res.status(502).json({
          error: 'ai_generation_failed',
          message: `Failed to regenerate context: ${genErr.message}`,
          previousContextAvailable: Boolean(assignment.contextPack),
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/projects/:id/onboarding/:onboardingId/context
 * Retrieve prepared onboarding context.
 */
router.get(
  '/:id/onboarding/:onboardingId/context',
  requireAuth,
  attachProject(),
  async (req, res, next) => {
    try {
      const assignment = await loadAuthorizedOnboarding(req, res);
      if (!assignment) return;

      res.json({
        contextPack: assignment.contextPack,
        version: assignment.contextVersion,
        generatedAt: assignment.contextGeneratedAt,
        status: assignment.contextGenerationStatus,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/projects/:id/onboarding/:onboardingId/documents
 * Retrieve ONLY the selected documents assigned to this member.
 */
router.get(
  '/:id/onboarding/:onboardingId/documents',
  requireAuth,
  attachProject(),
  async (req, res, next) => {
    try {
      const assignment = await loadAuthorizedOnboarding(req, res);
      if (!assignment) return;

      const documents = await Document.find({
        _id: { $in: assignment.selectedDocumentIds || [] },
        projectId: req.project._id,
      })
        .select('title filename mimeType size pageCount chunkCount createdAt')
        .lean();

      res.json({
        documents: documents.map((d) => ({
          id: String(d._id),
          title: d.title,
          filename: d.filename,
          mimeType: d.mimeType,
          size: d.size,
          pageCount: d.pageCount ?? null,
          chunkCount: d.chunkCount ?? 0,
          createdAt: d.createdAt,
          isReviewed: (assignment.reviewedDocumentIds || []).map(String).includes(String(d._id)),
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/projects/:id/onboarding/:onboardingId/documents/:docId/preview
 * Secure preview for an authorized assigned document.
 */
router.get(
  '/:id/onboarding/:onboardingId/documents/:docId/preview',
  requireAuth,
  attachProject(),
  async (req, res, next) => {
    try {
      const assignment = await loadAuthorizedOnboarding(req, res);
      if (!assignment) return;

      const { docId } = req.params;
      const isSelected = (assignment.selectedDocumentIds || []).some((id) => String(id) === String(docId));
      if (!isSelected) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'This document is not assigned to your onboarding.',
        });
      }

      const doc = await Document.findOne({
        _id: docId,
        projectId: req.project._id,
      }).select('+extractedText title filename pageCount');

      if (!doc) {
        return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
      }

      const text = doc.extractedText || '';
      res.set('Cache-Control', 'private, no-store');
      res.json({
        id: String(doc._id),
        title: doc.title,
        filename: doc.filename,
        pageCount: doc.pageCount ?? null,
        text: text.slice(0, PREVIEW_CHARS),
        truncated: text.length > PREVIEW_CHARS,
        characterCount: text.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/projects/:id/onboarding/:onboardingId/documents/:docId/file
 * Secure download for an authorized assigned document.
 */
router.get(
  '/:id/onboarding/:onboardingId/documents/:docId/file',
  requireAuth,
  attachProject(),
  async (req, res, next) => {
    try {
      const assignment = await loadAuthorizedOnboarding(req, res);
      if (!assignment) return;

      const { docId } = req.params;
      const isSelected = (assignment.selectedDocumentIds || []).some((id) => String(id) === String(docId));
      if (!isSelected) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'This document is not assigned to your onboarding.',
        });
      }

      const doc = await Document.findOne({
        _id: docId,
        projectId: req.project._id,
      }).select('filename mimeType storageRef.key');

      if (!doc) {
        return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
      }

      const storage = getStorage();
      let bytes;
      try {
        bytes = await storage.read(doc.storageRef?.key);
      } catch {
        return res.status(410).json({
          error: 'file_unavailable',
          message: 'The original file is no longer available in storage.',
        });
      }

      res.set({
        'Content-Type': doc.mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeFilename(doc.filename)}"`,
        'Content-Length': String(bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });
      return res.send(bytes);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/projects/:id/onboarding/:onboardingId/review
 * Record section or document review acknowledgement.
 */
router.post(
  '/:id/onboarding/:onboardingId/review',
  requireAuth,
  attachProject(),
  async (req, res, next) => {
    try {
      const assignment = await loadAuthorizedOnboarding(req, res);
      if (!assignment) return;

      const body = reviewOnboardingSchema.parse(req.body);

      const reviewedSet = new Set(assignment.reviewedSections || []);
      if (body.section) reviewedSet.add(body.section);
      if (Array.isArray(body.sections)) {
        for (const s of body.sections) reviewedSet.add(s);
      }
      assignment.reviewedSections = Array.from(reviewedSet);

      if (body.documentId) {
        const isSelected = (assignment.selectedDocumentIds || []).some((id) => String(id) === String(body.documentId));
        if (isSelected) {
          const docSet = new Set((assignment.reviewedDocumentIds || []).map(String));
          docSet.add(String(body.documentId));
          assignment.reviewedDocumentIds = Array.from(docSet);
        }
      }

      if (assignment.status === 'ready') {
        assignment.status = 'in_progress';
      }

      await assignment.save();

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'ONBOARDING_REVIEW_ACKNOWLEDGED',
        targetType: 'ProjectOnboarding',
        targetId: assignment._id,
        payload: {
          section: body.section || null,
          sections: body.sections || null,
          documentId: body.documentId || null,
          reviewedCount: assignment.reviewedSections.length,
        },
      });

      res.json({
        reviewedSections: assignment.reviewedSections,
        reviewedDocumentIds: assignment.reviewedDocumentIds,
        status: assignment.status,
      });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      next(err);
    }
  }
);

/**
 * POST /api/projects/:id/onboarding/:onboardingId/complete
 * Complete the member onboarding workflow.
 */
router.post(
  '/:id/onboarding/:onboardingId/complete',
  requireAuth,
  attachProject(),
  async (req, res, next) => {
    try {
      const assignment = await loadAuthorizedOnboarding(req, res);
      if (!assignment) return;

      assignment.status = 'completed';
      assignment.completedAt = new Date();
      assignment.completedBy = req.user._id;
      if (!assignment.userId && req.user._id) {
        assignment.userId = req.user._id;
      }

      await assignment.save();

      await logActivity({
        projectId: req.project._id,
        actorId: req.user._id,
        action: 'ONBOARDING_COMPLETED',
        targetType: 'ProjectOnboarding',
        targetId: assignment._id,
        payload: {
          email: assignment.email,
          completedAt: assignment.completedAt,
        },
      });

      res.json({
        assignment: serializeAssignment(assignment),
        message: 'Project onboarding successfully completed!',
      });
    } catch (err) {
      next(err);
    }
  }
);

function serializeAssignment(row) {
  if (!row) return null;
  const isDocPopulated = Array.isArray(row.selectedDocumentIds) &&
    row.selectedDocumentIds.length > 0 &&
    typeof row.selectedDocumentIds[0] === 'object';

  return {
    id: String(row._id),
    projectId: String(row.projectId),
    userId: row.userId ? (typeof row.userId === 'object' ? { id: String(row.userId._id), name: row.userId.name, email: row.userId.email } : String(row.userId)) : null,
    email: row.email,
    role: row.role,
    assignedBy: String(row.assignedBy),
    invitationId: row.invitationId ? String(row.invitationId) : null,
    selectedDocuments: isDocPopulated
      ? row.selectedDocumentIds.map((d) => ({
          id: String(d._id),
          title: d.title,
          filename: d.filename,
          mimeType: d.mimeType,
          size: d.size,
          createdAt: d.createdAt,
        }))
      : (row.selectedDocumentIds || []).map(String),
    selectedDocumentCount: (row.selectedDocumentIds || []).length,
    status: row.status,
    contextVersion: row.contextVersion || 1,
    contextGeneratedAt: row.contextGeneratedAt,
    contextGenerationStatus: row.contextGenerationStatus || 'ready',
    contextGenerationError: row.contextGenerationError || null,
    contextPack: row.contextPack || null,
    reviewedSections: row.reviewedSections || [],
    reviewedDocumentIds: (row.reviewedDocumentIds || []).map(String),
    notes: row.notes || '',
    completedAt: row.completedAt || null,
    completedBy: row.completedBy ? String(row.completedBy) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export default router;
