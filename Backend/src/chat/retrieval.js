import { SourceConnection } from '../models/SourceConnection.js';
import { RepositorySnapshot } from '../models/RepositorySnapshot.js';
import { RepositoryFile } from '../models/RepositoryFile.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { Task } from '../models/Task.js';
import { Handoff } from '../models/Handoff.js';
import { Document } from '../models/Document.js';
import { DocumentChunk } from '../models/DocumentChunk.js';
import { tokenize } from '../services/documentContext.js';
const clean = text => String(text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/(?:gsk_|sk_live_|ntn_)[\w-]+/g, '[REDACTED]').slice(0, 100000);
const safeUrl = url => { try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; } };
export function rankChunks(candidates, question, history = []) {
  const query = tokenize(question);
  // Prior user questions resolve short follow-ups; assistant text never expands retrieval.
  if (query.size < 3) for (const turn of history.slice(-2)) for (const term of tokenize(turn.question)) query.add(term);
  const rows = candidates.map(row => ({ ...row, terms: tokenize(row.text), heading: tokenize(row.title) }));
  const df = new Map();
  for (const row of rows) for (const term of row.terms) df.set(term, (df.get(term) || 0) + 1);
  return rows.map(row => {
    let score = 0;
    for (const term of query) if (row.terms.has(term) || row.heading.has(term)) score += Math.log(1 + rows.length / (df.get(term) || 1)) * (row.heading.has(term) ? 2 : 1);
    return { ...row, score };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score);
}
export async function retrieveProjectChat(project, question, history) {
  const projectId = project._id;
  const [records, tasks, handoffs, documents, repositories] = await Promise.all([
    SourceRecord.find({ projectId }).select('title content url provider type updatedAt').sort({ updatedAt: -1 }).limit(1000).lean(),
    Task.find({ projectId }).populate('assignee', 'name').sort({ updatedAt: -1 }).limit(200).lean(),
    Handoff.find({ projectId }).select('state currentStatus pendingActions supportingLinks updatedAt').sort({ updatedAt: -1 }).limit(50).lean(),
    Document.find({ projectId, status: 'indexed' }).select('contentHash title filename').limit(100).lean(),
    SourceConnection.find({ projectId, provider: 'github' }).select('config.analysis.currentSnapshotId').limit(20).lean(),
  ]);
  const chunks = documents.length ? await DocumentChunk.find({ projectId, documentId: { $in: documents.map(d => d._id) } }).limit(3000).lean() : [];
  const published = repositories.map(row => row.config?.analysis?.currentSnapshotId).filter(Boolean);
  const snapshots = published.length ? await RepositorySnapshot.find({ projectId, _id: { $in: published }, status: { $in: ['completed', 'partial'] } }).limit(20).lean() : [];
  const current = new Map(documents.map(d => [String(d._id), d]));
  const candidates = [{ key: `project:${projectId}`, title: 'Project overview', provider: 'project', text: `${project.name}\n${project.description || ''}`, url: null }];
  const add = row => {
    row = { ...row, title: clean(row.title).slice(0, 2000) };
    const text = clean(row.text);
    for (let offset = 0; offset < text.length && candidates.length < 5000; offset += 1000) candidates.push({ ...row, key: `${row.key}:${offset}`, text: text.slice(offset, offset + 1200), url: safeUrl(row.url) });
  };
  for (const row of records) add({ key: `source:${row._id}`, title: row.title, text: `${row.title}\n${row.content}`, provider: row.provider, url: row.url });
  for (const task of tasks) add({ key: `task:${task._id}`, title: task.title, text: `Task: ${task.title}\n${task.description}\nStatus: ${task.status}. Priority: ${task.priority}. Assignee: ${task.assignee?.name || 'Unassigned'}. Deadline: ${task.deadline?.toISOString() || 'None'}.`, provider: 'task', url: null });
  for (const row of handoffs) add({ key: `handoff:${row._id}`, title: 'Handoff status', text: `Handoff status: ${row.state}\n${row.currentStatus || ''}`, provider: 'handoff', url: null });
  for (const chunk of chunks) {
    const doc = current.get(String(chunk.documentId));
    if (doc?.contentHash !== chunk.contentHash) continue;
    add({ key: `document:${chunk.chunkId}`, title: `${doc.title || doc.filename}${chunk.heading ? ` — ${chunk.heading}` : ''}${chunk.pageStart ? `, page ${chunk.pageStart}` : ''}`, text: chunk.text, provider: 'document', url: null });
  }
  for (const snapshot of snapshots) {
    const manifest = snapshot.fileManifest.slice(0, 200);
    if (!manifest.length) continue;
    const files = await RepositoryFile.find({ projectId, repositoryId: snapshot.repositoryId, $or: manifest.map(file => ({ path: file.path, blobSha: file.blobSha })) }).select('+content').limit(200).lean();
    for (const file of files) add({ key: `file:${file._id}`, title: `${snapshot.fullName}/${file.path} @ ${snapshot.commitSha.slice(0, 7)}`, text: file.content, provider: 'github', url: `https://github.com/${snapshot.fullName}/blob/${snapshot.commitSha}/${file.path}` });
  }
  const ranked = rankChunks(candidates, question, history);
  const selected = [], perSource = new Map(); let chars = 0;
  for (const row of ranked) {
    const group = row.key.split(':').slice(0, 2).join(':');
    if ((perSource.get(group) || 0) >= 3 || chars + row.text.length > 11000) continue;
    selected.push({ id: `S${selected.length + 1}`, title: row.title, text: row.text, provider: row.provider, url: row.url });
    chars += row.text.length; perSource.set(group, (perSource.get(group) || 0) + 1);
    if (selected.length === 10) break;
  }
  return { sources: selected, limitations: ['Answers use imported project content and current tasks; unsynced external content is unavailable. Repository evidence reflects its last analyzed commit.', ...(records.length === 1000 || chunks.length === 3000 ? ['Retrieval scan limit reached; older records may be omitted.'] : [])] };
}
