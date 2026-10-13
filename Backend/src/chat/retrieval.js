import { SourceConnection } from '../models/SourceConnection.js';
import { RepositorySnapshot } from '../models/RepositorySnapshot.js';
import { RepositoryFile } from '../models/RepositoryFile.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { Task } from '../models/Task.js';
import { Handoff } from '../models/Handoff.js';
import { Document } from '../models/Document.js';
import { DocumentChunk } from '../models/DocumentChunk.js';
import { chatTerms, expandedQuery, questionIntent, repositoryEvidence, repositoryFileKind } from './repositoryEvidence.js';
import { splitEvidence, selectEvidence } from './evidenceSelection.js';
import { knowledgeMessages } from './knowledgeStatus.js';

const clean = text => String(text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/(?:gsk_|sk_live_|ntn_)[\w-]+/g, '[REDACTED]').slice(0, 100000);
const safeUrl = url => { try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; } };

export function rankChunks(candidates, question, history = [], { k = 60 } = {}) {
  const query = expandedQuery(question, history);
  const intent = questionIntent(question, history);
  const rawTerms = chatTerms(question);
  const rows = candidates.map(row => ({ ...row, terms: chatTerms(row.text), heading: chatTerms(row.title) }));
  const df = new Map();
  for (const row of rows) for (const term of row.terms) df.set(term, (df.get(term) || 0) + 1);

  // 1. Sparse Lexical Scoring (Exact token overlap + inverse document frequency + heading match)
  const lexicalScored = rows.map(row => {
    let lexScore = 0;
    for (const term of rawTerms) {
      if (row.terms.has(term) || row.heading.has(term)) {
        lexScore += Math.log(1 + rows.length / (df.get(term) || 1)) * (row.heading.has(term) ? 2.5 : 1);
      }
    }
    return { row, lexScore };
  }).filter(item => item.lexScore > 0).sort((a, b) => b.lexScore - a.lexScore);

  const lexicalRanks = new Map();
  lexicalScored.forEach((item, index) => lexicalRanks.set(item.row.key, index));

  // 2. Semantic & Structural Scoring (Expanded query terms + Intent alignment + AST/manifest affinity)
  const semanticScored = rows.map(row => {
    let semScore = 0;
    if (intent === 'stack' && ['stack', 'manifest'].includes(row.kind)) semScore += 30;
    if (intent === 'overview' && ['overview', 'readme'].includes(row.kind)) semScore += 30;
    if (intent === 'setup' && ['setup', 'manifest', 'readme', 'entrypoint'].includes(row.kind)) semScore += 30;
    if (intent === 'route' && ['route', 'entrypoint'].includes(row.kind)) semScore += 30;
    if (intent === 'schema' && ['schema', 'manifest'].includes(row.kind)) semScore += 30;
    for (const term of query) {
      if (row.terms.has(term) || row.heading.has(term)) {
        semScore += Math.log(1 + rows.length / (df.get(term) || 1)) * (row.heading.has(term) ? 2 : 1);
      }
    }
    return { row, semScore };
  }).filter(item => item.semScore > 0).sort((a, b) => b.semScore - a.semScore);

  const semanticRanks = new Map();
  semanticScored.forEach((item, index) => semanticRanks.set(item.row.key, index));

  // 3. Reciprocal Rank Fusion: RRF(d) = sum( 1 / (k + rank_i(d)) ) with intent priority
  const scoredKeys = new Set([...lexicalRanks.keys(), ...semanticRanks.keys()]);
  const rowsByKey = new Map(rows.map(r => [r.key, r]));

  return [...scoredKeys].map(key => {
    const row = rowsByKey.get(key);
    let rrf = 0;
    if (lexicalRanks.has(key)) rrf += 1 / (k + lexicalRanks.get(key) + 1);
    if (semanticRanks.has(key)) rrf += 1 / (k + semanticRanks.get(key) + 1);
    let boost = 0;
    if (intent === 'overview' && ['overview', 'readme'].includes(row.kind)) boost += 20;
    if (intent === 'stack' && ['stack', 'manifest'].includes(row.kind)) boost += 20;
    if (intent === 'setup' && ['setup', 'manifest', 'readme', 'entrypoint'].includes(row.kind)) boost += 20;
    if (intent === 'route' && ['route', 'entrypoint'].includes(row.kind)) boost += 20;
    if (intent === 'schema' && ['schema', 'manifest'].includes(row.kind)) boost += 20;
    return { ...row, score: boost + rrf * 100 };
  }).sort((a, b) => b.score - a.score);
}

export async function retrieveProjectChat(project, question, history) {
  const projectId = project._id;
  const [records, tasks, handoffs, documents, repositories] = await Promise.all([
    SourceRecord.find({ projectId }).select('title content url provider type updatedAt').sort({ updatedAt: -1 }).limit(1000).lean(),
    Task.find({ projectId }).populate('assignee', 'name').sort({ updatedAt: -1 }).limit(200).lean(),
    Handoff.find({ projectId }).select('state currentStatus pendingActions supportingLinks updatedAt').sort({ updatedAt: -1 }).limit(50).lean(),
    Document.find({ projectId }).select('contentHash title filename status').limit(100).lean(),
    SourceConnection.find({ projectId, provider: 'github' }).select('config.analysis config.fullName').limit(20).lean(),
  ]);
  const chunks = documents.length ? await DocumentChunk.find({ projectId, documentId: { $in: documents.map(d => d._id) } }).limit(3000).lean() : [];
  const published = repositories.map(row => row.config?.analysis?.currentSnapshotId).filter(Boolean);
  const snapshots = published.length ? await RepositorySnapshot.find({ projectId, _id: { $in: published }, status: { $in: ['completed', 'partial'] } }).limit(20).lean() : [];
  const current = new Map(documents.filter(d => d.status === 'indexed').map(d => [String(d._id), d]));
  const candidates = [{ key: `project:${projectId}`, title: 'Project overview', provider: 'project', text: `${project.name}\n${project.description || ''}`, url: null }];
  const add = row => {
    row = { ...row, title: clean(row.title).slice(0, 2000) };
    const text = clean(row.text);
    for (const [index, chunk] of splitEvidence(text).entries()) {
      if (candidates.length >= 5000) break;
      candidates.push({ ...row, sourceKey: row.key, key: `${row.key}:${index}`, title: `${row.title}${chunk.heading ? ` — ${chunk.heading}` : ''}`.slice(0, 2000), text: chunk.text, url: safeUrl(row.url) });
    }
  };
  // Reserve candidate space for published repository evidence before bulk records.
  for (const snapshot of snapshots) {
    for (const evidence of repositoryEvidence(snapshot)) add(evidence);
    // Prioritize AST entrypoints and 1-hop module imports in the file manifest.
    const importTargets = new Set((snapshot.knowledge?.importGraph || []).flatMap(g => g.imports));
    const manifest = [...snapshot.fileManifest].sort((a, b) => {
      const priority = path => {
        const kind = repositoryFileKind(path);
        if (kind === 'entrypoint' || kind === 'manifest' || kind === 'readme') return 0;
        if (importTargets.has(path)) return 1;
        return 2;
      };
      return priority(a.path) - priority(b.path);
    }).slice(0, 200);
    if (!manifest.length) continue;
    const files = await RepositoryFile.find({ projectId, repositoryId: snapshot.repositoryId, $or: manifest.map(file => ({ path: file.path, blobSha: file.blobSha })) }).select('+content').limit(200).lean();
    for (const file of files) add({ key: `file:${file._id}`, kind: repositoryFileKind(file.path), title: `${snapshot.fullName}/${file.path} @ ${snapshot.commitSha.slice(0, 7)}`, text: file.content, provider: 'github', url: `https://github.com/${snapshot.fullName}/blob/${snapshot.commitSha}/${file.path}` });
  }
  for (const row of records) add({ key: `source:${row._id}`, title: row.title, text: `${row.title}\n${row.content}`, provider: row.provider, url: row.url });
  for (const task of tasks) add({ key: `task:${task._id}`, title: task.title, text: `Task: ${task.title}\n${task.description}\nStatus: ${task.status}. Priority: ${task.priority}. Assignee: ${task.assignee?.name || 'Unassigned'}. Deadline: ${task.deadline?.toISOString() || 'None'}.`, provider: 'task', url: null });
  for (const row of handoffs) add({ key: `handoff:${row._id}`, title: 'Handoff status', text: `Handoff status: ${row.state}\n${row.currentStatus || ''}`, provider: 'handoff', url: null });
  for (const chunk of chunks) {
    const doc = current.get(String(chunk.documentId));
    if (doc?.contentHash !== chunk.contentHash) continue;
    add({ key: `document:${chunk.chunkId}`, title: `${doc.title || doc.filename}${chunk.heading ? ` — ${chunk.heading}` : ''}${chunk.pageStart ? `, page ${chunk.pageStart}` : ''}`, text: chunk.text, provider: 'document', url: null });
  }
  const ranked = rankChunks(candidates, question, history);
  const selected = selectEvidence(ranked);
  return { sources: selected, limitations: ['Answers use imported project content and current tasks; unsynced external content is unavailable. Repository evidence reflects its last analyzed commit.', ...knowledgeMessages(repositories, snapshots, documents), ...(!selected.length ? ['No relevant passages were retrieved for this question. This does not prove that the information is absent from the repository.'] : []), ...(records.length === 1000 || chunks.length === 3000 ? ['Retrieval scan limit reached; older records may be omitted.'] : [])] };
}
