/**
 * @file onboardingService.js
 * @description Orchestrates AI-powered Project Member Onboarding context synthesis.
 * Reuses existing buildProjectContextPack, generateContextPack, and generateProjectBrief.
 */

import { Project } from '../models/Project.js';
import { Document } from '../models/Document.js';
import { Task } from '../models/Task.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { buildProjectContextPack } from './contextBuilder.js';
import { generateContextPack, generateProjectBrief } from './aiClient.js';

/**
 * Builds a deterministic fallback context pack if AI service fails or is unreachable.
 */
function buildDeterministicFallback({ project, selectedDocs = [], tasks = [], decisions = [], notes = [] }) {
  const openTasks = tasks.filter((t) => t.status === 'open');
  const completedTasks = tasks.filter((t) => t.status === 'completed');

  const mappedDecisions = decisions.map((d) => ({
    decision: d.title || 'Project architecture decision',
    rationale: d.content || 'Determined by team members during project development.',
    source_ids: [String(d._id)],
    decided_at: d.createdAt ? new Date(d.createdAt).toISOString() : null,
  }));

  const docSummaries = selectedDocs.map((d) => ({
    id: String(d._id),
    title: d.title || d.filename || 'Project Document',
    filename: d.filename || null,
    size: d.size || 0,
    type: d.mimeType || 'document',
    createdAt: d.createdAt,
  }));

  return {
    summary: `Onboarding briefing for ${project.name}. This draft provides initial context, pending tasks, and assigned project documents.`,
    projectOverview: project.description || `Welcome to ${project.name}. This workspace centralizes team continuity, tasks, and documentation.`,
    technologyStack: ['Node.js', 'React', 'MongoDB'],
    currentStatus: openTasks.length > 0 ? `${openTasks.length} open task(s) active` : 'Active',
    completedWork: completedTasks.length > 0
      ? completedTasks.map((t) => t.title)
      : ['Project workspace initialized and documents indexed.'],
    decisions: mappedDecisions.length > 0
      ? mappedDecisions
      : [{
          decision: 'Standardize project continuity with Relay',
          rationale: 'Ensure structured handoffs and document traceability for all team members.',
          source_ids: [],
          decided_at: null,
        }],
    attemptedActions: notes.slice(0, 5).map((n) => ({
      action: n.title,
      outcome: n.content ? n.content.slice(0, 200) : 'Documented in project notes.',
      source_ids: [String(n._id)],
    })),
    blockers: [],
    pendingTasks: openTasks.map((t) => ({
      id: String(t._id),
      title: t.title,
      description: t.description || '',
      priority: t.priority || 'medium',
      deadline: t.deadline ? new Date(t.deadline).toISOString() : null,
      status: t.status,
    })),
    recommendedNextSteps: [
      'Review the assigned project documents below.',
      'Check existing open tasks and deadlines.',
      'Reach out to the project administrator if any domain context is unclear.',
    ],
    missingInformation: selectedDocs.length === 0
      ? [{ topic: 'Project Documents', explanation: 'No documents were specifically assigned during onboarding.', impact: 'May require requesting files from project owner.' }]
      : [],
    evidenceReferences: selectedDocs.map((d) => String(d._id)),
    sourcesUsed: docSummaries,
    isDraft: true,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Synthesizes an Onboarding Context Pack for a project using selected documents.
 * Reuses existing ContextPackRequest builder and AI services.
 *
 * @param {object} args
 * @param {string|object} args.projectId
 * @param {Array<string>} [args.selectedDocumentIds]
 * @returns {Promise<object>} Complete validated onboarding context pack
 */
export async function generateOnboardingContextPack({ projectId, selectedDocumentIds = [] }) {
  const project = await Project.findById(projectId).lean();
  if (!project) {
    const error = new Error('Project not found');
    error.status = 404;
    throw error;
  }

  // Fetch only selected documents if IDs provided; otherwise fetch all project documents
  const docFilter = { projectId: project._id };
  if (Array.isArray(selectedDocumentIds) && selectedDocumentIds.length > 0) {
    docFilter._id = { $in: selectedDocumentIds };
  }

  const [selectedDocs, tasks, sourceRecords] = await Promise.all([
    Document.find(docFilter).select('+extractedText').lean(),
    Task.find({ projectId: project._id }).lean(),
    SourceRecord.find({ projectId: project._id }).lean(),
  ]);

  const decisions = sourceRecords.filter((r) => r.type === 'decision');
  const notes = sourceRecords.filter((r) => r.type === 'note');

  let aiContext = null;
  let aiBrief = null;

  try {
    const contextPackPayload = await buildProjectContextPack(project._id, {
      project,
      documents: selectedDocs,
      tasks,
      sourceRecords,
    });

    const [contextResult, briefResult] = await Promise.allSettled([
      generateContextPack(contextPackPayload),
      generateProjectBrief(contextPackPayload),
    ]);

    if (contextResult.status === 'fulfilled') {
      aiContext = contextResult.value;
    }
    if (briefResult.status === 'fulfilled') {
      aiBrief = briefResult.value;
    }
  } catch (err) {
    console.warn('[onboardingService] AI context synthesis encountered an issue, using fallback:', err.message);
  }

  // If both failed, use deterministic fallback
  if (!aiContext && !aiBrief) {
    return buildDeterministicFallback({ project, selectedDocs, tasks, decisions, notes });
  }

  const fallback = buildDeterministicFallback({ project, selectedDocs, tasks, decisions, notes });

  const summary = aiContext?.summary || aiBrief?.project_overview || aiBrief?.projectOverview || fallback.summary;
  const projectOverview = aiBrief?.project_overview || aiBrief?.projectOverview || fallback.projectOverview;
  const technologyStack = Array.isArray(aiBrief?.technology_stack || aiBrief?.technologyStack) && (aiBrief.technology_stack || aiBrief.technologyStack).length > 0
    ? (aiBrief.technology_stack || aiBrief.technologyStack)
    : fallback.technologyStack;
  const currentStatus = aiBrief?.current_status || aiBrief?.currentStatus || fallback.currentStatus;
  const completedWork = Array.isArray(aiBrief?.completed_work || aiBrief?.completedWork) && (aiBrief.completed_work || aiBrief.completedWork).length > 0
    ? (aiBrief.completed_work || aiBrief.completedWork)
    : fallback.completedWork;

  const mappedDecisions = Array.isArray(aiContext?.decisions) && aiContext.decisions.length > 0
    ? aiContext.decisions.map((d) => ({
        decision: d.decision,
        rationale: d.rationale || '',
        source_ids: Array.isArray(d.source_ids) ? d.source_ids : [],
        decided_at: d.decided_at || null,
      }))
    : fallback.decisions;

  const attemptedActions = Array.isArray(aiContext?.attempted_actions) && aiContext.attempted_actions.length > 0
    ? aiContext.attempted_actions.map((a) => ({
        action: a.action,
        outcome: a.outcome,
        source_ids: Array.isArray(a.source_ids) ? a.source_ids : [],
      }))
    : fallback.attemptedActions;

  const blockers = Array.isArray(aiContext?.blockers) && aiContext.blockers.length > 0
    ? aiContext.blockers.map((b) => ({
        description: b.description,
        severity: b.severity || 'medium',
        source_ids: Array.isArray(b.source_ids) ? b.source_ids : [],
      }))
    : (Array.isArray(aiBrief?.blockers)
        ? aiBrief.blockers.map((b) => ({ description: typeof b === 'string' ? b : b.description || 'Blocker', severity: 'medium', source_ids: [] }))
        : []);

  const openTasks = tasks.filter((t) => t.status === 'open');
  const pendingTasks = openTasks.map((t) => ({
    id: String(t._id),
    title: t.title,
    description: t.description || '',
    priority: t.priority || 'medium',
    deadline: t.deadline ? new Date(t.deadline).toISOString() : null,
    status: t.status,
  }));

  // Append any AI-proposed tasks
  if (Array.isArray(aiContext?.proposed_tasks)) {
    for (const pt of aiContext.proposed_tasks) {
      pendingTasks.push({
        id: `ai-proposed-${Math.random().toString(36).slice(2, 8)}`,
        title: pt.title,
        description: pt.description || pt.rationale || '',
        priority: pt.priority || 'medium',
        deadline: pt.suggested_deadline ? new Date(pt.suggested_deadline).toISOString() : null,
        status: 'open',
      });
    }
  }

  const recommendedNextSteps = Array.isArray(aiBrief?.recommended_next_steps || aiBrief?.recommendedNextSteps) && (aiBrief.recommended_next_steps || aiBrief.recommendedNextSteps).length > 0
    ? (aiBrief.recommended_next_steps || aiBrief.recommendedNextSteps)
    : fallback.recommendedNextSteps;

  const missingInformation = Array.isArray(aiContext?.missing_information) && aiContext.missing_information.length > 0
    ? aiContext.missing_information.map((m) => ({
        topic: m.topic || 'General',
        explanation: m.explanation || '',
        impact: m.impact || null,
        source_ids: Array.isArray(m.source_ids) ? m.source_ids : [],
      }))
    : (Array.isArray(aiBrief?.missing_information || aiBrief?.missingInformation)
        ? (aiBrief.missing_information || aiBrief.missingInformation)
        : fallback.missingInformation);

  const evidenceReferences = Array.isArray(aiBrief?.evidence_references || aiBrief?.evidenceReferences)
    ? (aiBrief.evidence_references || aiBrief.evidenceReferences)
    : selectedDocs.map((d) => String(d._id));

  const sourcesUsed = selectedDocs.map((d) => ({
    id: String(d._id),
    title: d.title || d.filename || 'Project Document',
    filename: d.filename || null,
    size: d.size || 0,
    type: d.mimeType || 'document',
    createdAt: d.createdAt,
  }));

  return {
    summary,
    projectOverview,
    technologyStack,
    currentStatus,
    completedWork,
    decisions: mappedDecisions,
    attemptedActions,
    blockers,
    pendingTasks,
    recommendedNextSteps,
    missingInformation,
    evidenceReferences,
    sourcesUsed,
    isDraft: true,
    generatedAt: new Date().toISOString(),
  };
}
