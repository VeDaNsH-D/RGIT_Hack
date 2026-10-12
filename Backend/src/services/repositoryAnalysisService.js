import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { RepositoryFile } from '../models/RepositoryFile.js';
import { RepositorySnapshot } from '../models/RepositorySnapshot.js';
import { GITHUB_ERROR_CODES, GitHubApiError } from '../modules/ingestion/providers/github/githubErrors.js';
import { ANALYZER_VERSION, categorize, containsSecret, exclusionReason, looksBinary, priorityOf } from '../modules/ingestion/providers/github/repository/repoFilters.js';
import { extractFileFacts } from '../modules/ingestion/providers/github/repository/repoExtractors.js';
import { buildKnowledge } from '../modules/ingestion/providers/github/repository/repoKnowledge.js';
import { SyncError, installationClientFor } from './githubSyncEngine.js';

/**
 * Repository content analysis for one project <-> repository association.
 *
 * Reads the default branch's file tree through the project's GitHub App installation (read-only API calls;
 * nothing is cloned, installed or executed), applies exclusion rules and a budget, fetches changed file
 * blobs only, extracts facts deterministically, and publishes a commit-versioned RepositorySnapshot.
 *
 * Incremental behaviour: file blobs are cached by Git blob SHA, so a re-analysis fetches only added/modified
 * files. If the analyzer version changed (or the previous manifest is missing) the run is labelled "full".
 * A snapshot is published (config.analysis.currentSnapshotId) only when a run reaches completed|partial, and
 * only by the run that still owns the lock, so concurrent jobs can never publish conflicting snapshots.
 */

export const LOCK_TTL_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 14 * 24 * 3600 * 1000;
const SNAPSHOTS_KEPT = 5;

const SAFE = {
  [GITHUB_ERROR_CODES.AUTH_FAILED]: 'GitHub rejected the installation credentials.',
  [GITHUB_ERROR_CODES.FORBIDDEN]: 'Relay does not have permission to read this repository’s contents. Grant the GitHub App “Contents: read” access.',
  [GITHUB_ERROR_CODES.NOT_FOUND]: 'The repository or its default branch was not found or is no longer shared with Relay.',
  [GITHUB_ERROR_CODES.RATE_LIMITED]: 'GitHub rate limit reached. Try again later.',
  [GITHUB_ERROR_CODES.TIMEOUT]: 'GitHub took too long to respond.',
  [GITHUB_ERROR_CODES.NETWORK_ERROR]: 'GitHub could not be reached.',
  INSTALLATION_UNAVAILABLE: 'The GitHub installation was removed or suspended. Reconnect GitHub from Connections.',
  REPOSITORY_MISMATCH: 'The repository behind this connection changed identity (transferred or recreated). Disconnect and reconnect it.',
};
const safeMessage = (code) => SAFE[code] || 'The repository could not be analyzed.';
const FATAL = new Set([GITHUB_ERROR_CODES.AUTH_FAILED, GITHUB_ERROR_CODES.FORBIDDEN, GITHUB_ERROR_CODES.NOT_FOUND, GITHUB_ERROR_CODES.RATE_LIMITED]);

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function acquire(connectionId, runId, now) {
  const cutoff = new Date(now.getTime() - LOCK_TTL_MS);
  return SourceConnection.findOneAndUpdate(
    { _id: connectionId, provider: 'github', $or: [{ 'config.analysis.status': { $ne: 'analyzing' } }, { 'config.analysis.lockedAt': { $lt: cutoff } }] },
    { $set: { 'config.analysis.status': 'analyzing', 'config.analysis.runId': runId, 'config.analysis.lockedAt': now, 'config.analysis.lastAttemptAt': now } },
    { new: false } // pre-lock document: carries the previous status and published snapshot id
  );
}

async function finish(connectionId, runId, fields, unset = {}) {
  const $set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`config.analysis.${k}`, v]));
  const $unset = { 'config.analysis.lockedAt': '', ...Object.fromEntries(Object.keys(unset).map((k) => [`config.analysis.${k}`, ''])) };
  return SourceConnection.findOneAndUpdate({ _id: connectionId, 'config.analysis.runId': runId }, { $set, $unset }, { new: true });
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; await fn(items[i], i); }
  });
  await Promise.all(workers);
}

export function diffManifests(previous, current) {
  const prev = new Map((previous || []).map((f) => [f.path, f]));
  const cur = new Map(current.map((f) => [f.path, f]));
  const added = current.filter((f) => !prev.has(f.path));
  const deleted = (previous || []).filter((f) => !cur.has(f.path));
  const modified = current.filter((f) => prev.has(f.path) && prev.get(f.path).blobSha !== f.blobSha);
  const unchanged = current.length - added.length - modified.length;
  const deletedBySha = new Map(deleted.map((f) => [f.blobSha, f]));
  const renamed = [];
  for (const f of added) { const from = deletedBySha.get(f.blobSha); if (from) { renamed.push({ from: from.path, to: f.path }); deletedBySha.delete(f.blobSha); } }
  const renamedTo = new Set(renamed.map((r) => r.to));
  const renamedFrom = new Set(renamed.map((r) => r.from));
  return {
    added: added.filter((f) => !renamedTo.has(f.path)).map((f) => f.path),
    modified: modified.map((f) => f.path),
    deleted: deleted.filter((f) => !renamedFrom.has(f.path)).map((f) => f.path),
    renamed, unchanged,
  };
}

/** Selects what to analyze under the budget; everything else is counted so coverage stays honest. */
export function planAnalysis(tree, limits) {
  const excluded = {};
  const eligible = [];
  for (const entry of tree) {
    const reason = exclusionReason(entry.path);
    if (reason) excluded[reason] = (excluded[reason] || 0) + 1;
    else eligible.push(entry);
  }
  const tooLarge = eligible.filter((e) => (e.size || 0) > limits.maxFileBytes);
  const candidates = eligible.filter((e) => (e.size || 0) <= limits.maxFileBytes).sort((a, b) => priorityOf(a) - priorityOf(b) || a.path.localeCompare(b.path));
  const selected = [];
  let bytes = 0;
  for (const entry of candidates) {
    if (selected.length >= limits.maxFiles || bytes + (entry.size || 0) > limits.maxTotalBytes) continue;
    selected.push(entry); bytes += entry.size || 0;
  }
  return { excluded, eligible, tooLarge, selected, overBudget: candidates.length - selected.length };
}

function coverageLimitations(c) {
  const out = [];
  if (c.treeTruncated) out.push('GitHub truncated the repository tree, so the file listing is incomplete.');
  if (c.tooLarge) out.push(`${c.tooLarge} file(s) exceeded the size limit and were not analyzed.`);
  if (c.overBudget) out.push(`${c.overBudget} file(s) were not analyzed because the analysis budget (${c.limits.maxFiles} files / ${Math.round(c.limits.maxTotalBytes / 1e6)} MB) was reached; the most important files were prioritized.`);
  if (c.secretSkipped) out.push(`${c.secretSkipped} file(s) were skipped because they appeared to contain credentials.`);
  if (c.fetchFailed) out.push(`${c.fetchFailed} file(s) could not be fetched from GitHub.`);
  if (c.binarySkipped) out.push(`${c.binarySkipped} file(s) were skipped as non-text content.`);
  if (c.truncatedFiles) out.push(`${c.truncatedFiles} large file(s) were analyzed only in part (truncated).`);
  return out;
}

/**
 * How many files a refresh could still gain from a snapshot of the same commit: files whose fetch failed (transient), plus
 * files that were over a limit which has since been raised. Binary, credential-bearing and over-size files are permanent
 * until their content or the limits change, so they never count and never trigger a re-fetch.
 */
export function retryableFiles(coverage, limits = config.githubApp.analysis) {
  if (!coverage) return 0;
  const was = coverage.limits || {};
  let n = coverage.fetchFailed || 0;
  if (coverage.tooLarge && limits.maxFileBytes > (was.maxFileBytes ?? Infinity)) n += coverage.tooLarge;
  if (coverage.overBudget && (limits.maxFiles > (was.maxFiles ?? Infinity) || limits.maxTotalBytes > (was.maxTotalBytes ?? Infinity))) n += coverage.overBudget;
  return n;
}

export function serializeAnalysis(connection, snapshot, latestKnownCommit) {
  const a = connection.config?.analysis || {};
  const lockLive = a.status === 'analyzing' && a.lockedAt && Date.now() - new Date(a.lockedAt).getTime() < LOCK_TTL_MS;
  const running = lockLive;
  const state = running ? 'analyzing' : a.status === 'analyzing' ? 'failed' : a.status || (snapshot ? snapshot.status : 'not_analyzed');
  let freshness = null;
  const reasons = [];
  if (snapshot) {
    if (a.staleAt && new Date(a.staleAt) > new Date(snapshot.analyzedAt)) reasons.push('The repository has new pushes since this analysis.');
    if (latestKnownCommit && latestKnownCommit !== snapshot.commitSha) reasons.push(`A newer commit (${latestKnownCommit.slice(0, 7)}) exists.`);
    if (Date.now() - new Date(snapshot.analyzedAt).getTime() > STALE_AFTER_MS) reasons.push('The analysis is more than 14 days old.');
    freshness = reasons.length ? { state: 'stale', reasons } : { state: 'current', reasons: [] };
  }
  return {
    status: state,
    // The published snapshot stays usable even if a later run failed.
    snapshot: snapshot ? {
      id: String(snapshot._id), commitSha: snapshot.commitSha, branch: snapshot.branch, status: snapshot.status, mode: snapshot.mode,
      analyzedAt: snapshot.analyzedAt, coverage: snapshot.coverage, changes: snapshot.changes,
      overview: snapshot.knowledge?.overview ? { languages: snapshot.knowledge.overview.languages, frameworks: snapshot.knowledge.overview.frameworks } : null,
    } : null,
    freshness,
    // True when the last refresh found nothing new to analyze; `retryable` is what a refresh could still gain without a new commit.
    upToDate: !running && Boolean(a.upToDate),
    retryable: snapshot ? retryableFiles(snapshot.coverage) : 0,
    lastAttemptAt: a.lastAttemptAt || null,
    error: state === 'failed' || a.errorCode ? { code: a.errorCode || 'ERROR', message: a.errorMessage || safeMessage(a.errorCode) } : null,
  };
}

export async function latestCommitSha(projectId, repositoryId) {
  const row = await SourceRecord.findOne({ projectId, provider: 'github', type: 'commit', 'metadata.providerMetadata.repositoryId': repositoryId }).sort({ 'metadata.sourceUpdatedAt': -1 }).select('metadata.providerMetadata.sha').lean();
  return row?.metadata?.providerMetadata?.sha || null;
}

export async function getAnalysisStatus(connection) {
  const id = connection.config?.analysis?.currentSnapshotId;
  const snapshot = id ? await RepositorySnapshot.findById(id).select('-fileManifest -knowledge.components -knowledge.routes -knowledge.models').lean() : null;
  const full = id ? await RepositorySnapshot.findById(id).select('knowledge.overview').lean() : null;
  if (snapshot && full) snapshot.knowledge = full.knowledge;
  const latest = connection.config?.repositoryId ? await latestCommitSha(connection.projectId, connection.config.repositoryId) : null;
  return serializeAnalysis(connection, snapshot, latest);
}

/** Runs one analysis inline. Caller has already authorized the project. Returns the updated connection. */
export async function analyzeConnection(connectionId, { force = false, now = () => new Date(), limits = config.githubApp.analysis } = {}) {
  const startedAt = now();
  const runId = randomUUID();
  const before = await acquire(connectionId, runId, startedAt);
  if (!before) throw new SyncError(409, 'analysis_in_progress', 'An analysis is already running for this repository.');
  const cfg = before.config || {};
  const projectId = before.projectId;
  const fail = async (code) => {
    await finish(connectionId, runId, { status: 'failed', errorCode: code, errorMessage: safeMessage(code), lastAttemptAt: startedAt });
    return SourceConnection.findById(connectionId);
  };

  try {
    let client;
    try { client = await installationClientFor(before); } catch (err) { return await fail(err.code || (err instanceof GitHubApiError ? err.code : 'ERROR')); }
    const base = `/repos/${cfg.owner}/${cfg.repo}`;

    const repoRes = await client.get(base);
    const repo = repoRes.data;
    if (repo?.id !== cfg.repositoryId) return await fail('REPOSITORY_MISMATCH');
    const branch = repo.default_branch;
    const branchRes = await client.get(`${base}/branches/${encodePath(branch)}`);
    const commitSha = branchRes.data?.commit?.sha;
    const treeSha = branchRes.data?.commit?.commit?.tree?.sha;
    if (!commitSha || !treeSha) return await fail('NOT_FOUND');

    const prevId = cfg.analysis?.currentSnapshotId;
    const prev = prevId ? await RepositorySnapshot.findById(prevId).lean() : null;
    // Same commit + same analyzer and nothing a retry could gain (partial included): no tree fetch, no rebuild, no GitHub calls.
    if (!force && prev && prev.commitSha === commitSha && prev.analyzerVersion === ANALYZER_VERSION && ['completed', 'partial'].includes(prev.status) && !retryableFiles(prev.coverage, limits)) {
      await finish(connectionId, runId, { status: prev.status, lastAttemptAt: startedAt, upToDate: true }, { errorCode: 1, errorMessage: 1, staleAt: 1 });
      return SourceConnection.findById(connectionId);
    }

    const treeRes = await client.get(`${base}/git/trees/${treeSha}`, { recursive: '1' });
    const tree = (treeRes.data?.tree || []).filter((e) => e.type === 'blob' && typeof e.path === 'string').map((e) => ({ path: e.path, sha: e.sha, size: e.size || 0 }));
    const treeTruncated = Boolean(treeRes.data?.truncated);
    const plan = planAnalysis(tree, limits);

    // Reuse cached blobs; fetch only what is new or changed.
    const cached = new Set((await RepositoryFile.find({ projectId, repositoryId: cfg.repositoryId, blobSha: { $in: plan.selected.map((e) => e.sha) } }).select('path blobSha').lean()).map((f) => `${f.path}@${f.blobSha}`));
    const missing = plan.selected.filter((e) => !cached.has(`${e.path}@${e.sha}`));
    // Blobs are content-addressed: a renamed/copied file reuses the stored text without a GitHub request.
    const sameContent = missing.length ? await RepositoryFile.find({ projectId, repositoryId: cfg.repositoryId, blobSha: { $in: missing.map((e) => e.sha) } }).select('+content').lean() : [];
    const byBlob = new Map(sameContent.map((f) => [f.blobSha, f]));
    // Files already fetched and found permanently unusable at this exact blob (binary / credentials) are not fetched again.
    const sameAnalyzer = prev && prev.analyzerVersion === ANALYZER_VERSION && Array.isArray(prev.skipped);
    const priorSkips = new Map(!force && sameAnalyzer ? prev.skipped.map((x) => [`${x.path}@${x.blobSha}`, x.reason]) : []);
    const skippedNow = [];
    let fetchedOk = 0;
    const toFetch = [];
    for (const e of missing) {
      const donor = byBlob.get(e.sha);
      if (donor) await RepositoryFile.updateOne({ projectId, repositoryId: cfg.repositoryId, path: e.path, blobSha: e.sha }, { $set: { size: donor.size, truncated: donor.truncated, content: donor.content } }, { upsert: true });
      else toFetch.push(e);
    }
    const skip = { binary: 0, secret: 0, failed: 0, truncated: 0 };
    const unusable = new Set();
    let fatal = null;
    await mapLimit(toFetch, limits.concurrency, async (entry) => {
      const prior = priorSkips.get(`${entry.path}@${entry.sha}`);
      if (prior) { skip[prior] += 1; unusable.add(entry.path); skippedNow.push({ path: entry.path, blobSha: entry.sha, reason: prior }); return; }
      if (fatal) { skip.failed += 1; unusable.add(entry.path); return; }
      try {
        const blob = await client.get(`${base}/git/blobs/${entry.sha}`);
        let text = Buffer.from(blob.data?.content || '', blob.data?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
        if (looksBinary(text)) { skip.binary += 1; unusable.add(entry.path); skippedNow.push({ path: entry.path, blobSha: entry.sha, reason: 'binary' }); return; }
        if (containsSecret(text)) { skip.secret += 1; unusable.add(entry.path); skippedNow.push({ path: entry.path, blobSha: entry.sha, reason: 'secret' }); return; }
        const truncated = text.length > limits.maxFileChars;
        if (truncated) { text = text.slice(0, limits.maxFileChars); skip.truncated += 1; }
        await RepositoryFile.updateOne({ projectId, repositoryId: cfg.repositoryId, path: entry.path, blobSha: entry.sha }, { $set: { size: entry.size, truncated, content: text } }, { upsert: true });
        fetchedOk += 1;
      } catch (err) {
        skip.failed += 1; unusable.add(entry.path);
        if (err instanceof GitHubApiError && FATAL.has(err.code)) fatal = err;
      }
    });

    const analyzedEntries = plan.selected.filter((e) => !unusable.has(e.path));
    const stored = !analyzedEntries.length ? [] : await RepositoryFile.find({ projectId, repositoryId: cfg.repositoryId, $or: analyzedEntries.map((e) => ({ path: e.path, blobSha: e.sha })) }).select('+content').lean();
    const byKey = new Map(stored.map((f) => [`${f.path}@${f.blobSha}`, f]));
    const known = new Set(analyzedEntries.map((e) => e.path));
    const files = [];
    for (const e of analyzedEntries) {
      const row = byKey.get(`${e.path}@${e.sha}`);
      if (!row) { skip.failed += 1; continue; }
      files.push({ path: e.path, blobSha: e.sha, size: e.size, truncated: row.truncated, facts: extractFileFacts(e.path, row.content, known), text: row.content });
    }
    const truncatedFiles = files.filter((f) => f.truncated).length + 0;
    const knowledge = buildKnowledge({ repository: { description: repo.description, defaultBranch: branch }, tree, files: files.map(({ text, ...f }) => f), readmeText: files.find((f) => /^readme/i.test(f.path))?.text });

    const coverage = {
      treeEntries: tree.length, treeTruncated,
      excludedTotal: Object.values(plan.excluded).reduce((a, b) => a + b, 0), excluded: plan.excluded,
      eligible: plan.eligible.length, analyzed: files.length,
      tooLarge: plan.tooLarge.length, overBudget: plan.overBudget,
      binarySkipped: skip.binary, secretSkipped: skip.secret, fetchFailed: skip.failed, truncatedFiles,
      limits: { maxFiles: limits.maxFiles, maxFileBytes: limits.maxFileBytes, maxTotalBytes: limits.maxTotalBytes },
    };
    coverage.percent = coverage.eligible ? Math.round((coverage.analyzed / coverage.eligible) * 100) : 100;
    const limitations = coverageLimitations(coverage);
    knowledge.limitations = limitations;
    const incomplete = limitations.length > 0 || Boolean(fatal);
    const status = files.length === 0 && plan.eligible.length > 0 ? 'failed' : incomplete ? 'partial' : 'completed';
    if (status === 'failed') return await fail(fatal?.code || 'ERROR');

    const manifest = files.map((f) => ({ path: f.path, blobSha: f.blobSha, size: f.size, category: f.facts.category }));
    const sameVersion = prev && prev.analyzerVersion === ANALYZER_VERSION && Array.isArray(prev.fileManifest);
    const snapshot = await RepositorySnapshot.create({
      projectId, connectionId, repositoryId: cfg.repositoryId, fullName: repo.full_name, branch, commitSha, analyzerVersion: ANALYZER_VERSION,
      status, mode: sameVersion ? 'incremental' : 'full', analyzedAt: now(), coverage,
      changes: { ...diffManifests(sameVersion ? prev.fileManifest : [], manifest), fetched: fetchedOk },
      fileManifest: manifest, skipped: skippedNow, knowledge,
    });

    const published = await finish(connectionId, runId, {
      status, currentSnapshotId: snapshot._id, lastAttemptAt: startedAt, upToDate: false,
      lastSuccessAt: now(),
    }, { errorCode: 1, errorMessage: 1, staleAt: 1 });
    if (!published) { // lost the lock (expired and taken over): never publish alongside the newer run
      await RepositorySnapshot.deleteOne({ _id: snapshot._id });
      throw new SyncError(409, 'analysis_superseded', 'A newer analysis took over this repository.');
    }

    // Garbage-collect content no longer referenced, and old snapshots.
    const keep = manifest.map((f) => ({ path: f.path, blobSha: f.blobSha }));
    await RepositoryFile.deleteMany({ projectId, repositoryId: cfg.repositoryId, ...(keep.length ? { $nor: keep } : {}) });
    const old = await RepositorySnapshot.find({ connectionId }).sort({ analyzedAt: -1 }).skip(SNAPSHOTS_KEPT).select('_id').lean();
    if (old.length) await RepositorySnapshot.deleteMany({ _id: { $in: old.map((o) => o._id) } });
    return published;
  } catch (err) {
    if (err instanceof SyncError && err.code === 'analysis_superseded') throw err;
    return fail(err instanceof GitHubApiError ? err.code : 'ERROR');
  }
}

/** Removes everything stored for a repository (disconnect or project deletion). */
export async function purgeRepositoryKnowledge({ projectId, repositoryId, connectionId }) {
  await Promise.all([
    RepositorySnapshot.deleteMany({ projectId, ...(connectionId ? { connectionId } : { repositoryId }) }),
    RepositoryFile.deleteMany({ projectId, repositoryId }),
  ]);
}
