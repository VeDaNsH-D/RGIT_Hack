import { SourceConnection } from '../models/SourceConnection.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { Task } from '../models/Task.js';
import { Handoff } from '../models/Handoff.js';
import { mapToContextPackRequest } from './contextBuilder.js';
import { generateContextPack } from './aiClient.js';
import { serializeSync } from './githubSyncEngine.js';

/**
 * Source-grounded handoff drafts.
 *
 * Reuses, rather than replaces, the existing pipeline:
 *   SourceRecords + Tasks --(contextBuilder.mapToContextPackRequest)--> ContextPackRequest
 *   --(aiClient.generateContextPack)--> aiml service /api/v1/context-packs/generate (Groq)
 * and maps the structured ContextIntelligenceResponse onto Relay's existing Handoff fields. The result is
 * stored in handoff.aiDraft for review; it never touches items/currentStatus until the user applies and
 * saves it through the existing handoff editor.
 *
 * Retrieval is structured (MongoDB), bounded by per-category caps and a character budget. There is no
 * embedding index, so no semantic search is claimed.
 */

export class DraftError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const LIMITS = Object.freeze({ openPrs: 30, openIssues: 40, recentClosedPrs: 15, commits: 30, notes: 20, tasks: 60, contentChars: 1200, totalChars: 120_000 });
const PM = 'metadata.providerMetadata';
const STALE_AFTER_MS = 7 * 24 * 3600 * 1000;

const trimMeta = (r) => {
  const p = r.metadata?.providerMetadata || {};
  const pick = {};
  for (const k of ['repositoryFullName', 'number', 'state', 'draft', 'merged', 'merged_at', 'closed_at', 'labels', 'assignees', 'requested_reviewers', 'sha', 'default_branch', 'language']) if (p[k] !== undefined) pick[k] = p[k];
  return { ...pick, author: r.metadata?.author ?? null, authorId: null, sourceCreatedAt: r.metadata?.sourceCreatedAt, sourceUpdatedAt: r.metadata?.sourceUpdatedAt };
};

async function recent(projectId, extra, limit) {
  return SourceRecord.find({ projectId, ...extra }).sort({ 'metadata.sourceUpdatedAt': -1, _id: -1 }).limit(limit).lean();
}

export function labelFor(r) {
  const p = r.metadata?.providerMetadata || {};
  const repo = p.repositoryFullName || (r.provider === 'manual' ? 'note' : r.provider);
  if (r.type === 'pull_request') return `${repo} PR #${p.number}`;
  if (r.type === 'issue') return `${repo} issue #${p.number}`;
  if (r.type === 'commit') return `${repo} commit ${String(p.sha || '').slice(0, 7)}`;
  if (r.type === 'repository') return `${repo} (repository)`;
  return `${r.type || 'record'}: ${r.title}`.slice(0, 80);
}

export async function buildHandoffContext(project, { requireActivity = true, extraLimitations = [], budgetChars = LIMITS.totalChars, includePreviousHandoffs = false, scale = 1, contentChars = LIMITS.contentChars } = {}) {
  const projectId = project._id;
  const cap = (n) => Math.max(2, Math.floor(n * scale));
  const connections = await SourceConnection.find({ projectId, provider: 'github' }).lean();
  const syncs = connections.map((c) => ({ repository: c.config?.fullName || 'repository', sync: serializeSync(c.config?.sync) }));

  const [repos, openPrs, openIssues, notes, closedPrs, commits, tasks] = await Promise.all([
    recent(projectId, { provider: 'github', type: 'repository' }, 10),
    recent(projectId, { provider: 'github', type: 'pull_request', [`${PM}.state`]: 'open' }, cap(LIMITS.openPrs)),
    recent(projectId, { provider: 'github', type: 'issue', [`${PM}.state`]: 'open' }, cap(LIMITS.openIssues)),
    recent(projectId, { provider: 'manual' }, cap(LIMITS.notes)),
    recent(projectId, { provider: 'github', type: 'pull_request', [`${PM}.state`]: 'closed' }, cap(LIMITS.recentClosedPrs)),
    recent(projectId, { provider: 'github', type: 'commit' }, cap(LIMITS.commits)),
    Task.find({ projectId }).sort({ updatedAt: -1 }).limit(cap(LIMITS.tasks)).lean(),
  ]);

  // Priority order; the character budget drops the least important records first.
  const ordered = [...repos, ...openPrs, ...openIssues, ...notes, ...closedPrs, ...commits];
  let budget = budgetChars;
  const selected = [];
  const evidenceList = [];
  const seen = new Set();
  for (const r of ordered) {
    if (seen.has(String(r._id))) continue;
    const content = (r.content || '').slice(0, contentChars);
    const cost = content.length + (r.title || '').length + 200;
    if (cost > budget) continue;
    budget -= cost;
    seen.add(String(r._id));
    selected.push({ ...r, content, metadata: trimMeta(r) });
    evidenceList.push([String(r._id), { id: String(r._id), label: labelFor(r), url: /^https?:\/\//.test(r.url || '') ? r.url : null, type: r.type, provider: r.provider }]);
  }

  if (includePreviousHandoffs) {
    const previous = await Handoff.find({ projectId }).sort({ createdAt: -1 }).limit(3).lean();
    for (const h of previous) {
      const content = [h.currentStatus, ...(h.items || []).slice(0, 15).map((i) => `${i.type}: ${i.text}`)].filter(Boolean).join('\n').slice(0, contentChars);
      if (!content) continue;
      const id = `handoff:${h._id}`;
      selected.push({ _id: id, provider: 'relay', type: 'handoff', title: `Previous handoff (${h.state})`, content, url: '', externalId: id, metadata: { sourceCreatedAt: h.createdAt } });
      evidenceList.push([id, { id, label: `Previous handoff (${h.state})`, url: null, type: 'handoff', provider: 'relay' }]);
    }
  }

  const githubRecords = selected.filter((r) => r.provider === 'github').length;
  const limitations = [...extraLimitations];
  if (connections.length === 0 && !extraLimitations.length) limitations.push('No GitHub repository is connected to this project.');
  for (const { repository, sync } of syncs) {
    if (!sync.lastSuccessAt && sync.status !== 'partial') limitations.push(`${repository} has not been synchronized successfully; its activity is missing.`);
    else if (sync.status === 'failed' || sync.status === 'partial') limitations.push(`The latest sync of ${repository} ${sync.status === 'failed' ? 'failed' : 'was only partial'}; data may be outdated.`);
    else if (sync.lastSuccessAt && Date.now() - new Date(sync.lastSuccessAt).getTime() > STALE_AFTER_MS) limitations.push(`${repository} was last synchronized more than 7 days ago.`);
    if (sync.truncated) limitations.push(`${repository}: history was truncated by sync limits.`);
  }

  if (requireActivity && githubRecords === 0 && notes.length === 0 && tasks.length === 0) {
    throw new DraftError(connections.length ? 409 : 422, connections.length ? 'not_synced' : 'insufficient_context', connections.length
      ? 'Synchronize a connected repository before drafting a handoff.' : 'There is no project context to draft from yet. Connect a repository, add tasks, or add notes first.');
  }

  const evidence = new Map(evidenceList);
  const freshness = limitations.length ? `\n\n[Relay data limitations] ${limitations.join(' ')}` : '';
  const pack = mapToContextPackRequest({
    project: { _id: project._id, name: project.name, description: `${project.description || ''}${freshness}`.trim() },
    tasks,
    documents: [],
    sourceRecords: selected,
  });
  return { pack, evidence, limitations, counts: { github: githubRecords, notes: notes.length, tasks: tasks.length } };
}

const ref = (ids, evidence) => {
  const labels = [...new Set((ids || []).map((id) => evidence.get(String(id))?.label).filter(Boolean))];
  return labels.length ? ` [Source: ${labels.slice(0, 3).join('; ')}]` : '';
};

/** Validates the AIML response against what was actually sent, and maps it onto handoff fields. */
export function mapAiOutputToDraft(ai, evidence, limitations) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  if (!ai || typeof ai.summary !== 'string' || !ai.summary.trim()) throw new DraftError(502, 'malformed_ai_output', 'The AI service returned an unusable draft.');
  const known = (ids) => arr(ids).map(String).filter((id) => evidence.has(id));
  const items = [];
  const add = (type, text, ids, kind) => {
    if (typeof text !== 'string' || !text.trim()) return;
    const cited = known(ids);
    items.push({
      type, kind: cited.length || kind === 'unknown' ? kind : 'inference',
      text: `${text.trim().slice(0, 1700)}${ref(cited, evidence)}`.slice(0, 2000),
      sourceRecordId: cited[0] || null,
      evidenceIds: cited,
    });
  };
  for (const a of arr(ai.attempted_actions)) add('completed', a?.outcome ? `${a.action} — ${a.outcome}` : a?.action, a?.source_ids, 'sourced');
  for (const d of arr(ai.decisions)) add('decision', d?.rationale ? `${d.decision} — ${d.rationale}` : d?.decision, d?.source_ids, 'sourced');
  for (const b of arr(ai.blockers)) add('blocker', b?.description, b?.source_ids, 'sourced');
  for (const t of arr(ai.proposed_tasks)) add('pending', `Suggested: ${t?.title}${t?.description ? ` — ${t.description}` : ''}`, t?.source_ids, 'inference');
  for (const m of arr(ai.missing_information)) add('risk', `Unknown: ${m?.topic}${m?.explanation ? ` — ${m.explanation}` : ''}`, [], 'unknown');
  for (const c of arr(ai.contradictions)) add('risk', `Conflicting sources: ${c?.title}${c?.description ? ` — ${c.description}` : ''}`, arr(c?.sources).map((s) => s?.source_id), 'sourced');
  const used = new Set(items.flatMap((i) => i.evidenceIds));
  const sources = [...used].map((id) => evidence.get(id));
  return {
    currentStatus: ai.summary.trim().slice(0, 4900),
    items: items.slice(0, 60),
    supportingLinks: [...new Set(sources.map((s) => s.url).filter(Boolean))].slice(0, 50),
    sources,
    limitations,
  };
}

export async function generateHandoffDraft(project, { generate = generateContextPack } = {}) {
  const { pack, evidence, limitations, counts } = await buildHandoffContext(project);
  const ai = await generate(pack);
  const draft = mapAiOutputToDraft(ai, evidence, limitations);
  return { ...draft, generatedAt: new Date().toISOString(), basedOn: counts };
}
