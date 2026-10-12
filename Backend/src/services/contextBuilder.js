/**
 * @file contextBuilder.js
 * @description Extracts and normalizes project context from MongoDB into the exact ContextPackRequest schema for Member 3's AI service.
 *
 * Distinct from the lightweight GET /:id/context view, this builder explicitly fetches:
 * - Full content for SourceRecords (commits, issues, PRs, notes, decisions)
 * - Full extractedText for Documents (using .select('+extractedText'))
 * - Full description, priority, deadline, and status for Tasks
 * - Preserved stable MongoDB ObjectIds as string identifiers for evidence traceability
 */

import { Project } from '../models/Project.js';
import { Task } from '../models/Task.js';
import { Document } from '../models/Document.js';
import { SourceRecord } from '../models/SourceRecord.js';

/**
 * Pure mapping function converting raw database documents into ContextPackRequest structure.
 *
 * @param {object} args
 * @param {object} args.project - Raw Project document.
 * @param {Array<object>} [args.tasks] - Raw Task documents.
 * @param {Array<object>} [args.documents] - Raw Document documents (with extractedText).
 * @param {Array<object>} [args.sourceRecords] - Raw SourceRecord documents (with content).
 * @returns {object} Payload matching ContextPackRequest schema.
 */
export function mapToContextPackRequest({
  project,
  tasks = [],
  documents = [],
  sourceRecords = [],
}) {
  if (!project) {
    throw new Error('Project object is required to build context pack.');
  }

  const caseId = String(project._id || project.id);
  const caseDescription = typeof project.description === 'string' ? project.description : '';

  const mappedSources = (sourceRecords || []).map((r) => {
    const id = String(r._id || r.id);
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : 'Untitled Source';
    const content = typeof r.content === 'string' ? r.content : '';
    const provider = r.provider || 'manual';
    const recordType = r.type || r.recordType || (provider === 'manual' ? 'note' : 'repository');

    const metadata = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    const author = metadata.author || r.author || null;
    const authorId = metadata.authorId ? String(metadata.authorId) : (r.authorId ? String(r.authorId) : null);
    const createdAt = r.createdAt ? new Date(r.createdAt).toISOString() : null;
    const updatedAt = r.updatedAt ? new Date(r.updatedAt).toISOString() : null;

    let fetchedAt = null;
    if (metadata.fetchedAt) {
      fetchedAt = new Date(metadata.fetchedAt).toISOString();
    } else if (r.fetchedAt) {
      fetchedAt = new Date(r.fetchedAt).toISOString();
    }

    return {
      id,
      external_id: r.externalId ? String(r.externalId) : null,
      provider,
      record_type: recordType,
      title,
      content,
      content_type: r.contentType || 'text/plain',
      url: r.url || null,
      author,
      author_id: authorId,
      created_at: createdAt,
      updated_at: updatedAt,
      fetched_at: fetchedAt,
      metadata,
    };
  });

  const mappedTasks = (tasks || []).map((t) => {
    const id = String(t._id || t.id);
    const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : 'Untitled Task';
    const description = typeof t.description === 'string' ? t.description : '';
    const status = t.status || 'open';
    const priority = t.priority || 'medium';
    const assignee = t.assignee ? String(t.assignee) : null;
    const deadline = t.deadline ? new Date(t.deadline).toISOString() : null;
    const origin = t.origin || 'manual';
    const sourceRecordId = t.sourceRecordId ? String(t.sourceRecordId) : null;
    const createdAt = t.createdAt ? new Date(t.createdAt).toISOString() : null;

    return {
      id,
      title,
      description,
      status,
      priority,
      assignee,
      deadline,
      origin,
      source_record_id: sourceRecordId,
      created_at: createdAt,
    };
  });

  const mappedDocuments = (documents || []).map((d) => {
    const id = String(d._id || d.id);
    const title = typeof d.title === 'string' && d.title.trim()
      ? d.title.trim()
      : (d.filename || 'Untitled Document');
    const filename = d.filename || null;
    const mimeType = d.mimeType || null;
    const size = typeof d.size === 'number' ? d.size : 0;
    const url = d.url || null;

    // Handle missing or empty extracted text gracefully without fabricating content
    let extractedText = null;
    if (typeof d.extractedText === 'string' && d.extractedText.trim().length > 0) {
      extractedText = d.extractedText.trim();
    }

    const uploadedBy = d.uploadedBy ? String(d.uploadedBy) : null;
    const createdAt = d.createdAt ? new Date(d.createdAt).toISOString() : null;

    return {
      id,
      title,
      filename,
      mime_type: mimeType,
      size,
      url,
      extracted_text: extractedText,
      uploaded_by: uploadedBy,
      created_at: createdAt,
    };
  });

  return {
    case_id: caseId,
    case_description: caseDescription,
    sources: mappedSources,
    tasks: mappedTasks,
    documents: mappedDocuments,
  };
}

/**
 * Queries MongoDB for project records with full text content and returns a normalized ContextPackRequest payload.
 *
 * @param {string|object} projectId - MongoDB Project ObjectId.
 * @param {object} [options]
 * @param {object} [options.project] - Optional pre-loaded Project object.
 * @param {Array<object>} [options.tasks] - Optional pre-loaded Task objects.
 * @param {Array<object>} [options.documents] - Optional pre-loaded Document objects.
 * @param {Array<object>} [options.sourceRecords] - Optional pre-loaded SourceRecord objects.
 * @param {object} [options.projectModel] - Optional Project model override.
 * @param {object} [options.taskModel] - Optional Task model override.
 * @param {object} [options.documentModel] - Optional Document model override.
 * @param {object} [options.sourceRecordModel] - Optional SourceRecord model override.
 * @returns {Promise<object>} ContextPackRequest ready for the AI service.
 */
export async function buildProjectContextPack(projectId, options = {}) {
  const projectModel = options.projectModel || Project;
  const taskModel = options.taskModel || Task;
  const documentModel = options.documentModel || Document;
  const sourceRecordModel = options.sourceRecordModel || SourceRecord;

  let project = options.project;
  if (!project) {
    project = await projectModel.findById(projectId).lean();
  }

  if (!project) {
    const error = new Error('Project not found');
    error.status = 404;
    error.code = 'not_found';
    throw error;
  }

  const resolvedProjectId = project._id || projectId;

  let tasks = options.tasks;
  let documents = options.documents;
  let sourceRecords = options.sourceRecords;

  if (!tasks || !documents || !sourceRecords) {
    const [fetchedTasks, fetchedDocuments, fetchedSourceRecords] = await Promise.all([
      tasks ? tasks : taskModel.find({ projectId: resolvedProjectId }).lean(),
      documents ? documents : documentModel.find({ projectId: resolvedProjectId }).select('+extractedText').lean(),
      sourceRecords ? sourceRecords : sourceRecordModel.find({ projectId: resolvedProjectId }).lean(),
    ]);
    tasks = fetchedTasks;
    documents = fetchedDocuments;
    sourceRecords = fetchedSourceRecords;
  }

  return mapToContextPackRequest({
    project,
    tasks,
    documents,
    sourceRecords,
  });
}
