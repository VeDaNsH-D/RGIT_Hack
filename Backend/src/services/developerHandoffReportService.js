import { HandoffReport } from '../models/HandoffReport.js';
import { RepositoryFile } from '../models/RepositoryFile.js';
import { RepositorySnapshot } from '../models/RepositorySnapshot.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { config } from '../config.js';
import { AiServiceError, generateDeveloperHandoff as callAi } from './aiClient.js';
import { DraftError, buildHandoffContext } from './handoffDraftService.js';
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

export const REPORT_LIMITS = Object.freeze({ fileExcerptChars: 1500, importantFiles: 12, routes: 80 });
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// Provider-side "request too large" / tokens-per-minute failures: retry once or twice with less context.
const TOO_LARGE = /\b413\b|request too large|tokens per minute|reduce your message size/i;
const ATTEMPT_FACTORS = [1, 0.5, 0.25];

export class ReportError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SECTION_TITLES = {
  executive_summary: 'Executive summary', purpose_and_state: 'Project purpose and current state', architecture: 'Repository architecture',
  modules: 'Major modules and responsibilities', important_files: 'Important files and entry points', setup: 'Development setup and test instructions',
  recent_changes: 'Recent changes and their significance', outstanding_work: 'Outstanding issues and pull requests', work_in_progress: 'Work in progress',
  decisions_constraints: 'Decisions and technical constraints', blockers_risks: 'Blockers and risks', next_steps: 'Recommended next steps',
  inspect_first: 'Suggested files to inspect first', links: 'Relevant source links', coverage: 'Data freshness and analysis coverage',
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
  const ev = (id) => { const e = evidenceById.get(id); return e ? [{ id: e.id, label: e.label, url: e.url }] : []; };
  const important = []; const setup = []; const coverage = [];
  for (const s of snapshots) {
    const k = s.knowledge; const id = s.repositoryId; const htmlUrl = connections.get(s.connectionId)?.config?.htmlUrl;
    const fileEv = (path) => [{ id: `file:${id}:${path}`, label: `${s.fullName}/${path}@${short(s.commitSha)}`, url: blobUrl(htmlUrl, s.commitSha, path) }];
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

const hasFacts = (s) => s.items.length > 0;

export async function generateDeveloperHandoffReport(project, user, { generate = callAi } = {}) {
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
  let result = null; let reducedTo = null;
  for (const factor of ATTEMPT_FACTORS) {
    const budget = Math.floor(config.ai.handoffContextChars * factor);
    const caps = { itemChars: clamp(Math.floor(budget * 0.1), 500, 6000), fileExcerptChars: clamp(Math.floor(budget * 0.04), 300, REPORT_LIMITS.fileExcerptChars), importantFiles: clamp(Math.round(REPORT_LIMITS.importantFiles * factor), 3, REPORT_LIMITS.importantFiles), routes: clamp(Math.round(REPORT_LIMITS.routes * factor), 10, REPORT_LIMITS.routes), components: clamp(Math.round(25 * factor), 6, 25) };
    const repoItems = []; let used = 0;
    for (const { snapshot, connection, fileText } of loaded) {
      for (const item of repoEvidence(snapshot, connection, fileText, caps)) {
        if (used + item.content.length > budget * 0.55) continue;
        used += item.content.length; repoItems.push(item);
      }
    }
    const { pack, evidence, limitations, counts } = await buildHandoffContext(project, { requireActivity: false, extraLimitations: factor < 1 ? [...extraLimitations, 'The context was reduced to fit the AI provider’s request-size limit, so some details may be missing.'] : extraLimitations, budgetChars: Math.floor(budget * 0.35), includePreviousHandoffs: true, scale: factor, contentChars: clamp(Math.floor(budget * 0.015), 200, 1200) });
    for (const item of repoItems) {
      pack.sources.unshift({ id: item.id, external_id: null, provider: 'repository', record_type: item.type, title: item.title, content: item.content, content_type: 'text/plain', url: item.url, author: null, author_id: null, created_at: null, updated_at: null, fetched_at: null, metadata: {} });
      evidence.set(item.id, { id: item.id, label: item.label, url: item.url, type: item.type, provider: 'repository' });
    }
    try {
      result = { ai: await generate(pack), evidence, limitations, counts };
      reducedTo = factor < 1 ? factor : null;
      break;
    } catch (err) {
      if (err instanceof AiServiceError && TOO_LARGE.test(err.message) && factor !== ATTEMPT_FACTORS.at(-1)) continue;
      if (err instanceof AiServiceError && TOO_LARGE.test(err.message)) throw new AiServiceError('The AI provider rejected the request as too large for its token limit, even after reducing the context. Lower AI_HANDOFF_CONTEXT_CHARS, use a model/tier with a higher limit, or retry in a minute.', { code: err.code, status: 413, endpoint: err.endpoint });
      throw err;
    }
  }
  const { ai, evidence, limitations, counts } = result;
  if (reducedTo) limitations.push(`The AI request was reduced to ${Math.round(reducedTo * 100)}% of the normal context to fit the provider’s limit.`);
  const knownPaths = new Set(snapshots.flatMap((s) => s.fileManifest.map((f) => f.path)));
  const sections = new Map();
  let removedUnverified = 0; let removedUnknownRef = 0;
  for (const section of Array.isArray(ai.sections) ? ai.sections : []) {
    if (!SECTION_ORDER.includes(section?.key) || ['important_files', 'setup', 'links', 'coverage'].includes(section.key) || sections.has(section.key)) continue;
    const items = [];
    for (const claim of Array.isArray(section.claims) ? section.claims : []) {
      if (typeof claim?.text !== 'string' || !claim.text.trim()) continue;
      const ids = (Array.isArray(claim.source_ids) ? claim.source_ids : []).map(String);
      if (ids.some((id) => !evidence.has(id))) { removedUnknownRef += 1; continue; }
      if (unverifiedPaths(claim.text, knownPaths).length) { removedUnverified += 1; continue; }
      const kind = ['fact', 'inference', 'unknown'].includes(claim.kind) ? claim.kind : 'inference';
      items.push({ text: claim.text.trim().slice(0, 1500), kind: !ids.length && kind !== 'unknown' ? 'inference' : kind, evidence: ids.map((id) => ({ id, label: evidence.get(id).label, url: evidence.get(id).url })) });
    }
    if (items.length) sections.set(section.key, { key: section.key, title: SECTION_TITLES[section.key], origin: 'ai', items });
  }
  if (removedUnverified) limitations.push(`${removedUnverified} AI statement(s) were removed because they mentioned file paths that do not exist in the analyzed repository.`);
  if (removedUnknownRef) limitations.push(`${removedUnknownRef} AI statement(s) were removed because they cited unknown sources.`);
  if (!sections.has('executive_summary') && ai.summary) sections.set('executive_summary', { key: 'executive_summary', title: SECTION_TITLES.executive_summary, origin: 'ai', items: [{ text: ai.summary.trim().slice(0, 1500), kind: 'inference', evidence: [] }] });

  const evidenceById = new Map([...evidence.entries()]);
  const det = deterministicSections({ snapshots, connections: connById, syncByRepo, evidenceById, freshnessByRepo });
  for (const [key, items] of Object.entries(det)) sections.set(key, { key, title: SECTION_TITLES[key], origin: 'deterministic', items });

  // Source links: every distinct source cited anywhere, plus the repositories themselves.
  const linkMap = new Map();
  for (const s of sections.values()) for (const it of s.items) for (const e of it.evidence) if (e.url) linkMap.set(e.url, e.label);
  for (const s of snapshots) { const url = connById.get(String(s.connectionId))?.config?.htmlUrl; if (url) linkMap.set(url, s.fullName); }
  sections.set('links', { key: 'links', title: SECTION_TITLES.links, origin: 'deterministic', items: [...linkMap.entries()].slice(0, 80).map(([url, label]) => ({ text: label, kind: 'fact', evidence: [{ id: url, label, url }] })) });

  const ordered = SECTION_ORDER.map((k) => sections.get(k)).filter((s) => s && hasFacts(s));
  const report = await HandoffReport.create({
    projectId: project._id, createdBy: user._id, projectName: project.name, generatedAt: new Date(),
    summary: ai.summary.trim().slice(0, 2000), sections: ordered,
    repositories: snapshots.map((s) => ({ fullName: s.fullName, commitSha: s.commitSha, branch: s.branch, analyzedAt: s.analyzedAt, status: s.status, coverage: { analyzed: s.coverage.analyzed, eligible: s.coverage.eligible, percent: s.coverage.percent }, freshness: freshnessByRepo.get(s.repositoryId)?.state || null, url: connById.get(String(s.connectionId))?.config?.htmlUrl || null })),
    limitations: [...new Set(limitations)].slice(0, 30),
    basedOn: { ...counts, repositories: snapshots.length, evidence: evidence.size },
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
