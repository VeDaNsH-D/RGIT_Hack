import { SourceConnection } from '../models/SourceConnection.js';
import { RepositorySnapshot } from '../models/RepositorySnapshot.js';
import { Document } from '../models/Document.js';

export function knowledgeMessages(repositories, snapshots, documents) {
  const messages = [];
  const published = new Map(snapshots.map(snapshot => [String(snapshot._id), snapshot]));
  if (!repositories.length) messages.push('No GitHub repository is connected. Answers can still use imported records, documents, and project work.');
  for (const repository of repositories) {
    const analysis = repository.config?.analysis || {};
    const snapshot = published.get(String(analysis.currentSnapshotId));
    const name = snapshot?.fullName || repository.config?.fullName || 'Connected repository';
    if (!snapshot) {
      messages.push(`${name}: no usable repository analysis is available${analysis.status ? ` (status: ${analysis.status})` : ''}. Analyze the repository to make its code available to chat.`);
      continue;
    }
    messages.push(`${name}: ${snapshot.status} analysis, commit ${snapshot.commitSha.slice(0, 7)}, analyzed ${new Date(snapshot.analyzedAt).toISOString()}.`);
    const coverage = snapshot.coverage || {};
    if (Number.isFinite(coverage.analyzed)) messages.push(`${name}: ${coverage.analyzed} files analyzed${Number.isFinite(coverage.eligible) ? ` of ${coverage.eligible} eligible` : ''}.`);
    const skips = [['excludedTotal', 'excluded'], ['tooLarge', 'too large'], ['overBudget', 'over budget'], ['binarySkipped', 'binary'], ['secretSkipped', 'secret-containing'], ['fetchFailed', 'fetch failed'], ['truncatedFiles', 'truncated']].filter(([key]) => Number(coverage[key]) > 0).map(([key, label]) => `${coverage[key]} ${label}`);
    if (skips.length) messages.push(`${name}: coverage gaps: ${skips.join(', ')}.`);
    if (analysis.staleAt || analysis.status === 'failed' || analysis.status === 'analyzing') messages.push(`${name}: the last published snapshot is being used; the latest analysis may be pending or unsuccessful.`);
  }
  const unavailable = documents.filter(document => document.status !== 'indexed').length;
  if (unavailable) messages.push(`${unavailable} uploaded document(s) are not indexed and cannot supply chat evidence yet.`);
  return messages;
}

export async function getKnowledgeStatus(projectId) {
  const [repositories, documents] = await Promise.all([
    SourceConnection.find({ projectId, provider: 'github' }).select('config.analysis config.fullName').limit(20).lean(),
    Document.find({ projectId }).select('status').limit(100).lean(),
  ]);
  const ids = repositories.map(row => row.config?.analysis?.currentSnapshotId).filter(Boolean);
  const snapshots = ids.length ? await RepositorySnapshot.find({ projectId, _id: { $in: ids }, status: { $in: ['completed', 'partial'] } }).select('fullName commitSha status analyzedAt coverage').lean() : [];
  return knowledgeMessages(repositories, snapshots, documents);
}
