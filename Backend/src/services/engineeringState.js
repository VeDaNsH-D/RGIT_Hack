import { extractFileFacts } from '../modules/ingestion/providers/github/repository/repoExtractors.js';

/**
 * Deterministic engineering state: everything a handoff may say about verification, completion and coverage, computed from
 * data rather than generated. The model is told these facts (and may not contradict them); the validator removes
 * statements that do; the renderer prints them as the "verification status" block.
 *
 * Relay reads repository files and tracker data. It never executes code and ingests no CI or test-run results, so
 * "tests executed" and "runtime verified" are always reported as unavailable, and completion as not established.
 */

const RANK = { small: 0, medium: 1, large: 2 };
const CODE_CATEGORIES = new Set(['source', 'entrypoint', 'route', 'schema', 'test']);

/** small / medium / large from analyzed code volume and structure; the report adapts its depth to this. */
export function classifyComplexity(snapshots) {
  let level = 'small';
  for (const s of snapshots) {
    const analyzed = s.coverage?.analyzed ?? (s.fileManifest || []).length;
    const components = (s.knowledge?.components || []).length;
    const routes = (s.knowledge?.routes || []).length;
    const code = (s.fileManifest || []).filter((f) => CODE_CATEGORIES.has(f.category)).length;
    let l = 'medium';
    if (analyzed <= 12 && components <= 2 && routes <= 5 && code <= 8) l = 'small';
    else if (analyzed >= 60 || components >= 8 || routes >= 30 || code >= 40) l = 'large';
    if (RANK[l] > RANK[level]) level = l;
  }
  if (snapshots.length > 1 && level === 'small') level = 'medium';
  return level;
}

/** Tests that exist in the analyzed files (not tests that were run). */
export function testEvidence(snapshots) {
  const files = []; const scripts = []; const frameworks = new Set(); const ci = [];
  for (const s of snapshots) {
    for (const f of s.fileManifest || []) if (f.category === 'test') files.push(f.path);
    for (const b of s.knowledge?.buildAndTest || []) if (/^test/i.test(b.name)) scripts.push({ name: b.name, command: b.command, file: b.file });
    for (const fw of s.knowledge?.overview?.frameworks || []) if (['Jest', 'pytest'].includes(fw)) frameworks.add(fw);
    for (const d of s.knowledge?.deploy || []) if (/(\.github\/workflows\/|\.gitlab-ci|jenkinsfile)/i.test(d)) ci.push(d);
  }
  return { fileCount: files.length, files: files.slice(0, 8), scripts: scripts.slice(0, 5), frameworks: [...frameworks], ci: ci.slice(0, 5) };
}

/**
 * @param {Object} input
 * @param {Array} input.snapshots
 * @param {Map} input.freshnessByRepo
 * @param {{ openPullRequests: number, openIssues: number, openJira: number|null }} input.openWork exact counts, not capped samples
 * @param {Array<{ provider: string, label: string, sync: Object }>} input.integrations linked Slack/Jira
 * @param {{ included: Array, notIndexed: Array }} input.documents
 * @param {Object} [input.githubSync] per-repository sync summaries, keyed by repositoryId
 * @param {number} input.openTasks
 */
export function buildVerification({ snapshots, freshnessByRepo, openWork, integrations = [], documents, syncByRepo = new Map(), openTasks = 0 }) {
  const discovered = testEvidence(snapshots);
  const docTitles = documents.included.map((d) => d.title);
  const requirements = docTitles.length
    ? { status: 'documents_provided', documents: docTitles, detail: `${docTitles.length} uploaded document(s) were provided (${docTitles.slice(0, 4).join('; ')}). Documented intent is compared with the code only where cited evidence supports it.` }
    : { status: 'none_provided', documents: [], detail: 'No requirements documents were provided, so completion against requirements cannot be assessed.' };

  const syncs = snapshots.map((s) => ({ repository: s.fullName, ...(syncByRepo.get(s.repositoryId) || {}) }));
  const syncCaveat = syncs.some((x) => x.status && x.status !== 'completed') ? ' GitHub sync was not fully successful, so these counts may be incomplete.' : '';
  const trackerEmpty = openWork.openPullRequests === 0 && openWork.openIssues === 0 && !openWork.openJira && openTasks === 0;
  const workTracking = {
    openPullRequests: openWork.openPullRequests, openIssues: openWork.openIssues, openJira: openWork.openJira, openTasks,
    detail: trackerEmpty
      ? `No open issues, pull requests${openWork.openJira === null ? '' : ', Jira issues'} or Relay tasks were found in the synced data. This describes the trackers only; it does not show that the work is complete.${syncCaveat}`
      : `Open in the synced trackers: ${openWork.openPullRequests} pull request(s), ${openWork.openIssues} issue(s)${openWork.openJira === null ? '' : `, ${openWork.openJira} Jira issue(s)`}, ${openTasks} Relay task(s).${syncCaveat}`,
  };

  const reasons = [];
  if (requirements.status === 'none_provided') reasons.push('no requirements were provided to compare against');
  reasons.push('no tests were executed', 'runtime behaviour was not verified');
  if (!trackerEmpty) reasons.push('work is still open in the trackers');
  const completion = { status: 'not_established', detail: `Completion is not established: ${reasons.join('; ')}.` };

  const executedDetail = 'No test results are available: Relay reads repository files and tracker data, it does not run code, and no CI or test-run results are ingested.';
  const tests = {
    discovered,
    executed: { status: 'none_available', detail: discovered.fileCount || discovered.scripts.length
      ? `${executedDetail} ${discovered.fileCount} test file(s)${discovered.scripts.length ? ` and ${discovered.scripts.length} test script(s)` : ''} were found but not executed.`
      : `${executedDetail} No test files or test scripts were found in the analyzed files.` },
  };

  const coverage = snapshots.map((s) => {
    const c = s.coverage || {};
    const gaps = [];
    if (c.tooLarge) gaps.push(`${c.tooLarge} file(s) over the size limit`);
    if (c.overBudget) gaps.push(`${c.overBudget} file(s) beyond the analysis budget`);
    if (c.secretSkipped) gaps.push(`${c.secretSkipped} file(s) skipped (credentials)`);
    if (c.binarySkipped) gaps.push(`${c.binarySkipped} non-text file(s)`);
    if (c.fetchFailed) gaps.push(`${c.fetchFailed} file(s) failed to load`);
    const f = freshnessByRepo.get(s.repositoryId);
    return { repository: s.fullName, branch: s.branch, commit: s.commitSha, status: s.status, analyzed: c.analyzed, eligible: c.eligible, percent: c.percent, freshness: f?.state || null, staleReasons: f?.state === 'stale' ? f.reasons : [], gaps, analyzedAt: s.analyzedAt };
  });

  return {
    tests,
    runtime: { status: 'not_verified', detail: 'Not verified: the code was not executed and no runtime results are available.' },
    requirements, workTracking, completion, coverage,
    integrations: integrations.map((i) => ({ label: i.label, provider: i.provider, status: i.sync?.status || 'pending', lastSuccessAt: i.sync?.lastSuccessAt || null })),
  };
}

/** The authoritative facts the model is told (and may not contradict); appended to the request notes. */
export function verificationNotes(v, complexity, repoSummaries) {
  const t = v.tests.discovered;
  const parts = [
    `[Complexity] ${complexity}${repoSummaries ? ` (${repoSummaries})` : ''}.`,
    `[Verification facts] Tests discovered: ${t.fileCount ? `${t.fileCount} file(s)${t.frameworks.length ? ` (${t.frameworks.join(', ')})` : ''}` : 'none'}${t.scripts.length ? `; test scripts: ${t.scripts.map((x) => x.name).join(', ')}` : ''}. Tests executed: none; no test or CI results exist. Runtime verified: no, nothing was executed.`,
    `Requirements documents: ${v.requirements.status === 'documents_provided' ? v.requirements.documents.length : 'none uploaded'}.`,
    `Open in trackers: ${v.workTracking.openPullRequests} PRs, ${v.workTracking.openIssues} issues${v.workTracking.openJira === null ? '' : `, ${v.workTracking.openJira} Jira`}, ${v.workTracking.openTasks} tasks${v.workTracking.openPullRequests + v.workTracking.openIssues + (v.workTracking.openJira || 0) + v.workTracking.openTasks === 0 ? ' (an empty tracker does not mean the work is complete)' : ''}.`,
    'Completion is not established.',
  ];
  return parts.join(' ');
}

const LANG_BY_EXT = { py: 'py', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', go: 'go' };
const DEF_PATTERNS = {
  py: [/^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/, /^([ \t]*)class\s+(\w+)/],
  js: [/^([ \t]*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)\s*\(/, /^([ \t]*)(?:export\s+)?class\s+(\w+)/, /^([ \t]*)(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/],
  go: [/^()func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/],
};

/**
 * Every function/class definition in a file, nested and underscore-prefixed ones included (the symbol extractor used for
 * knowledge only keeps exported/top-level names). Textual, not a parse: it is the allow-list a report may name and the
 * basis of the call edges below.
 */
export function scanDefinitions(path, text) {
  const lang = LANG_BY_EXT[path.split('.').pop().toLowerCase()];
  if (!lang) return [];
  const out = [];
  String(text).split('\n').forEach((raw, i) => {
    for (const re of DEF_PATTERNS[lang]) {
      const m = re.exec(raw);
      if (m) { out.push({ name: m[2], line: i + 1, indent: m[1].length, signature: raw.trim().replace(/\s+/g, ' ').slice(0, 110) }); break; }
    }
  });
  return out;
}

const CALL_KEYWORDS = new Set(['if', 'for', 'while', 'return', 'print', 'range', 'len', 'super', 'switch', 'catch', 'function', 'def', 'class', 'await', 'new']);

/**
 * Textual call sites between known definitions ("update calls generate_signals", line 41). A call is attributed to the closest
 * preceding definition; this is a reading aid, not proof of runtime behaviour, and is labelled that way wherever it is shown.
 * @param {Map<string, string>} fileText  path -> content
 * @param {Set<string>} names             definition names worth tracking (all files of the report)
 */
export function callEdges(fileText, names) {
  const edges = []; const seen = new Set();
  for (const [path, text] of fileText) {
    const defs = scanDefinitions(path, text);
    if (!defs.length) continue;
    const defLines = new Map(defs.map((d) => [d.line, d]));
    text.split('\n').forEach((raw, i) => {
      const lineNo = i + 1;
      if (defLines.has(lineNo) || /^\s*(?:#|\/\/|\*)/.test(raw)) return;
      let owner = null;
      for (const d of defs) { if (d.line < lineNo) owner = d; else break; }
      if (!owner) return;
      for (const m of raw.matchAll(/(?<![\w.])(\w+)\s*\(/g)) {
        const callee = m[1];
        if (callee === owner.name || CALL_KEYWORDS.has(callee) || !names.has(callee)) continue;
        const key = `${path}|${owner.name}|${callee}`;
        if (!seen.has(key)) { seen.add(key); edges.push({ file: path, from: owner.name, to: callee, line: lineNo }); }
      }
    });
  }
  return edges;
}

/**
 * path -> symbols extracted (deterministically) from the analyzed content of that file; the only symbols a report may name.
 * `info` adds line numbers/signatures and `edges` the textual call sites; `text` is the compact evidence block sent to the model.
 */
export function buildSymbolTable(fileText, knownPaths) {
  const table = new Map(); const info = new Map(); const detail = [];
  const defsByPath = new Map();
  for (const [path, text] of fileText) defsByPath.set(path, scanDefinitions(path, text));
  const allNames = new Set([...defsByPath.values()].flat().map((d) => d.name));
  const edges = callEdges(fileText, allNames);
  for (const [path, text] of fileText) {
    let facts = {};
    try { facts = extractFileFacts(path, text, knownPaths); } catch { /* unsupported file type: definitions alone are still useful */ }
    const defs = defsByPath.get(path) || [];
    const syms = [...(facts.symbols || []).map((s) => ({ name: s.name, line: s.line, signature: s.signature || s.name })), ...defs];
    const byName = new Map();
    for (const s of syms) if (!byName.has(s.name)) byName.set(s.name, s);
    const main = /^if\s+__name__\s*==\s*['"]__main__['"]/m.test(text);
    if (byName.size || main) {
      table.set(path, new Set(byName.keys()));
      info.set(path, byName);
      const shown = [...byName.values()].sort((a, b) => a.line - b.line).slice(0, 16);
      const parts = [shown.map((s) => `${s.signature || s.name} L${s.line}`).join('; ')];
      if (main) parts.push('has an if __name__ == "__main__" entry block');
      if (facts.imports?.length) parts.push(`imports from this repo: ${facts.imports.slice(0, 6).join(', ')}`);
      if (facts.routes?.length) parts.push(`routes: ${facts.routes.slice(0, 8).map((r) => `${r.method} ${r.path} L${r.line}`).join(', ')}`);
      const mine = edges.filter((e) => e.file === path).slice(0, 10);
      if (mine.length) parts.push(`textual call sites: ${mine.map((e) => `${e.from} -> ${e.to} L${e.line}`).join(', ')}`);
      detail.push(`${path}: ${parts.filter(Boolean).join(' | ')}`);
    }
  }
  return { table, info, edges, text: detail.join('\n') };
}

/** Compact rows for the verification block (shared by the preview and the PDF). */
export function verificationRows(v) {
  const t = v.tests.discovered;
  const discovered = t.fileCount || t.scripts.length
    ? `${t.fileCount} test file(s)${t.frameworks.length ? ` (${t.frameworks.join(', ')})` : ''}${t.scripts.length ? `; scripts: ${t.scripts.map((x) => x.name).join(', ')}` : ''}; none were executed by Relay`
    : 'No test files or scripts found in the analyzed files; none were executed';
  return [
    { label: 'Tests', text: discovered },
    { label: 'Runtime behaviour', text: v.runtime.detail },
    { label: 'Requirements', text: v.requirements.detail },
    { label: 'Work tracking', text: v.workTracking.detail },
    { label: 'Completion', text: v.completion.detail },
  ];
}
