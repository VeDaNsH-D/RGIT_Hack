import { SourceConnection } from '../models/SourceConnection.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { Task } from '../models/Task.js';
import { Handoff } from '../models/Handoff.js';
import { mapToContextPackRequest } from './contextBuilder.js';
import { generateContextPack } from './aiClient.js';
import { retrieveDocumentContext, tokenize } from './documentContext.js';
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

/** Per-record-type content caps: commits and PR/issue bodies are mostly noise for synthesis; titles carry the signal. */
const contentCapFor = (r, contentChars) => (r.type === 'commit' ? 0 : r.type === 'issue' || r.type === 'pull_request' ? Math.min(contentChars, 260) : contentChars);

/** Strips template/markup noise and whitespace, then keeps whole leading sentences up to `max` characters. */
export function condense(text, max) {
  if (!max) return '';
  const flat = String(text || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/```[\s\S]*?```/g, ' [code] ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[#>*\-\s]+/gm, '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return `${end > max * 0.5 ? cut.slice(0, end + 1) : cut.trimEnd()}…`;
}

// Share of the record budget each category may use first; whatever is left over is then shared by what was skipped,
// so a flood of PRs can never push out all issues, notes or commits.
const QUOTA = { repository: 0.06, pull_request: 0.26, issue: 0.26, note: 0.12, closed_pr: 0.12, commit: 0.18 };
const categoryOf = (r, closedPrIds) => (r.provider === 'manual' ? 'note' : r.type === 'repository' ? 'repository' : r.type === 'commit' ? 'commit' : r.type === 'issue' ? 'issue' : closedPrIds.has(String(r._id)) ? 'closed_pr' : 'pull_request');

/** Lexical relevance of a record to the project's working vocabulary (name, description, repository components, ...). */
function rankByRelevance(records, vocabulary, keep) {
  if (records.length <= keep) return records;
  const scored = records.map((r, i) => {
    const tokens = tokenize(`${r.title} ${(r.content || '').slice(0, 300)}`);
    let hits = 0;
    for (const t of tokens) if (vocabulary.has(t)) hits += 1;
    return { r, score: hits + (records.length - i) / (records.length * 4) }; // recency (input order) breaks ties
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, keep).map((x) => x.r);
}

export async function buildHandoffContext(project, { requireActivity = true, extraLimitations = [], budgetChars = LIMITS.totalChars, includePreviousHandoffs = false, scale = 1, contentChars = LIMITS.contentChars, includeDocuments = true, documentBudgetChars = 24_000, queryHints = [], documentModels, limits = LIMITS } = {}) {
  const projectId = project._id;
  const cap = (n) => Math.max(2, Math.floor(n * scale));
  const connections = await SourceConnection.find({ projectId, provider: 'github' }).lean();
  const syncs = connections.map((c) => ({ repository: c.config?.fullName || 'repository', sync: serializeSync(c.config?.sync) }));
  const vocabulary = new Set([...tokenize(project.name), ...tokenize(project.description), ...queryHints.flatMap((h) => [...tokenize(h)])]);
  // Pull a few more than we keep so the most relevant (not merely the most recent) survive the cap.
  const pool = (n) => cap(n) * 2;

  const [repos, openPrsAll, openIssuesAll, notes, closedPrsAll, commits, tasksAll] = await Promise.all([
    recent(projectId, { provider: 'github', type: 'repository' }, 10),
    recent(projectId, { provider: 'github', type: 'pull_request', [`${PM}.state`]: 'open' }, pool(limits.openPrs)),
    recent(projectId, { provider: 'github', type: 'issue', [`${PM}.state`]: 'open' }, pool(limits.openIssues)),
    recent(projectId, { provider: 'manual' }, cap(limits.notes)),
    recent(projectId, { provider: 'github', type: 'pull_request', [`${PM}.state`]: 'closed' }, pool(limits.recentClosedPrs)),
    recent(projectId, { provider: 'github', type: 'commit' }, cap(limits.commits)),
    Task.find({ projectId }).sort({ updatedAt: -1 }).limit(cap(limits.tasks)).lean(),
  ]);
  const openPrs = rankByRelevance(openPrsAll, vocabulary, cap(limits.openPrs));
  const openIssues = rankByRelevance(openIssuesAll, vocabulary, cap(limits.openIssues));
  const closedPrs = rankByRelevance(closedPrsAll, vocabulary, cap(limits.recentClosedPrs));
  // Open tasks matter more than finished ones.
  const tasks = [...tasksAll].sort((a, b) => (a.status === 'completed') - (b.status === 'completed'));

  // Priority order; the character budget drops the least important records first.
  const ordered = [...repos, ...openPrs, ...openIssues, ...notes, ...closedPrs, ...commits];
  const closedIds = new Set(closedPrs.map((r) => String(r._id)));
  const remaining = Object.fromEntries(Object.entries(QUOTA).map(([k, f]) => [k, Math.floor(budgetChars * f)]));
  let poolLeft = budgetChars;
  const selected = [];
  const evidenceList = [];
  const seen = new Set();
  const skipped = [];
  const take = (r, fromQuota) => {
    const content = condense(r.content, contentCapFor(r, contentChars));
    const cost = content.length + (r.title || '').length + 60;
    const cat = categoryOf(r, closedIds);
    if (cost > poolLeft || (fromQuota && cost > remaining[cat])) return false;
    poolLeft -= cost;
    remaining[cat] -= cost;
    seen.add(String(r._id));
    selected.push({ ...r, content, metadata: trimMeta(r) });
    evidenceList.push([String(r._id), { id: String(r._id), label: labelFor(r), url: /^https?:\/\//.test(r.url || '') ? r.url : null, type: r.type, provider: r.provider }]);
    return true;
  };
  for (const r of ordered) if (!seen.has(String(r._id)) && !take(r, true)) skipped.push(r);
  for (const r of skipped) if (!seen.has(String(r._id))) take(r, false);
  // Tasks are sent to the model, so they must be citable (and validated) like every other source.
  for (const t of tasks) evidenceList.push([String(t._id), { id: String(t._id), label: `Task: ${t.title}`.slice(0, 120), url: null, type: 'task', provider: 'relay' }]);

  if (includePreviousHandoffs) {
    const previous = await Handoff.find({ projectId }).sort({ createdAt: -1 }).limit(2).lean();
    for (const h of previous) {
      const content = [h.currentStatus, ...(h.items || []).slice(0, 10).map((i) => `${i.type}: ${i.text}`)].filter(Boolean).join('\n').slice(0, contentChars);
      if (!content) continue;
      const id = `handoff:${h._id}`;
      selected.push({ _id: id, provider: 'relay', type: 'handoff', title: `Previous handoff (${h.state})`, content, url: '', externalId: id, metadata: { sourceCreatedAt: h.createdAt } });
      evidenceList.push([id, { id, label: `Previous handoff (${h.state})`, url: null, type: 'handoff', provider: 'relay' }]);
    }
  }

  // Uploaded project documents: relevance-ranked chunks of this project's indexed documents, in the same pack.
  let docs = { sources: [], evidence: [], limitations: [], included: [], notIndexed: [], chunkCount: 0 };
  if (includeDocuments) {
    const queryTexts = [project.name, project.description, ...queryHints, ...selected.slice(0, 60).map((r) => r.title), ...tasks.slice(0, 40).map((t) => t.title)];
    docs = await retrieveDocumentContext(project, { queryTexts, budgetChars: Math.floor(documentBudgetChars * Math.max(scale, 0.25)), scale, models: documentModels });
    selected.push(...docs.sources);
    evidenceList.push(...docs.evidence);
  }

  const githubRecords = selected.filter((r) => r.provider === 'github').length;
  const limitations = [...extraLimitations, ...docs.limitations];
  if (connections.length === 0 && !extraLimitations.length) limitations.push('No GitHub repository is connected to this project.');
  for (const { repository, sync } of syncs) {
    if (!sync.lastSuccessAt && sync.status !== 'partial') limitations.push(`${repository} has not been synchronized successfully; its activity is missing.`);
    else if (sync.status === 'failed' || sync.status === 'partial') limitations.push(`The latest sync of ${repository} ${sync.status === 'failed' ? 'failed' : 'was only partial'}; data may be outdated.`);
    else if (sync.lastSuccessAt && Date.now() - new Date(sync.lastSuccessAt).getTime() > STALE_AFTER_MS) limitations.push(`${repository} was last synchronized more than 7 days ago.`);
    if (sync.truncated) limitations.push(`${repository}: history was truncated by sync limits.`);
  }

  if (requireActivity && githubRecords === 0 && notes.length === 0 && tasks.length === 0 && docs.chunkCount === 0) {
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
  return { pack, evidence, limitations, activity: { openPrs: openPrsAll, openIssues: openIssuesAll, closedPrs: closedPrsAll, commits }, documents: { included: docs.included, notIndexed: docs.notIndexed }, counts: { github: githubRecords, notes: notes.length, tasks: tasks.length, documents: docs.included.length, documentExcerpts: docs.chunkCount } };
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
