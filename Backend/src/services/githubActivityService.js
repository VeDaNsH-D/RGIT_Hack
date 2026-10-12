import { SourceRecord } from '../models/SourceRecord.js';

/**
 * Project-scoped reads over ingested GitHub SourceRecords. Every query is anchored on projectId; repository
 * attribution comes from metadata.providerMetadata.repositoryId, written by the sync engine.
 * Existing indexes (projectId; projectId+provider+externalId) serve these queries at project scale. If a
 * project ever holds tens of thousands of GitHub records, add
 * { projectId, provider, type, 'metadata.providerMetadata.repositoryId' } (canonical-model change, Person 2).
 */

const PM = 'metadata.providerMetadata';
const KINDS = { issues: 'issue', pulls: 'pull_request', commits: 'commit' };
export const ACTIVITY_KINDS = Object.keys(KINDS);

/** Real counts per repository from persisted records only; no document is loaded into memory. */
export async function repositoryStats(projectId, repositoryIds) {
  if (!repositoryIds.length) return new Map();
  const rows = await SourceRecord.aggregate([
    { $match: { projectId, provider: 'github', [`${PM}.repositoryId`]: { $in: repositoryIds }, type: { $in: ['issue', 'pull_request', 'commit'] } } },
    { $group: { _id: { repo: `$${PM}.repositoryId`, type: '$type', state: `$${PM}.state` }, count: { $sum: 1 }, latest: { $max: '$metadata.sourceUpdatedAt' } } },
  ]);
  const stats = new Map(repositoryIds.map((id) => [id, { openIssues: 0, openPullRequests: 0, commitsIngested: 0, latestCommitAt: null }]));
  for (const { _id, count, latest } of rows) {
    const s = stats.get(_id.repo);
    if (!s) continue;
    if (_id.type === 'issue' && _id.state === 'open') s.openIssues += count;
    if (_id.type === 'pull_request' && _id.state === 'open') s.openPullRequests += count;
    if (_id.type === 'commit') {
      s.commitsIngested += count;
      if (latest && (!s.latestCommitAt || latest > s.latestCommitAt)) s.latestCommitAt = latest;
    }
  }
  return stats;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

export function serializeActivity(r) {
  const m = r.metadata || {};
  const p = m.providerMetadata || {};
  const base = {
    id: String(r._id),
    kind: r.type,
    title: r.title,
    url: /^https:\/\/github\.com\//.test(r.url || '') ? r.url : null,
    repository: p.repositoryFullName || null,
    author: m.author || null,
    createdAt: iso(m.sourceCreatedAt),
    updatedAt: iso(m.sourceUpdatedAt),
  };
  if (r.type === 'commit') return { ...base, sha: typeof p.sha === 'string' ? p.sha.slice(0, 7) : null };
  return {
    ...base,
    number: p.number ?? null,
    state: p.state || null,
    draft: r.type === 'pull_request' ? Boolean(p.draft) : undefined,
    merged: r.type === 'pull_request' ? Boolean(p.merged) : undefined,
    labels: Array.isArray(p.labels) ? p.labels.slice(0, 10) : [],
    assignees: Array.isArray(p.assignees) ? p.assignees.slice(0, 10) : [],
    reviewers: r.type === 'pull_request' && Array.isArray(p.requested_reviewers) ? p.requested_reviewers.slice(0, 10) : undefined,
  };
}

/** Paginated activity. `state` filters issues/PRs ('open' | 'closed' | 'all'); commits ignore it. */
export async function listActivity(projectId, { kind, repositoryId, state = 'open', page = 1, limit = 20 }) {
  const filter = { projectId, provider: 'github', type: KINDS[kind] };
  if (repositoryId) filter[`${PM}.repositoryId`] = repositoryId;
  if (kind !== 'commits' && state !== 'all') filter[`${PM}.state`] = state;
  const [items, total] = await Promise.all([
    SourceRecord.find(filter).sort({ 'metadata.sourceUpdatedAt': -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SourceRecord.countDocuments(filter),
  ]);
  return { items: items.map(serializeActivity), page, limit, total, hasMore: page * limit < total };
}
