import { HandoffReport } from '../models/HandoffReport.js';
import { RepositoryFile } from '../models/RepositoryFile.js';
import { RepositorySnapshot } from '../models/RepositorySnapshot.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { config } from '../config.js';
import { AiServiceError, generateDeveloperHandoff as callAi } from './aiClient.js';
import { createHash } from 'node:crypto';
import { DraftError, buildHandoffContext, labelFor } from './handoffDraftService.js';
import { addDocumentLinkHints } from './documentContext.js';
import { addJiraKeyLinks } from './crossLinks.js';
import { serializeAnalysis, latestCommitSha } from './repositoryAnalysisService.js';
import { serializeSync } from './githubSyncEngine.js';

/**
 * Repository-aware developer handoff REPORT (independent of the team ownership-transfer Handoff).
 *
 *   Layer A  stable repository knowledge  (RepositorySnapshot per connected repo, from deterministic analysis)
 *   Layer B  current activity             (existing SourceRecords, Relay tasks/notes, previous handoffs)
 *   -> one ContextPackRequest -> aiml /api/v1/developer-handoff/generate -> validated structured sections
 *
 * Setup, important files, coverage/freshness and source links are built deterministically from verified data;
 * the model only synthesizes architecture, relationships, status and next steps, under citation rules.
 */

// Tight on purpose: the model is given what it needs to SYNTHESIZE. Complete lists (open items, recent activity, setup,
// files, coverage, links, documents) are rendered deterministically from the database, so they cost no tokens.
export const REPORT_LIMITS = Object.freeze({ fileExcerptChars: 900, importantFiles: 8, routes: 40 });
export const REPORT_ACTIVITY_LIMITS = Object.freeze({ openPrs: 12, openIssues: 15, recentClosedPrs: 6, commits: 12, notes: 8, tasks: 25, jiraOpen: 10, jiraDone: 3, slack: 8 });
// Bump when the prompt or pack format changes, so cached reports are not reused across incompatible versions.
export const PIPELINE_VERSION = 4;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// Provider-side "request too large" / tokens-per-minute failures: retry once or twice with less context.
const TOO_LARGE = /\b413\b|request too large|tokens per minute|reduce your message size/i;
const ATTEMPT_FACTORS = [1, 0.5, 0.25];

export class ReportError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SECTION_TITLES = {
  executive_summary: 'Executive summary', purpose_and_state: 'Project purpose and current state', documented_requirements: 'Documented requirements and plans', tracked_work_and_discussion: 'Tracked work and team discussion (Jira, Slack)', architecture: 'Repository architecture',
  modules: 'Major modules and responsibilities', important_files: 'Important files and entry points', setup: 'Development setup and test instructions',
  recent_changes: 'Recent changes and their significance', outstanding_work: 'Outstanding issues and pull requests', open_items: 'Open pull requests and issues', jira_items: 'Open Jira issues', recent_activity: 'Recent commits and merged pull requests', work_in_progress: 'Work in progress',
  decisions_constraints: 'Decisions and technical constraints', blockers_risks: 'Blockers and risks', next_steps: 'Recommended next steps',
  inspect_first: 'Suggested files to inspect first', documents: 'Project documents used', links: 'Relevant source links', coverage: 'Data freshness and analysis coverage',
};
export const SECTION_ORDER = Object.keys(SECTION_TITLES);

const blobUrl = (htmlUrl, sha, path) => (htmlUrl ? `${htmlUrl}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}` : null);
const short = (sha) => String(sha || '').slice(0, 7);

/** Tokens that look like repository file paths (contain a directory and an extension). */
export function pathTokens(text) {
  const noUrls = String(text).replace(/https?:\/\/\S+/g, ' ');
  return [...noUrls.matchAll(/(?<![\w/.-])(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,6}(?![\w/-])/g)].map((m) => m[0].replace(/^\.\//, ''));
}

/** A path is verified when it, or a path ending with it, exists among the analyzed files. */
export function unverifiedPaths(text, knownPaths) {
  return pathTokens(text).filter((t) => !knownPaths.has(t) && ![...knownPaths].some((k) => k.endsWith(`/${t}`)));
}

function repoEvidence(snapshot, connection, fileText, caps = REPORT_LIMITS) {
  const k = snapshot.knowledge;
  const id = snapshot.repositoryId;
  const htmlUrl = connection.config?.htmlUrl || `https://github.com/${snapshot.fullName}`;
  const label = `${snapshot.fullName}@${short(snapshot.commitSha)}`;
  const items = [];
  const add = (key, title, type, content, url = htmlUrl) => items.push({ id: `repo:${id}:${key}`, title, type, content: content.slice(0, caps.itemChars ?? 6000), url, label: `${label} ${title}` });
  const o = k.overview || {};
  add('overview', 'overview', 'repository_overview', [
    `Repository ${snapshot.fullName}, branch ${snapshot.branch}, analyzed commit ${snapshot.commitSha}.`,
    o.description && `Description: ${o.description}`, o.purposeFromReadme && `README summary: ${o.purposeFromReadme}`,
    `Languages (by file count): ${(o.languages || []).map((l) => `${l.language} ${l.files}`).join(', ') || 'unknown'}.`,
    o.frameworks?.length && `Frameworks/libraries detected in manifests: ${o.frameworks.join(', ')}.`,
    `Top-level directories: ${(o.topDirectories || []).map((d) => `${d.name} (${d.files})`).join(', ')}.`,
    k.entryPoints?.length && `Entry points: ${k.entryPoints.join(', ')}.`,
    k.buildAndTest?.length && `Scripts: ${k.buildAndTest.map((b) => `${b.name} = ${b.command} (${b.file})`).join('; ')}.`,
    k.envVariables?.length && `Environment variable names (values not collected): ${k.envVariables.map((e) => e.name).join(', ')}.`,
    k.deploy?.length && `CI/deploy files: ${k.deploy.join(', ')}.`,
    `Analysis coverage: ${snapshot.coverage.analyzed} of ${snapshot.coverage.eligible} eligible files (${snapshot.coverage.percent}%), status ${snapshot.status}.`,
  ].filter(Boolean).join('\n'), blobUrl(htmlUrl, snapshot.commitSha, 'README.md') && htmlUrl);
  if (k.components?.length) add('components', 'components', 'repository_components', k.components.slice(0, caps.components ?? 25).map((c) => `${c.name}: ${c.fileCount} files; ${c.languages.join('/')}; key files: ${c.keyFiles.join(', ')}${c.routeCount ? `; ${c.routeCount} routes` : ''}${c.models.length ? `; models: ${c.models.join(', ')}` : ''}${c.dependsOn.length ? `; imports from: ${c.dependsOn.join(', ')}` : ''}${c.description ? `; README: ${c.description}` : ''}`).join('\n'));
  if (k.routes?.length) add('routes', 'API routes', 'repository_routes', k.routes.slice(0, caps.routes).map((r) => `${r.method} ${r.path} (${r.file}:${r.line})`).join('\n'));
  if (k.models?.length) add('models', 'data models', 'repository_models', k.models.map((m) => `${m.name} [${m.kind}] (${m.file}:${m.line})`).join('\n'));
  if (k.dependencies?.length) add('dependencies', 'dependencies', 'repository_dependencies', k.dependencies.map((d) => `${d.file}${d.name ? ` (${d.name})` : ''}: ${d.top.join(', ')}${d.count > d.top.length ? ` and ${d.count - d.top.length} more` : ''}`).join('\n'));
  const wanted = [...new Set([...(k.importantFiles || []).map((f) => f.path)])].slice(0, caps.importantFiles);
  for (const path of wanted) {
    const text = fileText.get(path);
    if (text) items.push({ id: `file:${id}:${path}`, title: path, type: 'file', content: text.slice(0, caps.fileExcerptChars), url: blobUrl(htmlUrl, snapshot.commitSha, path), label: `${snapshot.fullName}/${path}@${short(snapshot.commitSha)}` });
  }
  return items;
}

function deterministicSections({ snapshots, connections, syncByRepo, evidenceById, freshnessByRepo }) {
  const ev = (id) => { const e = evidenceById.get(id); return e ? [evidenceRef(e.id, e)] : []; };
  const important = []; const setup = []; const coverage = [];
  for (const s of snapshots) {
    const k = s.knowledge; const id = s.repositoryId; const htmlUrl = connections.get(s.connectionId)?.config?.htmlUrl;
    const fileEv = (path) => [{ id: `file:${id}:${path}`, label: `${s.fullName}/${path}@${short(s.commitSha)}`, url: blobUrl(htmlUrl, s.commitSha, path), type: 'repository_file' }];
    for (const p of k.entryPoints || []) important.push({ text: `Entry point: ${p}`, kind: 'fact', evidence: fileEv(p) });
    for (const f of (k.importantFiles || []).filter((x) => !(k.entryPoints || []).includes(x.path)).slice(0, 15)) important.push({ text: `${f.path} (${f.category})`, kind: 'fact', evidence: fileEv(f.path) });
    for (const b of k.buildAndTest || []) setup.push({ text: `${s.fullName}: \`${b.name}\` runs \`${b.command}\` (defined in ${b.file}).`, kind: 'fact', evidence: fileEv(b.file) });
    for (const d of k.setupDocs || []) setup.push({ text: `${d.file} — “${d.heading}”: ${d.excerpt.replace(/\s+/g, ' ').slice(0, 500)}`, kind: 'fact', evidence: fileEv(d.file) });
    if (k.envVariables?.length) setup.push({ text: `${s.fullName} reads these environment variables (names only; set values locally, never commit them): ${k.envVariables.map((e) => e.name).join(', ')}.`, kind: 'fact', evidence: ev(`repo:${id}:overview`) });
    const c = s.coverage; const f = freshnessByRepo.get(s.repositoryId);
    coverage.push({ text: `${s.fullName}: analyzed commit ${s.commitSha} on ${s.branch} at ${new Date(s.analyzedAt).toISOString()}; status ${s.status}; ${c.analyzed} of ${c.eligible} eligible files analyzed (${c.percent}%), ${c.excludedTotal} excluded by rule (dependencies, build output, binaries, secrets, lock files).`, kind: 'fact', evidence: ev(`repo:${id}:overview`) });
    for (const l of k.limitations || []) coverage.push({ text: `${s.fullName}: ${l}`, kind: 'unknown', evidence: [] });
    if (f?.state === 'stale') for (const r of f.reasons) coverage.push({ text: `${s.fullName}: knowledge may be stale — ${r}`, kind: 'unknown', evidence: [] });
    const sync = syncByRepo.get(s.repositoryId);
    if (sync) coverage.push({ text: `GitHub activity sync for ${s.fullName}: ${sync.status}${sync.lastSuccessAt ? `, last successful ${new Date(sync.lastSuccessAt).toISOString()}` : ', never completed successfully'}.`, kind: sync.status === 'completed' ? 'fact' : 'unknown', evidence: [] });
  }
  if (!setup.length) setup.push({ text: 'No setup, build or test instructions were found in the analyzed files.', kind: 'unknown', evidence: [] });
  return { important_files: important, setup, coverage };
}

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'unknown date');
const pm = (r) => r.metadata?.providerMetadata || {};
const recRef = (r) => evidenceRef(String(r._id), { label: labelFor(r), url: /^https?:\/\//.test(r.url || '') ? r.url : null, type: r.type, provider: r.provider });

/** Complete, link-backed lists of open work and recent activity straight from the synced records (no model tokens). */
function activitySections(activity) {
  const line = (r, extra) => `${r.title}${extra ? ` (${extra})` : ''}`;
  const open = [
    ...activity.openPrs.slice(0, 15).map((r) => ({ text: `PR #${pm(r).number}: ${line(r, [pm(r).draft ? 'draft' : 'ready for review', r.metadata?.author && `by ${r.metadata.author}`, `updated ${day(r.metadata?.sourceUpdatedAt)}`, pm(r).labels?.length && pm(r).labels.join(', ')].filter(Boolean).join('; '))}`, kind: 'fact', evidence: [recRef(r)] })),
    ...activity.openIssues.slice(0, 20).map((r) => ({ text: `Issue #${pm(r).number}: ${line(r, [r.metadata?.author && `by ${r.metadata.author}`, `updated ${day(r.metadata?.sourceUpdatedAt)}`, pm(r).labels?.length && pm(r).labels.join(', '), pm(r).assignees?.length && `assigned ${pm(r).assignees.join(', ')}`].filter(Boolean).join('; '))}`, kind: 'fact', evidence: [recRef(r)] })),
  ];
  const recent = [
    ...activity.closedPrs.filter((r) => pm(r).merged || pm(r).merged_at).slice(0, 6).map((r) => ({ text: `Merged PR #${pm(r).number}: ${r.title} (${day(pm(r).merged_at || r.metadata?.sourceUpdatedAt)})`, kind: 'fact', evidence: [recRef(r)] })),
    ...activity.commits.slice(0, 10).map((r) => ({ text: `${String(pm(r).sha || '').slice(0, 7)} ${r.title}${r.metadata?.author ? ` — ${r.metadata.author}` : ''}, ${day(r.metadata?.sourceCreatedAt || r.metadata?.sourceUpdatedAt)}`, kind: 'fact', evidence: [recRef(r)] })),
  ];
  const jira = (activity.jiraOpen || []).slice(0, 20).map((r) => ({ text: `${pm(r).key || r.externalId}: ${r.title} (${[pm(r).issueType, pm(r).status && `status ${pm(r).status}`, pm(r).priority && `priority ${pm(r).priority}`, pm(r).assignee ? `assigned to ${pm(r).assignee}` : 'unassigned', pm(r).dueDate && `due ${day(pm(r).dueDate)}`].filter(Boolean).join('; ')})`, kind: 'fact', evidence: [recRef(r)] }));
  return { open_items: open, jira_items: jira, recent_activity: recent };
}

/** Project documents that fed this handoff (and any that could not), built from retrieval results, never from the model. */
function documentSection({ documents, evidence }) {
  const items = [];
  for (const d of documents.included) {
    const refs = [...evidence.values()].filter((e) => e.provider === 'document' && e.document?.documentId === d.documentId);
    const pages = [...new Set(refs.map((r) => r.document.pageStart).filter((p) => p != null))].sort((a, b) => a - b);
    const heads = [...new Set(refs.map((r) => r.document.heading).filter(Boolean))].slice(0, 6);
    items.push({ text: `${d.title} (${d.filename}), uploaded ${new Date(d.uploadedAt).toISOString().slice(0, 10)}: ${d.chunks} excerpt(s) provided to the model${pages.length ? `, pages ${pages.join(', ')}` : ''}${heads.length ? `; sections: ${heads.join(' | ')}` : ''}.`, kind: 'fact', evidence: refs.slice(0, 1).map((r) => evidenceRef(r.id, r)) });
  }
  for (const d of documents.notIndexed) items.push({ text: `${d.title} was not included: its processing status is ${d.status}.`, kind: 'unknown', evidence: [] });
  return items;
}

const hasFacts = (s) => s.items.length > 0;

/** Report-stored form of an evidence entry. `type` lets the preview and PDF distinguish source kinds. */
export function evidenceRef(id, e) {
  const type = e.provider === 'document' ? 'document'
    : e.provider === 'jira' ? 'jira_issue' : e.provider === 'slack' ? 'slack_message' : e.type === 'task' ? 'task'
    : e.provider === 'repository' ? (e.type === 'file' ? 'repository_file' : 'repository')
    : e.type === 'issue' ? 'issue' : e.type === 'pull_request' ? 'pull_request' : e.type === 'commit' ? 'commit'
    : e.provider === 'relay' ? 'handoff' : e.provider === 'manual' ? 'note' : e.type === 'file' ? 'repository_file' : (e.provider || 'other');
  return { id, label: e.label, url: e.url ?? null, type, ...(e.document ? { document: e.document } : {}) };
}

export async function generateDeveloperHandoffReport(project, user, { generate = callAi, force = false } = {}) {
  const connections = await SourceConnection.find({ projectId: project._id, provider: 'github' }).lean();
  const connById = new Map(connections.map((c) => [String(c._id), c]));
  const snapshotIds = connections.map((c) => c.config?.analysis?.currentSnapshotId).filter(Boolean);
  const snapshots = snapshotIds.length ? await RepositorySnapshot.find({ _id: { $in: snapshotIds }, projectId: project._id }).lean() : [];
  if (!snapshots.length) throw new ReportError(409, 'analysis_required', 'Analyze a connected repository first. The handoff is built from repository knowledge as well as project activity.');

  const freshnessByRepo = new Map(); const syncByRepo = new Map(); const extraLimitations = []; const loaded = [];
  for (const snapshot of snapshots) {
    const connection = connById.get(String(snapshot.connectionId));
    const analysis = serializeAnalysis(connection, snapshot, await latestCommitSha(project._id, snapshot.repositoryId));
    freshnessByRepo.set(snapshot.repositoryId, analysis.freshness);
    syncByRepo.set(snapshot.repositoryId, serializeSync(connection.config?.sync));
    if (snapshot.status === 'partial') extraLimitations.push(`Repository analysis of ${snapshot.fullName} is partial (${snapshot.coverage.percent}% of eligible files). Do not assume unanalyzed files do not exist.`);
    if (analysis.freshness?.state === 'stale') extraLimitations.push(`The analysis of ${snapshot.fullName} is stale: ${analysis.freshness.reasons.join(' ')}`);
    for (const l of snapshot.knowledge.limitations || []) extraLimitations.push(`${snapshot.fullName}: ${l}`);
    const paths = (snapshot.knowledge.importantFiles || []).map((f) => f.path).slice(0, REPORT_LIMITS.importantFiles);
    const rows = paths.length ? await RepositoryFile.find({ projectId: project._id, repositoryId: snapshot.repositoryId, $or: paths.map((path) => ({ path, blobSha: snapshot.fileManifest.find((f) => f.path === path)?.blobSha })) }).select('+content').lean() : [];
    loaded.push({ snapshot, connection, fileText: new Map(rows.map((r) => [r.path, r.content])) });
  }

  // One attempt per context size: a provider "request too large" error retries with a smaller prompt.
  let result = null; let reducedTo = null; let fingerprint = null;
  for (const factor of ATTEMPT_FACTORS) {
    const budget = Math.floor(config.ai.handoffContextChars * factor);
    const caps = { itemChars: clamp(Math.floor(budget * 0.1), 500, 6000), fileExcerptChars: clamp(Math.floor(budget * 0.04), 300, REPORT_LIMITS.fileExcerptChars), importantFiles: clamp(Math.round(REPORT_LIMITS.importantFiles * factor), 3, REPORT_LIMITS.importantFiles), routes: clamp(Math.round(REPORT_LIMITS.routes * factor), 10, REPORT_LIMITS.routes), components: clamp(Math.round(25 * factor), 6, 25) };
    const repoItems = []; let used = 0;
    for (const { snapshot, connection, fileText } of loaded) {
      for (const item of repoEvidence(snapshot, connection, fileText, caps)) {
        if (used + item.content.length > budget * 0.45) continue;
        used += item.content.length; repoItems.push(item);
      }
    }
    const queryHints = loaded.flatMap(({ snapshot }) => [...(snapshot.knowledge.components || []).map((c) => c.name), ...(snapshot.knowledge.overview?.frameworks || []), snapshot.fullName]);
    const { pack, evidence, limitations, counts, documents, activity, integrations } = await buildHandoffContext(project, { requireActivity: false, extraLimitations: factor < 1 ? [...extraLimitations, 'The context was reduced to fit the AI provider’s request-size limit, so some details may be missing.'] : extraLimitations, budgetChars: Math.floor(budget * 0.3), includePreviousHandoffs: true, includeDocuments: true, documentBudgetChars: Math.floor(budget * 0.25), queryHints, limits: REPORT_ACTIVITY_LIMITS, scale: factor, contentChars: clamp(Math.floor(budget * 0.015), 200, 1200) });
    for (const item of repoItems) {
      pack.sources.unshift({ id: item.id, external_id: null, provider: 'repository', record_type: item.type, title: item.title, content: item.content, content_type: 'text/plain', url: item.url, author: null, author_id: null, created_at: null, updated_at: null, fetched_at: null, metadata: {} });
      evidence.set(item.id, { id: item.id, label: item.label, url: item.url, type: item.type, provider: 'repository' });
    }
    addDocumentLinkHints(pack.sources);
    addJiraKeyLinks(pack.sources);
    if (factor === 1) {
      fingerprint = createHash('sha256').update(JSON.stringify([PIPELINE_VERSION, pack.case_description, pack.sources.map((x) => [x.id, x.title, x.content, x.metadata]), pack.tasks.map((t) => [t.id, t.title, t.status, t.priority, t.description])])).digest('hex');
      if (!force) {
        const last = await HandoffReport.findOne({ projectId: project._id }).sort({ generatedAt: -1 }).lean();
        if (last?.basedOn?.fingerprint === fingerprint) return { ...serializeReport(last), reused: true };
      }
    }
    try {
      result = { ai: await generate(pack), evidence, limitations, counts, documents, activity, integrations, pack };
      reducedTo = factor < 1 ? factor : null;
      break;
    } catch (err) {
      if (err instanceof AiServiceError && TOO_LARGE.test(err.message) && factor !== ATTEMPT_FACTORS.at(-1)) continue;
      if (err instanceof AiServiceError && TOO_LARGE.test(err.message)) throw new AiServiceError('The AI provider rejected the request as too large for its token limit, even after reducing the context. Lower AI_HANDOFF_CONTEXT_CHARS, use a model/tier with a higher limit, or retry in a minute.', { code: err.code, status: 413, endpoint: err.endpoint });
      throw err;
    }
  }
  const { ai, evidence, limitations, counts, documents, activity, integrations, pack: sentPack } = result;
  const contentOfDocs = sentPack.sources.filter((x) => x.provider === 'document').map((x) => [x.id, x.content]);
  if (reducedTo) limitations.push(`The AI request was reduced to ${Math.round(reducedTo * 100)}% of the normal context to fit the provider’s limit.`);
  const knownPaths = new Set(snapshots.flatMap((s) => s.fileManifest.map((f) => f.path)));
  const docChunkText = new Map(contentOfDocs);
  const sections = new Map();
  let removedUnverified = 0; let removedUnknownRef = 0;
  for (const section of Array.isArray(ai.sections) ? ai.sections : []) {
    if (!SECTION_ORDER.includes(section?.key) || ['important_files', 'setup', 'links', 'coverage', 'documents', 'open_items', 'jira_items', 'recent_activity'].includes(section.key) || sections.has(section.key)) continue;
    const items = [];
    for (const claim of Array.isArray(section.claims) ? section.claims : []) {
      if (typeof claim?.text !== 'string' || !claim.text.trim()) continue;
      const ids = (Array.isArray(claim.source_ids) ? claim.source_ids : []).map(String);
      if (ids.some((id) => !evidence.has(id))) { removedUnknownRef += 1; continue; }
      // A path is also acceptable when it appears in a cited uploaded document (it is then a documented path, not
      // a verified repository file; the prompt requires such claims to be labelled as documented).
      const docText = ids.map((id) => (docChunkText.get(id) || '')).join('\n');
      if (unverifiedPaths(claim.text, knownPaths).filter((p) => !docText.includes(p)).length) { removedUnverified += 1; continue; }
      const kind = ['fact', 'inference', 'unknown'].includes(claim.kind) ? claim.kind : 'inference';
      items.push({ text: claim.text.trim().slice(0, 1500), kind: !ids.length && kind !== 'unknown' ? 'inference' : kind, evidence: ids.map((id) => evidenceRef(id, evidence.get(id))) });
    }
    if (items.length) sections.set(section.key, { key: section.key, title: SECTION_TITLES[section.key], origin: 'ai', items });
  }
  if (ai.dropped_claims) limitations.push(`${ai.dropped_claims} AI statement(s) were removed because every source they cited was invalid.`);
  if (removedUnverified) limitations.push(`${removedUnverified} AI statement(s) were removed because they mentioned file paths that do not exist in the analyzed repository.`);
  if (removedUnknownRef) limitations.push(`${removedUnknownRef} AI statement(s) were removed because they cited unknown sources.`);
  if (!sections.has('executive_summary') && ai.summary) sections.set('executive_summary', { key: 'executive_summary', title: SECTION_TITLES.executive_summary, origin: 'ai', items: [{ text: ai.summary.trim().slice(0, 1500), kind: 'inference', evidence: [] }] });

  const evidenceById = new Map([...evidence.entries()]);
  const det = deterministicSections({ snapshots, connections: connById, syncByRepo, evidenceById, freshnessByRepo });
  for (const i of integrations || []) det.coverage.push({ text: `${i.label}: sync ${i.sync.status || 'pending'}${i.sync.lastSuccessAt ? `, last successful ${new Date(i.sync.lastSuccessAt).toISOString()}` : ', never completed successfully'}${i.sync.error ? ` (${String(i.sync.error).slice(0, 120)})` : ''}.`, kind: i.sync.status === 'completed' ? 'fact' : 'unknown', evidence: [] });
  for (const [key, items] of Object.entries(det)) sections.set(key, { key, title: SECTION_TITLES[key], origin: 'deterministic', items });
  for (const [key, items] of Object.entries(activitySections(activity))) sections.set(key, { key, title: SECTION_TITLES[key], origin: 'deterministic', items });
  sections.set('documents', { key: 'documents', title: SECTION_TITLES.documents, origin: 'deterministic', items: documentSection({ documents, evidence }) });

  // Source links: every distinct source cited anywhere, plus the repositories themselves.
  const linkMap = new Map();
  for (const s of sections.values()) for (const it of s.items) for (const e of it.evidence) if (/^https?:\/\//.test(e.url || '')) linkMap.set(e.url, e.label);
  for (const s of snapshots) { const url = connById.get(String(s.connectionId))?.config?.htmlUrl; if (url) linkMap.set(url, s.fullName); }
  sections.set('links', { key: 'links', title: SECTION_TITLES.links, origin: 'deterministic', items: [...linkMap.entries()].slice(0, 80).map(([url, label]) => ({ text: label, kind: 'fact', evidence: [{ id: url, label, url }] })) });

  const ordered = SECTION_ORDER.map((k) => sections.get(k)).filter((s) => s && hasFacts(s));
  const report = await HandoffReport.create({
    projectId: project._id, createdBy: user._id, projectName: project.name, generatedAt: new Date(),
    summary: ai.summary.trim().slice(0, 2000), sections: ordered,
    repositories: snapshots.map((s) => ({ fullName: s.fullName, commitSha: s.commitSha, branch: s.branch, analyzedAt: s.analyzedAt, status: s.status, coverage: { analyzed: s.coverage.analyzed, eligible: s.coverage.eligible, percent: s.coverage.percent }, freshness: freshnessByRepo.get(s.repositoryId)?.state || null, url: connById.get(String(s.connectionId))?.config?.htmlUrl || null })),
    limitations: [...new Set(limitations)].slice(0, 30),
    basedOn: { ...counts, fingerprint, repositories: snapshots.length, evidence: evidence.size, documentsNotIndexed: documents.notIndexed.length },
  });
  return serializeReport(report);
}

export function serializeReport(r) {
  return {
    id: String(r._id), projectId: String(r.projectId), projectName: r.projectName, generatedAt: r.generatedAt, summary: r.summary,
    sections: r.sections, repositories: r.repositories, limitations: r.limitations, basedOn: r.basedOn,
  };
}
export const serializeReportMeta = (r) => ({ id: String(r._id), generatedAt: r.generatedAt, repositories: (r.repositories || []).map((x) => ({ fullName: x.fullName, commitSha: x.commitSha, status: x.status })), createdBy: String(r.createdBy) });

export { DraftError };
