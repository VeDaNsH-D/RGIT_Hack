/**
 * Semantic validation of the AI engineering state, run BEFORE anything is stored or rendered.
 *
 * The AIML service only guarantees that cited ids exist in the request. This module applies what needs repository and
 * tracker facts: file paths and symbols against the analyzed commit, the evidence class of each claim (verified fact /
 * inference / unknown), and the rules that stop a handoff from asserting things nobody verified:
 *
 *   - no completion claims (an empty tracker is not a finished project; absent requirements cannot be satisfied);
 *   - no execution claims (Relay reads files; it never runs code, so nothing "runs", "compiles" or "passes" unless
 *     real execution evidence is supplied through `ctx.executionEvidence`);
 *   - blockers need a confirming source, risks stay inferences, "suggested" work is never top priority;
 *   - statements that contradict deterministic facts (tests exist / do not, open work exists / does not) are removed;
 *   - near-duplicate statements across lists are collapsed.
 *
 * Pure and deterministic: no I/O, so every rule is unit-testable. Everything removed is counted, never silently lost.
 */

// ---------------------------------------------------------------------------------------------------------------
// Evidence references (shared with the report assembly, PDF and preview)
// ---------------------------------------------------------------------------------------------------------------

/** Report-stored form of an evidence entry. `type` lets the preview and PDF distinguish source kinds. */
export function evidenceRef(id, e) {
  const type = e.provider === 'document' ? 'document'
    : e.provider === 'jira' ? 'jira_issue' : e.provider === 'slack' ? 'slack_message' : e.type === 'task' ? 'task'
    : e.provider === 'repository' ? (e.type === 'file' ? 'repository_file' : 'repository')
    : e.type === 'issue' ? 'issue' : e.type === 'pull_request' ? 'pull_request' : e.type === 'commit' ? 'commit'
    : e.provider === 'relay' ? 'handoff' : e.provider === 'manual' ? 'note' : e.type === 'file' ? 'repository_file' : (e.provider || 'other');
  return { id, label: e.label, url: e.url ?? null, type, ...(e.document ? { document: e.document } : {}) };
}

/**
 * Source kinds that can CONFIRM a defect, blocker or requirement gap: something a person recorded as a problem or a
 * requirement. Code, commits and repository overviews only show what exists, and Slack is informal discussion, so none of
 * them can confirm anything on their own (they can support an inference or a suggestion).
 */
const CONFIRMING = new Set(['issue', 'pull_request', 'jira_issue', 'task', 'document', 'note']);
/** ...except where the code itself records the problem: an explicit TODO/FIXME/placeholder/stub marker in the cited file. */
const CODE_MARKER = /\b(?:TODO|FIXME|XXX|HACK)\b|\bplaceholder\b|\bnot (?:yet )?implemented\b|NotImplementedError|\bstub\b/i;

// ---------------------------------------------------------------------------------------------------------------
// Path verification
// ---------------------------------------------------------------------------------------------------------------

/** Tokens that look like repository file paths (contain a directory and an extension). */
export function pathTokens(text) {
  const noUrls = String(text).replace(/https?:\/\/\S+/g, ' ');
  return [...noUrls.matchAll(/(?<![\w/.-])(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,6}(?![\w/-])/g)].map((m) => m[0].replace(/^\.\//, ''));
}

/** A path is verified when it, or a path ending with it, exists among the analyzed files. */
export function unverifiedPaths(text, knownPaths) {
  return pathTokens(text).filter((t) => !isKnownPath(t, knownPaths));
}

/** Models sometimes put an evidence id ("file:1:src/app.py") where a path belongs; the path is what they meant. */
export const asPath = (value) => String(value).trim().replace(/^file:[^:]*:/, '').replace(/^\.\//, '');

export function isKnownPath(path, knownPaths) {
  const p = asPath(path);
  return knownPaths.has(p) || [...knownPaths].some((k) => k.endsWith(`/${p}`));
}

// ---------------------------------------------------------------------------------------------------------------
// Unsupported assertions
// ---------------------------------------------------------------------------------------------------------------

const COMPLETION = [
  /\b(?:project|work|implementation|repository|codebase|code|application|app|system|feature set)\b[^.;]{0,40}\b(?:is|are|appears?(?: to be)?|seems?(?: to be)?|looks?)\s+(?:fully\s+|now\s+|already\s+|essentially\s+)?(?:complete(?:d)?|finished|done|production[- ]ready|feature[- ]complete|ready (?:to ship|for production))\b/i,
  /\bfully (?:implemented|functional|working|operational)\b/i,
  /\bno (?:further|remaining|outstanding|more) (?:work|tasks?|changes|development)\b/i,
  /\bnothing (?:is )?(?:left|remaining|outstanding) to (?:do|implement|build|fix)\b/i,
  /\ball (?:known |documented )?(?:requirements|features|tasks|issues) (?:are |have been )?(?:met|satisfied|implemented|complete(?:d)?|resolved|addressed)\b/i,
  /\bproject (?:has been )?(?:completed|finished)\b/i,
];
const EXECUTION = [
  /\b(?:tests?|test suite|specs?|builds?|ci|pipeline|checks?)\b[^.;]{0,30}\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|green|successful(?:ly)?)\b/i,
  /\b(?:all|every) tests? (?:pass|passed|passing)\b/i,
  /\b(?:code|script|project|application|app|program|module|build|it)\b[^.;]{0,25}\b(?:compiles?|runs?|executes?|works?|functions?)\s+(?:successfully|correctly|properly|fine|without (?:errors?|issues?|problems?)|as (?:expected|intended|described|documented|per))\b/i,
  /\b(?:script|code|program|project|app|application)\b[^.;]{0,20}\b(?:runs?|works?|executes?)\s+(?:with|on|under|in)\b/i,
  /\bcompiles(?: and runs)?\b/i,
  /\bverified (?:to|that) (?:run|work|execute|compile)\b/i,
  /\bno (?:errors?|failures?|test failures?|bugs?) (?:were |are )?(?:found|detected|reported|observed)\b/i,
  /\bruns? as per the readme\b/i,
  /\bwithout (?:any )?(?:errors?|exceptions?|crash(?:es)?|failures?)\b/i,
  /\b(?:running|launching|executing|starting)\s+`?(?:python3?|node|npm|npx|uvicorn|flask|pytest)\b[^.;]{0,60}?\s(?:displays?|shows?|opens?|prints?|produces?|launches?|serves?|starts?)\b/i,
  /\b(?:everything|it|all features?) (?:works|runs|passes|is working|are working)\b/i,
];
const NEGATION = /\b(?:not|never|no|cannot|can't|unable|without|unverified|unconfirmed|unknown|isn't|aren't|wasn't|weren't|didn't|doesn't|don't|hasn't|haven't|n't|nor|neither|unless|until)\b/i;

/** Returns 'completion' | 'execution' | null. A negation shortly before the match ("not verified that it runs ...") exempts it. */
export function unsupportedAssertion(text, { executionEvidence = false } = {}) {
  const check = (patterns) => patterns.some((re) => {
    const m = re.exec(text);
    if (!m) return false;
    // Only a negation in the SAME clause exempts a match: "No open issues; the project is complete" is still a completion claim.
    const clause = text.slice(Math.max(0, m.index - 60), m.index).split(/[.;:!?,]|\b(?:so|but|therefore|thus|hence|and yet)\b/i).pop();
    // ...and so does a negation right after it in the same clause: "Whether the project is complete is not established".
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60).split(/[.;:!?,]|\b(?:so|but|therefore|thus|hence|and yet)\b/i)[0];
    return !NEGATION.test(clause) && !/\b(?:not|cannot|can't|isn't|aren't|unknown|unclear)\b/i.test(after);
  });
  if (check(COMPLETION)) return 'completion';
  if (!executionEvidence && check(EXECUTION)) return 'execution';
  return null;
}

const ABSENCE = /^\s*(?:no|none|nothing|zero|there (?:are|is) no|there (?:were|was) no)\b/i;
const NO_TESTS = /\b(?:no|lacks?|lacking|without|missing|absence of|does not (?:have|include|contain)|doesn't (?:have|include|contain))\b[^.;]{0,25}\b(?:automated |unit |integration )?tests?\b/i;
const HAS_TESTS = /\b(?:has|have|includes?|contains?|ships? with|covered by)\b[^.;]{0,20}\b(?:automated |unit |integration )?tests?\b/i;
const NO_OPEN = /\bno open (?:issues?|pull requests?|prs?|tickets?)\b/i;

const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'has', 'have', 'its', 'into', 'which', 'when', 'then', 'than', 'also']);
const tokens = (t) => new Set(norm(t).filter((w) => !STOP.has(w)));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const ANCHOR_KINDS = new Set(['issue', 'pull_request', 'jira_issue', 'task', 'document']);
const contentTokens = (t) => new Set([...tokens(t)].filter((w) => w.length > 3));

/**
 * Two statements are the same finding when they overlap heavily, or when they cite the same tracker item/document and share
 * enough vocabulary that the second one only restates the first (the same task, issue or conflict described twice).
 */
function sameFinding(a, b) {
  const j = jaccard(a.tokens, b.tokens);
  if (j >= 0.5) return true;
  if (j < 0.2) return false;
  const shareAnchor = a.anchors.some((id) => b.anchors.includes(id));
  if (!shareAnchor) return false;
  let shared = 0;
  for (const w of a.content) if (b.content.has(w)) shared += 1;
  return shared >= 3;
}

/** A completion criterion must be observable: something a reviewer can check, not "it is done / works". */
const VAGUE_CRITERION = /^(?:it|this|that|everything|the (?:task|work|issue|change|problem|feature|project|code))\s+(?:is|are|was|has been|have been|works?|looks?)\s+(?:done|complete(?:d)?|finished|fixed|resolved|working|good|fine|better|improved|correct)\b/i;
const OBSERVABLE_VERB = /\b(?:returns?|exists?|contains?|lists?|includes?|passes|fails|renders?|produces?|shows?|emits?|accepts?|rejects?|logs?|covers?|asserts?|documents?|documented|recorded|recorded in|merged|closed|opened|created|updated|renamed|removed|loads?|responds?|prints?|plots?|displays?|compares?|matches|differs|raises?|writes?|reads?|starts?|exits?|equals?|recovers?|installs?|builds?)\b/i;
const CODE_ANCHOR = /`[^`]+`|\b[a-z]+_[a-z_0-9]+\b|\b[a-z]+[A-Z]\w+\b|\w+\(\)|(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,6}\b|\b\w+\.(?:py|js|jsx|ts|tsx|md|json|txt|ya?ml|toml)\b|\b\d+\b|\bHTTP\b|\b[A-Z]{2,}[-_]?\d*\b/;
/** Shortens at a sentence or word boundary with an ellipsis; text is never cut mid-word. */
export function fit(text, max) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max - 3);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
  const cut = sentence > max * 0.6 ? head.slice(0, sentence + 1) : head.slice(0, Math.max(head.lastIndexOf(' '), 1)).replace(/[\s,;:(-]+$/, '');
  return `${cut}...`;
}

/** Evidence ids belong in the citation list, not in sentences ("... (doc:6acd...:2) describes ..."). */
export const stripIds = (text) => String(text ?? '')
  .replace(/\s*\((?:doc|file|repo):[^)\s]+\)/g, '')
  .replace(/\b(?:doc|repo):[\w.:-]+/g, '')
  .replace(/\bfile:[^:\s]*:([\w./@-]+)/g, '$1')
  .replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();

/** Overlap between two statements (used by the report assembly to link a finding to the action that addresses it). */
export function findingSimilarity(a, b) {
  const ta = tokens(a); const tb = tokens(b);
  const ca = contentTokens(a); let shared = 0;
  for (const w of ca) if (contentTokens(b).has(w)) shared += 1;
  return { jaccard: jaccard(ta, tb), shared };
}

export function observableCriterion(text) {
  const t = String(text).trim();
  if (tokens(t).size < 3 || VAGUE_CRITERION.test(t)) return false;
  return CODE_ANCHOR.test(t) || OBSERVABLE_VERB.test(t);
}

/** A recommendation whose only justification is the repository's name or title: a scope mismatch, not a confirmed requirement. */
const NAME_DRIVEN = /\b(?:repo(?:sitory)?|project)(?:'s)? (?:name|title)\b[^.;]{0,50}\b(?:suggests?|implies|implied|indicates?|mentions?|promises?|says|states?|explicitly|advertis\w+)\b|\bnamed\b[^.;]{0,50}\b(?:implies?|suggests?|but)\b|\bname (?:implies?|suggests?|indicates?)\b|\b(?:match|reflect|align with) the (?:repo(?:sitory)?|project) (?:name|title)\b|\brename (?:the )?(?:repo(?:sitory)?|project)\b/i;
const CLARIFY_FIRST = /^\s*(?:clarify|confirm|ask|decide|determine|define|specify|establish|agree)\b/i;

/**
 * @param {Object} ai  AIML response (snake_case lists as returned by /developer-handoff/generate)
 * @param {Object} ctx
 * @param {Map<string, Object>} ctx.evidence      id -> evidence entry sent to the model (the only citable ids)
 * @param {Set<string>} ctx.knownPaths            files of the analyzed commit(s)
 * @param {Map<string, Set<string>>} ctx.symbols  path -> symbol names extracted from that file's analyzed content
 * @param {Map<string, Map<string, {line: number, signature: string}>>} [ctx.symbolInfo] path -> name -> definition (adds line numbers)
 * @param {Array<{file: string, from: string, to: string, line: number}>} [ctx.callEdges] textual call sites between definitions
 * @param {Map<string, string>} [ctx.evidenceText] evidence id -> content sent to the model (lets an explicit TODO/placeholder marker in code confirm a defect)
 * @param {Map<string, string>} [ctx.docText]     document chunk id -> text (a path named by a cited document is documented, not verified)
 * @param {{ tests?: { discovered?: { fileCount?: number } }, workTracking?: Object }} ctx.verification
 * @param {string} [ctx.fallbackSummary]
 * @param {boolean} [ctx.executionEvidence=false] reserved for real test/CI results; none exist today
 * @returns {{ state: Object, removed: Object }}
 */
export function validateHandoff(ai, ctx) {
  const removed = { citations: Number(ai.removed_citations) || 0, aiDropped: Number(ai.dropped_claims) || 0, completion: 0, execution: 0, absence: 0, contradiction: 0, unverifiedPaths: 0, unverifiedSymbols: 0, duplicate: 0, malformed: 0, downgraded: 0 };
  const executionEvidence = Boolean(ctx.executionEvidence);
  const testFiles = ctx.verification?.tests?.discovered?.fileCount ?? 0;
  const open = ctx.verification?.workTracking || {};
  const openTotal = (open.openPullRequests || 0) + (open.openIssues || 0) + (open.openJira || 0);
  const confirms = (id) => { const k = kindOf(id); return CONFIRMING.has(k) || (k === 'repository_file' && CODE_MARKER.test(ctx.evidenceText?.get(id) || '')); };
  const kindOf = (id) => (ctx.evidence.has(id) ? evidenceRef(id, ctx.evidence.get(id)).type : null);
  const rawIdsOf = (item) => (Array.isArray(item?.source_ids) ? item.source_ids.map(String) : []);
  const idsOf = (item) => rawIdsOf(item).filter((id) => ctx.evidence.has(id));
  /** Ids the model cited that were never part of the context: counted, and an item whose citations were ALL invented is dropped. */
  const allInvented = (item) => { const raw = rawIdsOf(item); const bad = raw.filter((id) => !ctx.evidence.has(id)).length; removed.citations += bad; return raw.length > 0 && bad === raw.length; };
  const docTextFor = (ids) => ids.map((id) => ctx.docText?.get(id) || '').join('\n');
  const pathsAllowed = (text, ids) => {
    const doc = docTextFor(ids);
    return unverifiedPaths(text, ctx.knownPaths).filter((p) => !doc.includes(p));
  };

  /** Shared claim gate. Returns the cleaned claim or null (and counts why). */
  const gateClaim = (c, { allowAbsenceUnknown = true } = {}) => {
    const text = fit(stripIds(String(c?.text || '').replace(/\s+/g, ' ')), 700);
    if (!text) { removed.malformed += 1; return null; }
    if (allInvented(c)) return null;
    const ids = idsOf(c);
    let kind = ['fact', 'inference', 'unknown'].includes(c.kind) ? c.kind : 'inference';
    const a = unsupportedAssertion(text, { executionEvidence });
    if (a) { removed[a] += 1; return null; }
    if (kind !== 'unknown' && ABSENCE.test(text)) { removed.absence += 1; return null; }
    if (kind !== 'unknown' && testFiles > 0 && NO_TESTS.test(text) && !NEGATION.test(text.slice(0, text.search(NO_TESTS)))) { removed.contradiction += 1; return null; }
    if (kind !== 'unknown' && testFiles === 0 && HAS_TESTS.test(text) && !NEGATION.test(text.slice(0, text.search(HAS_TESTS)))) { removed.contradiction += 1; return null; }
    if (kind !== 'unknown' && openTotal > 0 && NO_OPEN.test(text)) { removed.contradiction += 1; return null; }
    if (pathsAllowed(text, ids).length) { removed.unverifiedPaths += 1; return null; }
    if (kind !== 'unknown' && !ids.length) { kind = kind === 'fact' ? 'inference' : 'unknown'; removed.downgraded += 1; }
    return { text, kind, ids };
  };

  const lists = {};
  for (const [key, src] of [['currentState', 'current_state'], ['howItWorks', 'how_it_works'], ['outstanding', 'outstanding_work'], ['blockers', 'blockers'], ['risks', 'risks'], ['unknowns', 'unknowns']]) {
    lists[key] = (Array.isArray(ai[src]) ? ai[src] : []).map((c) => gateClaim(c)).filter(Boolean);
  }

  // current state = verified facts only; other evidence classes move to where they belong.
  const stillCurrent = [];
  for (const c of lists.currentState) {
    if (c.kind === 'fact') stillCurrent.push(c);
    else if (c.kind === 'unknown') lists.unknowns.push(c);
    else lists.howItWorks.push(c);
    if (c.kind !== 'fact') removed.downgraded += 1;
  }
  lists.currentState = stillCurrent;

  // outstanding work is TRACKED or DOCUMENTED as unfinished (issue, PR, task, Jira, document, TODO marker); anything else is an inference.
  const tracked = [];
  for (const c of lists.outstanding) {
    if (c.ids.some(confirms)) tracked.push(c);
    else if (c.ids.length) { lists.risks.push({ ...c, kind: 'inference' }); removed.downgraded += 1; }
    else removed.malformed += 1;
  }
  lists.outstanding = tracked;

  // blockers are CONFIRMED problems; risks are INFERRED. Neither class may masquerade as the other.
  const blockers = [];
  for (const c of lists.blockers) {
    const confirmed = c.kind === 'fact' && c.ids.some(confirms);
    if (confirmed) blockers.push(c);
    else { lists.risks.push({ ...c, kind: 'inference' }); removed.downgraded += 1; }
  }
  lists.blockers = blockers;
  lists.risks = lists.risks.filter((r) => { if (r.ids.length) return true; removed.malformed += 1; return false; }).map((r) => ({ ...r, kind: 'inference' }));
  lists.unknowns = lists.unknowns.map((u) => ({ ...u, kind: 'unknown' }));

  // implementation paths (technical walkthrough): verified files, symbols and steps, and an honest evidence class.
  const symbolsOf = (files) => new Set(files.flatMap((f) => [...(ctx.symbols.get(f) || ctx.symbols.get([...ctx.symbols.keys()].find((k) => k.endsWith(`/${f}`))) || [])]));
  const allSymbols = new Set([...ctx.symbols.values()].flatMap((set) => [...set]));
  const lineOf = (name, files) => {
    for (const f of files) { const key = ctx.symbolInfo?.has(f) ? f : [...(ctx.symbolInfo?.keys() || [])].find((k) => k.endsWith(`/${f}`)); const hit = ctx.symbolInfo?.get(key)?.get(name); if (hit) return { file: key, line: hit.line }; }
    for (const [file, defs] of ctx.symbolInfo || []) { const hit = defs.get(name); if (hit) return { file, line: hit.line }; }
    return null;
  };
  const textList = (value, { max, len }) => (Array.isArray(value) ? value : []).map((x) => fit(stripIds(String(x ?? '').replace(/\s+/g, ' ')), len)).filter((x) => x.length >= 4).slice(0, max);
  /** A free-text walkthrough statement: no completion/execution claims, no invented paths. Returns the text or null. */
  const sound = (text, ids) => {
    const a = unsupportedAssertion(text, { executionEvidence });
    if (a) { removed[a] += 1; return null; }
    if (pathsAllowed(text, ids).length) { removed.unverifiedPaths += 1; return null; }
    return text;
  };
  const paths = [];
  for (const p of Array.isArray(ai.implementation_paths) ? ai.implementation_paths : []) {
    const title = String(p?.title || '').trim().slice(0, 160);
    const flow = fit(String(p?.flow || '').replace(/\s+/g, ' '), 700);
    if (!title || flow.length < 15) { removed.malformed += 1; continue; }
    const a = unsupportedAssertion(`${title}. ${flow}`, { executionEvidence });
    if (a) { removed[a] += 1; continue; }
    if (allInvented(p)) continue;
    const ids = idsOf(p);
    const files = [...new Set((Array.isArray(p.files) ? p.files : []).map(asPath))].filter((f) => { const ok = isKnownPath(f, ctx.knownPaths); if (!ok) removed.unverifiedPaths += 1; return ok; });
    if (pathsAllowed(flow, ids).length) { removed.unverifiedPaths += 1; continue; }
    if (!files.length) { removed.malformed += 1; continue; }
    const table = symbolsOf(files);
    const symbols = [...new Set((Array.isArray(p.symbols) ? p.symbols : []).map(String))].filter((s) => { const ok = table.has(s); if (!ok) removed.unverifiedSymbols += 1; return ok; });
    const fromCode = ids.some((id) => ['repository_file', 'repository'].includes(kindOf(id)));

    const purpose = sound(fit(String(p.purpose || '').replace(/\s+/g, ' '), 320), ids) || '';
    const steps = textList(p.steps, { max: 8, len: 260 }).map((t) => sound(t, ids)).filter(Boolean);
    const inputs = textList(p.inputs, { max: 4, len: 200 }).map((t) => sound(t, ids)).filter(Boolean);
    const outputs = textList(p.outputs, { max: 4, len: 200 }).map((t) => sound(t, ids)).filter(Boolean);
    const dependencies = textList(p.dependencies, { max: 5, len: 160 }).map((t) => sound(t, ids)).filter(Boolean);
    const limits = textList(p.limitations, { max: 3, len: 240 }).map((t) => sound(t, ids)).filter(Boolean);

    // The entry point is a verified file or a verified definition ("main.py", "update", "main.py:generate_signals").
    let entry = '';
    const rawEntry = asPath(String(p.entry_point || '').trim()).slice(0, 160);
    if (rawEntry) {
      const [filePart, symPart] = rawEntry.includes(':') ? rawEntry.split(/:(.+)/) : [rawEntry, ''];
      if (symPart ? isKnownPath(filePart, ctx.knownPaths) && allSymbols.has(symPart.trim()) : (isKnownPath(rawEntry, ctx.knownPaths) || allSymbols.has(rawEntry))) entry = rawEntry;
      else removed.unverifiedSymbols += 1;
    }

    // Key functions: names must exist in the analyzed definitions; their line numbers come from the source, not the model.
    const seenFn = new Set();
    const functions = [];
    for (const f of Array.isArray(p.key_functions) ? p.key_functions : []) {
      const name = String(f?.name ?? '').trim();
      if (!name || seenFn.has(name)) continue;
      if (!allSymbols.has(name)) { removed.unverifiedSymbols += 1; continue; }
      const role = sound(fit(String(f?.role || '').replace(/\s+/g, ' '), 260), ids) || '';
      const loc = lineOf(name, files);
      seenFn.add(name);
      functions.push({ name, role, ...(loc ? { file: loc.file, line: loc.line } : {}) });
      if (functions.length >= 8) break;
    }
    // Relationships are derived from the source (textual call sites between the functions this path names), never asserted by the model.
    const named = new Set([...functions.map((f) => f.name), ...symbols]);
    const calls = (ctx.callEdges || []).filter((e) => named.has(e.from) && named.has(e.to) && files.some((f) => e.file === f || e.file.endsWith(`/${f}`))).slice(0, 8).map(({ from, to, line }) => ({ from, to, line }));

    paths.push({ title, flow, purpose, entry, steps, functions, calls, inputs, outputs, dependencies, limits, files, symbols, ids, kind: p.kind === 'fact' && fromCode ? 'fact' : 'inference' });
  }

  // documented-vs-implemented: a comparison needs a document on one side and a different evidence class on the other.
  const comparisons = [];
  for (const c of Array.isArray(ai.documented_vs_implemented) ? ai.documented_vs_implemented : []) {
    const requirement = fit(stripIds(String(c?.requirement || '').replace(/\s+/g, ' ')), 400);
    const detail = fit(stripIds(String(c?.detail || '').replace(/\s+/g, ' ')), 600);
    if (allInvented(c)) continue;
    const ids = idsOf(c);
    const docs = ids.filter((id) => kindOf(id) === 'document');
    const others = ids.filter((id) => ['repository_file', 'repository', 'pull_request', 'commit', 'issue', 'jira_issue', 'task', 'note'].includes(kindOf(id)));
    if (!requirement || !docs.length) { removed.malformed += 1; continue; }
    const a = unsupportedAssertion(`${requirement}. ${detail}`, { executionEvidence });
    if (a) { removed[a] += 1; continue; }
    let status = ['matches', 'conflicts', 'unverified', 'not_found'].includes(c.status) ? c.status : 'unverified';
    const twoDocs = new Set(docs.map((id) => ctx.evidence.get(id)?.document?.documentId)).size > 1;
    if ((status === 'matches' || status === 'conflicts') && !others.length && !(status === 'conflicts' && twoDocs)) { status = 'unverified'; removed.downgraded += 1; }
    comparisons.push({ requirement, status, detail, ids });
  }

  // recommendations: actionable, justified, prioritized by evidence rather than by the model's enthusiasm.
  const STATUS_ORDER = { confirmed: 0, suggested: 1, clarification_needed: 2 };
  let recommendations = [];
  for (const r of Array.isArray(ai.recommendations) ? ai.recommendations : []) {
    const action = fit(String(r?.action || '').replace(/\s+/g, ' '), 360);
    const why = fit(stripIds(String(r?.why || '').replace(/\s+/g, ' ')), 520);
    const doneWhen = fit(String(r?.done_when || '').replace(/\s+/g, ' '), 420);
    const a = unsupportedAssertion(`${action}. ${why}`, { executionEvidence });
    if (a) { removed[a] += 1; continue; }
    // A reason and an OBSERVABLE completion criterion must say something: "it is done" is not a criterion.
    if (action.length < 8 || tokens(why).size < 3 || !observableCriterion(doneWhen)) { removed.malformed += 1; continue; }
    allInvented(r); // counted; the recommendation itself stays but can no longer be "confirmed"
    const ids = idsOf(r);
    // Claims about existing code must name real files; an action that CREATES something (a test file, a doc) may name the new path.
    const creates = /^\s*(?:add|create|write|introduce|document|extract|split|rename|move)\b/i.test(action);
    if (pathsAllowed(creates ? why : `${action} ${why} ${doneWhen}`, ids).length) { removed.unverifiedPaths += 1; continue; }
    const files = [...new Set((Array.isArray(r.files) ? r.files : []).map(asPath))].filter((f) => { const ok = isKnownPath(f, ctx.knownPaths); if (!ok) removed.unverifiedPaths += 1; return ok; });
    const recSymbols = [...new Set((Array.isArray(r.symbols) ? r.symbols : []).map(String))].filter((sym) => { const ok = allSymbols.has(sym); if (!ok) removed.unverifiedSymbols += 1; return ok; });
    const prerequisites = textList(r.prerequisites, { max: 3, len: 200 }).map((t) => sound(t, ids)).filter(Boolean);
    let status = ['confirmed', 'suggested', 'clarification_needed'].includes(r.basis) ? r.basis : 'suggested';
    let note = '';
    if (status === 'confirmed' && !ids.some(confirms)) { status = 'suggested'; removed.downgraded += 1; }
    // Work justified only by the repository's name, or that begins by asking someone to decide, needs a human answer first.
    const nameOnly = NAME_DRIVEN.test(`${action} ${why}`) && !ids.some(confirms);
    if (status !== 'clarification_needed' && (nameOnly || CLARIFY_FIRST.test(action))) { status = 'clarification_needed'; removed.downgraded += 1; }
    if (nameOnly) note = 'Not a confirmed requirement: no issue, task or document asks for this; it is inferred from the repository name.';
    let priority = ['P1', 'P2', 'P3'].includes(r.priority) ? r.priority : 'P3';
    if (status !== 'confirmed' && priority === 'P1') { priority = 'P2'; removed.downgraded += 1; }
    recommendations.push({ action, why, doneWhen, priority, basis: status, files, symbols: recSymbols, prerequisites, note, ids });
  }
  recommendations = dedupeBy(recommendations, (r) => r.action, removed)
    .sort((a, b) => a.priority.localeCompare(b.priority) || STATUS_ORDER[a.basis] - STATUS_ORDER[b.basis]);

  const startHere = [];
  for (const s of Array.isArray(ai.start_here) ? ai.start_here : []) {
    const file = asPath(s?.file || '');
    if (!file || !isKnownPath(file, ctx.knownPaths)) { removed.unverifiedPaths += 1; continue; }
    if (startHere.some((x) => x.file === file)) { removed.duplicate += 1; continue; }
    allInvented(s);
    startHere.push({ file, reason: fit(String(s.reason || '').replace(/\s+/g, ' '), 420), ids: idsOf(s) });
  }

  // One primary explanation per finding. Earlier, more specific lists win: verified state, how it works, the walkthrough, documentation
  // conflicts, confirmed blockers, tracked work, inferred risks, unknowns. Later restatements are dropped, not merged.
  const entry = (text, ids) => ({ tokens: tokens(text), content: contentTokens(text), anchors: ids.filter((id) => ANCHOR_KINDS.has(kindOf(id))) });
  const seen = [];
  const keep = (text, ids = []) => {
    const e = entry(text, ids);
    if (seen.some((s) => sameFinding(s, e))) { removed.duplicate += 1; return false; }
    seen.push(e);
    return true;
  };
  for (const k of ['currentState', 'howItWorks']) lists[k] = lists[k].filter((c) => keep(c.text, c.ids));
  for (const p of paths) seen.push(entry(`${p.title} ${p.purpose} ${p.flow}`, p.ids));
  for (const c of comparisons.filter((x) => x.status === 'conflicts')) seen.push(entry(`${c.requirement} ${c.detail}`, c.ids));
  for (const k of ['blockers', 'outstanding', 'risks', 'unknowns']) lists[k] = lists[k].filter((c) => keep(c.text, c.ids));

  // Suggestions belong in recommendations: an outstanding/risk/unknown statement that restates one is dropped.
  const recEntries = recommendations.map((r) => entry(r.action, r.ids));
  for (const k of ['outstanding', 'risks', 'unknowns']) lists[k] = lists[k].filter((c) => { const t = entry(c.text, c.ids); if (recEntries.some((r) => sameFinding(r, t))) { removed.duplicate += 1; return false; } return true; });

  // The summary may orient but never conclude: sentences asserting completion/execution are removed.
  const sentences = String(ai.summary || '').split(/(?<=[.!?])\s+/).filter((s) => {
    const a = unsupportedAssertion(s, { executionEvidence });
    if (a) { removed[a] += 1; return false; }
    return s.trim().length > 0;
  });
  const summary = (sentences.join(' ').trim() || ctx.fallbackSummary || '').slice(0, 900);

  return { state: { summary, ...lists, paths, comparisons, recommendations, startHere }, removed };
}

function dedupeBy(items, textOf, removed) {
  const seen = [];
  return items.filter((i) => {
    const t = tokens(textOf(i));
    if (seen.some((s) => jaccard(s, t) >= 0.7)) { removed.duplicate += 1; return false; }
    seen.push(t);
    return true;
  });
}

/** One compact line for the stored report (the per-rule lines above stay available for tests and detailed views). */
export function validationNote(removed) {
  const parts = [];
  const add = (n, text) => { if (n) parts.push(`${n} ${text}`); };
  add(removed.completion + removed.execution, 'completion/execution claim(s) no evidence supports');
  add(removed.unverifiedPaths, 'reference(s) to files not in the analyzed commit');
  add(removed.unverifiedSymbols, 'unverifiable function/class name(s)');
  add(removed.contradiction, 'statement(s) contradicting verified data');
  add(removed.citations + removed.aiDropped, 'invalid source reference(s)');
  add(removed.duplicate, 'duplicate statement(s) collapsed');
  return parts.length ? `Automated validation corrected the AI output before it was stored: ${parts.join('; ')}.` : '';
}

/** Human-readable limitation lines for what validation removed or downgraded (nothing is dropped silently). */
export function validationLimitations(removed) {
  const out = [];
  const add = (n, text) => { if (n) out.push(`${n} ${text}`); };
  add(removed.completion, 'AI statement(s) were removed because they claimed the work is complete, which no available evidence establishes.');
  add(removed.execution, 'AI statement(s) were removed because they claimed code runs, compiles or tests pass; no execution or test results are available to Relay.');
  add(removed.contradiction, 'AI statement(s) were removed because they contradicted verified repository or tracker data.');
  add(removed.unverifiedPaths, 'AI statement(s) or file references were removed because they named files that do not exist in the analyzed commit.');
  add(removed.unverifiedSymbols, 'function/class reference(s) were removed because they could not be verified in the analyzed source.');
  add(removed.citations + removed.aiDropped, 'invalid or unknown source reference(s) were removed from AI statements.');
  return out;
}
