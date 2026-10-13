import { createHash } from 'node:crypto';
import { HandoffReport } from '../models/HandoffReport.js';
import { RepositoryFile } from '../models/RepositoryFile.js';
import { RepositorySnapshot } from '../models/RepositorySnapshot.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { Task } from '../models/Task.js';
import { config } from '../config.js';
import { AiServiceError, generateDeveloperHandoff as callAi } from './aiClient.js';
import { DraftError, buildHandoffContext } from './handoffDraftService.js';
import { addDocumentLinkHints } from './documentContext.js';
import { addJiraKeyLinks } from './crossLinks.js';
import { serializeAnalysis, latestCommitSha } from './repositoryAnalysisService.js';
import { serializeSync } from './githubSyncEngine.js';
import { buildSymbolTable, buildVerification, classifyComplexity, verificationNotes } from './engineeringState.js';
import { evidenceRef, pathTokens, unverifiedPaths, validateHandoff, validationNote } from './handoffValidation.js';
import { SECTION_ORDER, assembleReport, setupItems } from './handoffAssembly.js';

/**
 * Repository-aware engineering handoff REPORT (independent of the team ownership-transfer Handoff).
 *
 *   evidence   repository knowledge + the source of the files that matter (all of them for a small repository),
 *              GitHub activity, Relay tasks/notes, documents, Jira, Slack      -> ONE ContextPackRequest
 *   AIML       /api/v1/developer-handoff/generate -> structured engineering state (citation ids checked there)
 *   validate   handoffValidation: paths/symbols against the analyzed commit, evidence classes, no completion or
 *              execution claims, contradictions against deterministic facts, de-duplication
 *   assemble   handoffAssembly: first-page brief + adaptive sections + compact source index (single structure that the
 *              preview and the PDF both render)
 *
 * Verification status, setup, open work, recent activity, coverage and links are deterministic: the model never states them.
 */

export { evidenceRef, pathTokens, unverifiedPaths, SECTION_ORDER };

// Tight on purpose: the model gets what it needs to SYNTHESIZE, sized by repository complexity.
export const REPORT_LIMITS = Object.freeze({ fileExcerptChars: 900, importantFiles: 8, routes: 40 });
const FILE_PLAN = { small: { files: 12, chars: 6000, share: 0.62 }, medium: { files: 8, chars: 1400, share: 0.5 }, large: { files: 10, chars: 1000, share: 0.45 } };
export const REPORT_ACTIVITY_LIMITS = Object.freeze({ openPrs: 12, openIssues: 15, recentClosedPrs: 6, commits: 12, notes: 8, tasks: 25, jiraOpen: 10, jiraDone: 3, slack: 8 });
// Bump when the prompt, pack format or output contract changes, so cached reports are not reused across incompatible versions.
export const PIPELINE_VERSION = 6;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// Provider-side "request too large" / tokens-per-minute failures: retry once or twice with less context.
const TOO_LARGE = /\b413\b|request too large|tokens per minute|reduce your message size/i;
const ATTEMPT_FACTORS = [1, 0.5, 0.25];

export class ReportError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const blobUrl = (htmlUrl, sha, path) => (htmlUrl ? `${htmlUrl}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}` : null);
const short = (sha) => String(sha || '').slice(0, 7);

function repoEvidence(snapshot, connection, fileText, symbolsText, caps) {
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
  // The definitions, imports, routes and textual call sites carry the actual implementation detail: they come right after the overview.
  if (symbolsText) items.push({ id: `repo:${id}:symbols`, title: 'functions and classes', type: 'repository_symbols', content: symbolsText.slice(0, caps.symbolChars ?? caps.itemChars ?? 6000), url: htmlUrl, label: `${label} functions and classes` });
  if (k.components?.length && caps.complexity !== 'small') add('components', 'components', 'repository_components', k.components.slice(0, caps.components ?? 25).map((c) => `${c.name}: ${c.fileCount} files; ${c.languages.join('/')}; key files: ${c.keyFiles.join(', ')}${c.routeCount ? `; ${c.routeCount} routes` : ''}${c.models.length ? `; models: ${c.models.join(', ')}` : ''}${c.dependsOn.length ? `; imports from: ${c.dependsOn.join(', ')}` : ''}${c.description ? `; README: ${c.description}` : ''}`).join('\n'));
  if (k.routes?.length) add('routes', 'API routes', 'repository_routes', k.routes.slice(0, caps.routes).map((r) => `${r.method} ${r.path} (${r.file}:${r.line})`).join('\n'));
  if (k.models?.length) add('models', 'data models', 'repository_models', k.models.map((m) => `${m.name} [${m.kind}] (${m.file}:${m.line})`).join('\n'));
  if (k.dependencies?.length) add('dependencies', 'dependencies', 'repository_dependencies', k.dependencies.map((d) => `${d.file}${d.name ? ` (${d.name})` : ''}: ${d.top.join(', ')}${d.count > d.top.length ? ` and ${d.count - d.top.length} more` : ''}`).join('\n'));
  for (const [path, text] of fileText) {
    items.push({ id: `file:${id}:${path}`, title: path, type: 'file', content: text.slice(0, caps.fileExcerptChars), url: blobUrl(htmlUrl, snapshot.commitSha, path), label: `${snapshot.fullName}/${path}@${short(snapshot.commitSha)}` });
  }
  return items;
}

/**
 * Files whose content the model gets: everything for a small repository; otherwise entry points, routes, schemas, manifests
 * and docs first, then the largest remaining source files (they carry the most logic), tests last.
 */
function filesToLoad(snapshot, complexity) {
  const plan = FILE_PLAN[complexity];
  const manifest = snapshot.fileManifest || [];
  if (complexity === 'small') return manifest.slice(0, plan.files).map((f) => f.path);
  const rank = { entrypoint: 0, route: 1, schema: 1, manifest: 2, readme: 2, doc: 4, source: 3, config: 5, deploy: 5, test: 8 };
  const k = snapshot.knowledge;
  const preferred = [...(k.entryPoints || []), ...(k.importantFiles || []).map((f) => f.path)].filter((p) => manifest.some((f) => f.path === p));
  const rest = manifest.filter((f) => !preferred.includes(f.path)).sort((a, b) => (rank[a.category] ?? 6) - (rank[b.category] ?? 6) || (b.size || 0) - (a.size || 0)).map((f) => f.path);
  return [...new Set([...preferred, ...rest])].slice(0, plan.files);
}

const hasItems = (s) => s.items.length > 0;


export async function generateDeveloperHandoffReport(project, user, { generate = callAi, force = false } = {}) {
  const connections = await SourceConnection.find({ projectId: project._id, provider: 'github' }).lean();
  const connById = new Map(connections.map((c) => [String(c._id), c]));
  const snapshotIds = connections.map((c) => c.config?.analysis?.currentSnapshotId).filter(Boolean);
  const snapshots = snapshotIds.length ? await RepositorySnapshot.find({ _id: { $in: snapshotIds }, projectId: project._id }).lean() : [];
  if (!snapshots.length) throw new ReportError(409, 'analysis_required', 'Analyze a connected repository first. The handoff is built from repository knowledge as well as project activity.');

  const complexity = classifyComplexity(snapshots);
  const plan = FILE_PLAN[complexity];
  const knownPaths = new Set(snapshots.flatMap((s) => s.fileManifest.map((f) => f.path)));
  const freshnessByRepo = new Map(); const syncByRepo = new Map(); const extraLimitations = []; const loaded = [];
  for (const snapshot of snapshots) {
    const connection = connById.get(String(snapshot.connectionId));
    const analysis = serializeAnalysis(connection, snapshot, await latestCommitSha(project._id, snapshot.repositoryId));
    freshnessByRepo.set(snapshot.repositoryId, analysis.freshness);
    syncByRepo.set(snapshot.repositoryId, serializeSync(connection.config?.sync));
    if (snapshot.status === 'partial') extraLimitations.push(`Repository analysis of ${snapshot.fullName} is partial (${snapshot.coverage.percent}% of eligible files). Do not assume unanalyzed files do not exist.`);
    if (analysis.freshness?.state === 'stale') extraLimitations.push(`The analysis of ${snapshot.fullName} is stale: ${analysis.freshness.reasons.join(' ')}`);
    for (const l of snapshot.knowledge.limitations || []) extraLimitations.push(`${snapshot.fullName}: ${l}`);
    const paths = filesToLoad(snapshot, complexity);
    const rows = paths.length ? await RepositoryFile.find({ projectId: project._id, repositoryId: snapshot.repositoryId, $or: paths.map((path) => ({ path, blobSha: snapshot.fileManifest.find((f) => f.path === path)?.blobSha })) }).select('+content').lean() : [];
    const byPath = new Map(rows.map((r) => [r.path, r.content]));
    const fileText = new Map(paths.filter((p) => byPath.has(p)).map((p) => [p, byPath.get(p)]));
    loaded.push({ snapshot, connection, fileText, ...buildSymbolTable(fileText, knownPaths) });
  }
  const symbols = new Map(loaded.flatMap(({ table }) => [...table]));
  const symbolInfo = new Map(loaded.flatMap(({ info }) => [...info]));
  const callEdges = loaded.flatMap(({ edges }) => edges);

  // Exact (uncapped) tracker counts: the facts the report may state about open work.
  const pid = project._id;
  const [openPullRequests, openIssues, openJiraCount, openTasks, jiraLinked] = await Promise.all([
    SourceRecord.countDocuments({ projectId: pid, provider: 'github', type: 'pull_request', 'metadata.providerMetadata.state': 'open' }),
    SourceRecord.countDocuments({ projectId: pid, provider: 'github', type: 'issue', 'metadata.providerMetadata.state': 'open' }),
    SourceRecord.countDocuments({ projectId: pid, provider: 'jira', 'metadata.isActive': true }),
    Task.countDocuments({ projectId: pid, status: 'open' }),
    SourceConnection.exists({ projectId: pid, provider: 'jira' }),
  ]);

  // One attempt per context size: a provider "request too large" error retries with a smaller prompt.
  let result = null; let reducedTo = null; let fingerprint = null;
  for (const factor of ATTEMPT_FACTORS) {
    const budget = Math.floor(config.ai.handoffContextChars * factor);
    const caps = { complexity, itemChars: clamp(Math.floor(budget * 0.1), 500, 6000), symbolChars: clamp(Math.floor(budget * 0.25), 800, 6000), fileExcerptChars: clamp(Math.floor(budget * (complexity === 'small' ? 0.4 : 0.1)), 300, plan.chars), routes: clamp(Math.round(REPORT_LIMITS.routes * factor), 10, REPORT_LIMITS.routes), components: clamp(Math.round(25 * factor), 6, 25) };
    const repoItems = []; let used = 0;
    for (const { snapshot, connection, fileText, text } of loaded) {
      for (const item of repoEvidence(snapshot, connection, fileText, text, caps)) {
        if (used + item.content.length > budget * plan.share) continue;
        used += item.content.length; repoItems.push(item);
      }
    }
    const queryHints = loaded.flatMap(({ snapshot }) => [...(snapshot.knowledge.components || []).map((c) => c.name), ...(snapshot.knowledge.overview?.frameworks || []), snapshot.fullName]);
    const context = await buildHandoffContext(project, { requireActivity: false, extraLimitations: factor < 1 ? [...extraLimitations, 'The context was reduced to fit the AI provider’s request-size limit, so some details may be missing.'] : extraLimitations, budgetChars: Math.floor(budget * 0.3), includePreviousHandoffs: true, includeDocuments: true, documentBudgetChars: Math.floor(budget * 0.25), queryHints, limits: REPORT_ACTIVITY_LIMITS, scale: factor, contentChars: clamp(Math.floor(budget * 0.015), 200, 1200),
      contextNotes: ({ documents }) => {
        const v = buildVerification({ snapshots, freshnessByRepo, syncByRepo, openTasks, documents: { included: documents.included.map((d) => ({ title: d.title })), notIndexed: documents.notIndexed }, openWork: { openPullRequests, openIssues, openJira: jiraLinked ? openJiraCount : null } });
        return verificationNotes(v, complexity, snapshots.map((s) => `${s.fullName}: ${s.coverage.analyzed} files analyzed`).join('; '));
      } });
    const { pack, evidence, limitations, counts, documents, activity, integrations } = context;
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
  if (reducedTo) limitations.push(`The AI request was reduced to ${Math.round(reducedTo * 100)}% of the normal context to fit the provider’s limit.`);

  const verification = buildVerification({ snapshots, freshnessByRepo, syncByRepo, openTasks, documents: { included: documents.included.map((d) => ({ title: d.title })), notIndexed: documents.notIndexed }, openWork: { openPullRequests, openIssues, openJira: jiraLinked ? openJiraCount : null }, integrations });
  const primary = snapshots[0];
  const fallbackSummary = `${primary.fullName}${primary.knowledge.overview?.languages?.[0] ? ` is a ${primary.knowledge.overview.languages[0].language} repository` : ''}${primary.knowledge.overview?.purposeFromReadme ? `: ${primary.knowledge.overview.purposeFromReadme.replace(/\s+/g, ' ').slice(0, 200)}` : ''}.`;
  const docText = new Map(sentPack.sources.filter((x) => x.provider === 'document').map((x) => [x.id, x.content]));
  const evidenceText = new Map(sentPack.sources.map((x) => [x.id, x.content || '']));
  const { state, removed } = validateHandoff(ai, { evidence, knownPaths, symbols, symbolInfo, callEdges, docText, evidenceText, verification, fallbackSummary });
  const note = validationNote(removed);
  if (note) limitations.push(note);

  const setup = setupItems({ snapshots, connections: connById });
  const extraUnknowns = [];
  if (!setup.length) extraUnknowns.push({ text: 'No setup, build or run instructions were found in the analyzed README or manifests.', ids: [] });
  const startFallback = snapshots.flatMap((s) => (s.knowledge.entryPoints || []).slice(0, 3).map((p) => ({ text: `${p}: entry point`, kind: 'fact', type: 'start', files: [p], evidence: [{ id: `file:${s.repositoryId}:${p}`, label: `${s.fullName}/${p}@${short(s.commitSha)}`, url: blobUrl(connById.get(String(s.connectionId))?.config?.htmlUrl, s.commitSha, p), type: 'repository_file' }] })));
  const { brief, sections, sourceIndex } = assembleReport({ state, evidence, activity, setup, startFallback, extraUnknowns, verification });
  for (const i of integrations || []) if (!i.sync?.lastSuccessAt) limitations.push(`${i.label} has no successful sync.`);

  const report = await HandoffReport.create({
    projectId: project._id, createdBy: user._id, projectName: project.name, generatedAt: new Date(),
    summary: (brief.summary || fallbackSummary).slice(0, 2000), complexity, brief, verification, sections: sections.filter(hasItems), sourceIndex,
    repositories: snapshots.map((s) => ({ fullName: s.fullName, commitSha: s.commitSha, branch: s.branch, analyzedAt: s.analyzedAt, status: s.status, coverage: { analyzed: s.coverage.analyzed, eligible: s.coverage.eligible, percent: s.coverage.percent }, freshness: freshnessByRepo.get(s.repositoryId)?.state || null, url: connById.get(String(s.connectionId))?.config?.htmlUrl || null })),
    limitations: [...new Set(limitations)].slice(0, 30),
    basedOn: { ...counts, fingerprint, repositories: snapshots.length, evidence: evidence.size, documentsNotIndexed: documents.notIndexed.length, validation: removed },
  });
  return serializeReport(report);
}

export function serializeReport(r) {
  return {
    id: String(r._id), projectId: String(r.projectId), projectName: r.projectName, generatedAt: r.generatedAt, summary: r.summary,
    complexity: r.complexity || null, brief: r.brief || null, verification: r.verification || null, sourceIndex: r.sourceIndex || [],
    sections: r.sections, repositories: r.repositories, limitations: r.limitations, basedOn: r.basedOn,
  };
}
export const serializeReportMeta = (r) => ({ id: String(r._id), generatedAt: r.generatedAt, repositories: (r.repositories || []).map((x) => ({ fullName: x.fullName, commitSha: x.commitSha, status: x.status })), createdBy: String(r.createdBy) });

export { DraftError };
