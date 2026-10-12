import { evidenceRef, findingSimilarity } from './handoffValidation.js';
import { labelFor } from './handoffDraftService.js';
import { verificationRows } from './engineeringState.js';

/**
 * Turns the VALIDATED engineering state plus deterministic facts into the one report structure that both the web preview
 * and the PDF render:
 *
 *   brief          page one: summary, verified state (+ a two-line status), the first actions, a pointer to the findings
 *   sections       in reading order; sections that belong together carry a `group` heading
 *                    Architecture and Technical Walkthrough   subsystem items: purpose, entry, steps, functions, I/O, limits
 *                    Your First 30 Minutes                    step items built from the validated pieces (never invented)
 *                    Known Risks, Unknowns, and Verification Status
 *                    Open Work and Recent Changes
 *   sourceIndex    compact numbered list of the AI-cited sources; items carry `refs` (numbers) for inline [n] citations.
 *                  Deterministic lists (open work, commits, setup) link inline instead of being numbered.
 *
 * A finding has ONE primary explanation (its own section); the actions that address it only point back to it (`resolvedBy`).
 * Items keep their `evidence` objects as well (API consumers, tests); renderers print the compact `refs`.
 */

export const SECTION_TITLES = {
  walkthrough: 'Architecture and Technical Walkthrough',
  first_30: 'Your First 30 Minutes',
  setup: 'Setup and run',
  recommendations: 'More recommended actions',
  documented_vs_implemented: 'Documentation vs code',
  blockers_risks: 'Blockers and risks',
  outstanding_work: 'Tracked work not yet done',
  unknowns: 'Unknowns',
  verification: 'Verification status',
  open_items: 'Open pull requests and issues',
  jira_items: 'Open Jira issues',
  recent_activity: 'Recent commits and merged pull requests',
};
export const SECTION_GROUPS = {
  documented_vs_implemented: 'Known Risks, Unknowns, and Verification Status',
  blockers_risks: 'Known Risks, Unknowns, and Verification Status',
  outstanding_work: 'Known Risks, Unknowns, and Verification Status',
  unknowns: 'Known Risks, Unknowns, and Verification Status',
  verification: 'Known Risks, Unknowns, and Verification Status',
  open_items: 'Open Work and Recent Changes',
  jira_items: 'Open Work and Recent Changes',
  recent_activity: 'Open Work and Recent Changes',
};
export const SECTION_ORDER = Object.keys(SECTION_TITLES);
export const BRIEF_ACTIONS = 3;
const FIRST_30_NOTE = 'A suggested order for a new owner, not a measured estimate of how long each step takes.';
const SETUP_NOTE = 'Commands recorded in the repository files. Relay has not run them; confirm them on a clean checkout.';

const blobUrl = (htmlUrl, sha, path) => (htmlUrl ? `${htmlUrl}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}` : null);
const short = (sha) => String(sha || '').slice(0, 7);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'unknown date');
const pm = (r) => r.metadata?.providerMetadata || {};
const recRef = (r) => evidenceRef(String(r._id), { label: labelFor(r), url: /^https?:\/\//.test(r.url || '') ? r.url : null, type: r.type, provider: r.provider });
const clip = (text, n) => { const t = String(text).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}...` : t; };

/** Complete, link-backed lists of open work and recent activity straight from the synced records (no model tokens). Linked inline, not numbered. */
export function activityItems(activity) {
  const line = (r, extra) => `${r.title}${extra ? ` (${extra})` : ''}`;
  const det = (text, r) => ({ text, kind: 'fact', inline: true, evidence: [recRef(r)] });
  const open = [
    ...activity.openPrs.slice(0, 15).map((r) => det(`PR #${pm(r).number}: ${line(r, [pm(r).draft ? 'draft' : 'ready for review', r.metadata?.author && `by ${r.metadata.author}`, `updated ${day(r.metadata?.sourceUpdatedAt)}`, pm(r).labels?.length && pm(r).labels.join(', ')].filter(Boolean).join('; '))}`, r)),
    ...activity.openIssues.slice(0, 20).map((r) => det(`Issue #${pm(r).number}: ${line(r, [r.metadata?.author && `by ${r.metadata.author}`, `updated ${day(r.metadata?.sourceUpdatedAt)}`, pm(r).labels?.length && pm(r).labels.join(', '), pm(r).assignees?.length && `assigned ${pm(r).assignees.join(', ')}`].filter(Boolean).join('; '))}`, r)),
  ];
  const recent = [
    ...activity.closedPrs.filter((r) => pm(r).merged || pm(r).merged_at).slice(0, 6).map((r) => det(`Merged PR #${pm(r).number}: ${r.title} (${day(pm(r).merged_at || r.metadata?.sourceUpdatedAt)})`, r)),
    ...activity.commits.slice(0, 6).map((r) => det(`${String(pm(r).sha || '').slice(0, 7)} ${r.title}${r.metadata?.author ? ` — ${r.metadata.author}` : ''}, ${day(r.metadata?.sourceCreatedAt || r.metadata?.sourceUpdatedAt)}`, r)),
  ];
  const jira = (activity.jiraOpen || []).slice(0, 20).map((r) => det(`${pm(r).key || r.externalId}: ${r.title} (${[pm(r).issueType, pm(r).status && `status ${pm(r).status}`, pm(r).priority && `priority ${pm(r).priority}`, pm(r).assignee ? `assigned to ${pm(r).assignee}` : 'unassigned', pm(r).dueDate && `due ${day(pm(r).dueDate)}`].filter(Boolean).join('; ')})`, r));
  return { open_items: open, jira_items: jira, recent_activity: recent };
}

const COMMAND = /^(?:\$\s*)?(?:cd|pip3?|python3?|npm|npx|pnpm|yarn|uvicorn|gunicorn|node|cp|docker(?:-compose)?|make|pytest|poetry|uv|source|flask|go|cargo|bundle|rails|php|composer|dotnet|mvn|gradle)\b.*$/;
/** Shell commands from the fenced blocks of a README excerpt (the prose around them is not repeated). */
export function commandsFrom(excerpt) {
  const out = [];
  let fenced = false;
  for (const raw of String(excerpt).split('\n')) {
    const line = raw.trim();
    if (/^```/.test(line)) { fenced = !fenced; continue; }
    if (fenced && COMMAND.test(line)) out.push(line.replace(/^\$\s*/, ''));
  }
  return out;
}

/** Setup and run instructions that exist in the analyzed files: scripts and README commands (deduplicated), and env names. Empty when none exist. */
export function setupItems({ snapshots, connections }) {
  const items = [];
  for (const s of snapshots) {
    const k = s.knowledge; const id = s.repositoryId; const htmlUrl = connections.get(String(s.connectionId))?.config?.htmlUrl;
    const fileEv = (path) => [{ id: `file:${id}:${path}`, label: `${s.fullName}/${path}@${short(s.commitSha)}`, url: blobUrl(htmlUrl, s.commitSha, path), type: 'repository_file' }];
    const seenCommands = new Set();
    for (const b of k.buildAndTest || []) items.push({ text: `\`${b.name}\` runs \`${b.command}\` (defined in ${b.file}).`, kind: 'fact', inline: true, type: 'setup', evidence: fileEv(b.file) });
    for (const d of k.setupDocs || []) {
      const commands = commandsFrom(d.excerpt).filter((c) => !seenCommands.has(c));
      commands.forEach((c) => seenCommands.add(c));
      if (commands.length) items.push({ text: `${d.file}, "${d.heading}": ${commands.join('; ')}`, kind: 'fact', inline: true, type: 'setup', evidence: fileEv(d.file) });
    }
    if (k.envVariables?.length) items.push({ text: `Environment variables read by the code (names only; set values locally, never commit them): ${k.envVariables.map((e) => e.name).join(', ')}.`, kind: 'fact', inline: true, type: 'setup', evidence: [] });
  }
  return items;
}

const aiItem = (text, kind, ids, evidence, extra = {}) => ({ text, kind, evidence: ids.map((id) => evidenceRef(id, evidence.get(id))), ...extra });

/** Two compact lines for page one; the full verification block lives in the risks group. */
export function statusLines(v) {
  if (!v) return [];
  const w = v.workTracking; const t = v.tests.discovered;
  const open = [`${w.openPullRequests} open PR(s)`, `${w.openIssues} open issue(s)`, w.openJira === null || w.openJira === undefined ? null : `${w.openJira} open Jira issue(s)`, `${w.openTasks} open Relay task(s)`].filter(Boolean).join(', ');
  const empty = w.openPullRequests + w.openIssues + (w.openJira || 0) + w.openTasks === 0;
  return [
    { label: 'Tracked work', text: `${open}${empty ? '. An empty tracker describes the trackers only; it does not show the work is complete' : ''}.` },
    { label: 'Verification', text: `${t.fileCount ? `${t.fileCount} test file(s) found` : 'No test files found'}, none executed by Relay; runtime behaviour not verified; completion not established.` },
  ];
}

function findingsLine(counts) {
  const parts = [[counts.conflicts, 'documentation conflict'], [counts.blockers, 'confirmed blocker'], [counts.risks, 'inferred risk'], [counts.unknowns, 'unknown'], [counts.outstanding, 'tracked item']]
    .filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`);
  return parts.length ? `${parts.join(', ')}. Each is explained once under Known Risks, Unknowns, and Verification Status.` : '';
}

/**
 * "Your First 30 Minutes": a reading and working order built only from validated pieces (verified files and symbols, the
 * walkthrough, deterministic setup and tracker facts, the recommendations). Nothing here is new AI output.
 */
export function onboardingSteps({ state, recs, setup, startFallback, verification, evidence }) {
  const steps = [];
  const refsOf = (ids) => (ids || []).filter((id) => evidence.has(id));
  const shown = new Set();
  const reads = (list) => list.filter((r) => { if (!r.file || shown.has(r.file)) return false; shown.add(r.file); return true; });
  const step = (title, detail, readList = [], ids = [], kind = 'inference') => steps.push(aiItem(title, kind, refsOf(ids), evidence, { type: 'step', detail, reads: reads(readList) }));
  const entryReads = state.startHere.length
    ? state.startHere.slice(0, 2).map((s) => ({ file: s.file, why: s.reason || 'listed by the walkthrough as a place to start' }))
    : (startFallback || []).slice(0, 2).map((s) => ({ file: s.files?.[0], why: 'detected entry point' }));

  const hasWalkthrough = state.paths.length > 0 || state.howItWorks.length > 0;
  if (hasWalkthrough || entryReads.length) {
    step('Understand the architecture',
      hasWalkthrough
        ? 'Read the walkthrough above first, then open the files below to see how it maps onto the code.'
        : 'The analyzed code did not establish an architecture beyond the files listed; read these files to build the picture yourself.',
      entryReads, [...state.startHere.slice(0, 2).flatMap((s) => s.ids)]);
  }

  const p = state.paths[0];
  if (p) {
    const flow = p.functions.length ? `: ${p.functions.slice(0, 5).map((f) => f.name).join(' -> ')} (as ordered in the walkthrough; confirm by reading)` : '';
    step('Trace the primary workflow', `Follow "${p.title}"${p.entry ? ` from ${p.entry}` : ''}${flow}.`,
      p.files.slice(0, 2).map((file) => ({ file, why: p.functions.length ? `defines ${p.functions.filter((f) => !f.file || f.file === file || file.endsWith(`/${f.file}`)).slice(0, 3).map((f) => f.name).join(', ') || 'this workflow'}` : (p.purpose || 'implements this workflow') })), p.ids, p.kind);
  } else if (entryReads.length) {
    step('Trace the primary workflow', 'No execution path could be established from the analyzed code. Start from the detected entry point and follow its calls; treat the first pass as exploration.', entryReads);
  }

  const setupFiles = setup.flatMap((i) => (i.evidence || []).map((e) => String(e.id).replace(/^file:[^:]*:/, ''))).filter(Boolean);
  if (setup.length || verification) step('Identify dependencies and how to run it',
    setup.length ? `Install and run commands recorded in the repository are listed under Setup and run. Relay has not run them, so verify them on a clean checkout before trusting them.` : 'No setup or run instructions were found in the analyzed files (see Unknowns). Ask the previous owner how it is installed and run, and write it down.',
    [...new Set(setupFiles)].slice(0, 2).map((file) => ({ file, why: 'declares the documented install/run commands' })), [], setup.length ? 'fact' : 'unknown');

  const w = verification?.workTracking;
  const lead = [...state.comparisons.filter((c) => c.status === 'conflicts').map((c) => c.requirement), ...state.blockers.map((b) => b.text)][0];
  const t = verification?.tests?.discovered;
  if (verification) step('Review known defects, open work and verification status',
    `${w ? `Trackers: ${w.openPullRequests} open PR(s), ${w.openIssues} open issue(s), ${w.openTasks} open Relay task(s).` : ''} ${t?.fileCount ? `${t.fileCount} test file(s) exist but have not been run by Relay; run them yourself before changing behaviour.` : 'No tests were found; there is no safety net yet.'}${lead ? ` Start with: ${clip(lead, 140)}` : ''}`.trim(),
    [], [], 'fact');

  const actionable = recs.find((r) => r.basis !== 'clarification_needed' && !r.prerequisites?.length && r.files?.length) || recs.find((r) => r.basis !== 'clarification_needed');
  if (actionable) {
    step('Pick a safe first task', `Suggested: ${actionable.text} Done when: ${actionable.doneWhen}`, (actionable.files || []).slice(0, 2).map((file) => ({ file, why: 'the file this change touches' })), actionable.evidence.map((e) => e.id), 'inference');
  } else if (recs.length) {
    step('Pick a safe first task', `Nothing is ready to start: ${recs[0].text} Get that answered first.`, [], [], 'unknown');
  }
  return steps;
}

/**
 * @returns {{ brief: Object, sections: Array, sourceIndex: Array }}
 */
export function assembleReport({ state, evidence, activity, setup, startFallback, extraUnknowns = [], verification = null }) {
  const recItem = (r) => aiItem(r.action, r.basis === 'confirmed' ? 'fact' : r.basis === 'clarification_needed' ? 'unknown' : 'inference', r.ids, evidence,
    { type: 'recommendation', priority: r.priority, basis: r.basis, why: r.why, doneWhen: r.doneWhen, files: r.files, symbols: r.symbols || [], prerequisites: r.prerequisites || [], note: r.note || '' });
  const recs = state.recommendations.map(recItem);
  recs.forEach((r, i) => { r.n = i + 1; });
  const doFirst = recs.slice(0, BRIEF_ACTIONS);

  const allUnknowns = [...state.unknowns, ...extraUnknowns];
  const conflicts = state.comparisons.filter((c) => c.status === 'conflicts');

  // The action that addresses a finding is named on the finding; the finding itself is explained once, in its own section.
  const resolvedBy = (text) => {
    let best = null;
    for (const r of recs) {
      const sim = findingSimilarity(text, `${r.text} ${r.why}`);
      if (sim.shared >= 4 && sim.jaccard >= 0.18 && (!best || sim.jaccard > best.jaccard)) best = { n: r.n, jaccard: sim.jaccard };
    }
    return best?.n || null;
  };
  const link = (item) => { const n = resolvedBy(item.text); if (n) { item.resolvedBy = n; item.resolvedLabel = n <= BRIEF_ACTIONS ? `Do first #${n}` : `Action #${n}`; } return item; };
  const claim = (c, extra = {}) => aiItem(c.text, c.kind, c.ids, evidence, extra);
  const finding = (c, extra = {}) => link(claim(c, extra));

  const counts = { conflicts: conflicts.length, blockers: state.blockers.length, risks: state.risks.length, unknowns: allUnknowns.length, outstanding: state.outstanding.length };
  const brief = { summary: state.summary, currentState: state.currentState.map((c) => claim(c)), status: statusLines(verification), doFirst, findings: { counts, text: findingsLine(counts) } };

  const sections = new Map();
  const put = (key, items, origin = 'ai', extra = {}) => { if (items.length) sections.set(key, { key, title: SECTION_TITLES[key], ...(SECTION_GROUPS[key] ? { group: SECTION_GROUPS[key] } : {}), origin, ...extra, items }); };

  put('walkthrough', [
    ...state.howItWorks.map((c) => claim(c, { type: 'overview' })),
    ...state.paths.map((p) => aiItem(p.title, p.kind, p.ids, evidence, { type: 'subsystem', purpose: p.purpose, flow: p.flow, entry: p.entry, steps: p.steps, functions: p.functions, calls: p.calls, inputs: p.inputs, outputs: p.outputs, dependencies: p.dependencies, limits: p.limits, files: p.files, symbols: p.symbols })),
  ]);
  put('first_30', onboardingSteps({ state, recs, setup, startFallback, verification, evidence }), 'ai', { intro: FIRST_30_NOTE });
  put('setup', setup, 'deterministic', { intro: SETUP_NOTE });
  put('recommendations', recs.slice(BRIEF_ACTIONS));

  const cmp = (c) => link(aiItem(`${c.requirement}${c.detail ? `: ${c.detail}` : ''}`, c.status === 'matches' || c.status === 'conflicts' ? 'fact' : 'inference', c.ids, evidence, { type: 'comparison', status: c.status }));
  put('documented_vs_implemented', [...conflicts.map((c) => cmp(c)), ...state.comparisons.filter((c) => c.status !== 'conflicts').map((c) => cmp(c))]);
  put('blockers_risks', [
    ...state.blockers.map((b) => finding(b, { label: 'confirmed' })),
    ...state.risks.map((r) => finding(r, { label: 'inferred risk' })),
  ]);
  put('outstanding_work', state.outstanding.map((c) => finding(c)));
  put('unknowns', allUnknowns.map((u) => link(aiItem(u.text, 'unknown', u.ids || [], evidence))));
  if (verification) put('verification', verificationRows(verification).filter((r) => r.label !== 'Work tracking' || /sync was not fully successful/.test(r.text)).map((r) => ({ type: 'status', label: r.label, text: r.text, kind: 'fact', evidence: [] })), 'deterministic');
  const det = activityItems(activity);
  put('open_items', det.open_items, 'deterministic');
  put('jira_items', det.jira_items, 'deterministic');
  put('recent_activity', det.recent_activity, 'deterministic');

  const ordered = SECTION_ORDER.map((k) => sections.get(k)).filter(Boolean);
  const sourceIndex = indexSources(brief, ordered);
  return { brief, sections: ordered, sourceIndex };
}

/** Numbers every cited source once, in reading order, and stamps `refs` onto each item. Inline-linked deterministic items are not numbered. */
export function indexSources(brief, sections) {
  const order = new Map();
  const visit = (item) => {
    item.refs = [];
    if (item.inline) return;
    for (const e of item.evidence || []) {
      if (!order.has(e.id)) order.set(e.id, { n: order.size + 1, ...e });
      item.refs.push(order.get(e.id).n);
    }
  };
  for (const i of [...brief.currentState, ...brief.doFirst]) visit(i);
  for (const s of sections) for (const i of s.items) visit(i);
  return [...order.values()];
}
