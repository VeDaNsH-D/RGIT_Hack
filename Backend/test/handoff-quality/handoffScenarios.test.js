import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { validateHandoff, validationNote, observableCriterion } from '../../src/services/handoffValidation.js';
import { assembleReport, commandsFrom } from '../../src/services/handoffAssembly.js';
import { buildSymbolTable, buildVerification, callEdges, scanDefinitions } from '../../src/services/engineeringState.js';
import { renderReportPdf } from '../../src/services/reportPdf.js';

/**
 * End-to-end scenarios for the handoff pipeline below the model: real source text -> symbol table and call edges ->
 * validateHandoff -> assembleReport -> PDF. Each scenario feeds the kind of AI output seen in practice (including its slips).
 */

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: source text of a three-file script and a small full-stack app
// ---------------------------------------------------------------------------------------------------------------

const AM_MAIN = `import numpy as np
import matplotlib.pyplot as plt
from matplotlib.widgets import Slider

def generate_signals(fm, fc, ma):
    t = np.linspace(0, 0.01, 2000)
    message = np.cos(2 * np.pi * fm * t)
    modulated = (1 + ma * message) * np.cos(2 * np.pi * fc * t)
    envelope = np.abs(modulated)
    return t, message, modulated, envelope

fig, axes = plt.subplots(3, 1)

def update(val):
    t, message, modulated, envelope = generate_signals(fm_slider.val, fc_slider.val, ma_slider.val)
    axes[0].plot(t, message)

fm_slider = Slider(axes[0], 'fm', 10, 100)
fm_slider.on_changed(update)
plt.show()
`;
const API_MAIN = `from fastapi import FastAPI, UploadFile
from app.ai_interpreter import interpret

app = FastAPI()

def preprocess_signal(raw):
    return raw

def compute_frequency_spectrum(sig):
    return sig

@app.post("/api/signals/upload")
async def analyze(file: UploadFile):
    sig = preprocess_signal(await file.read())
    spectrum = compute_frequency_spectrum(sig)
    return interpret(spectrum)
`;
const API_AI = `import os

def interpret(spectrum):
    key = os.environ.get("GROQ_API_KEY")
    return {"summary": str(spectrum), "key_set": bool(key)}
`;

const file = (id, label, type = 'file') => [id, { id, label, url: `https://github.com/acme/r/blob/abc/${label}`, provider: 'repository', type }];
const doc = (id, docId, label) => [id, { id, label, url: null, provider: 'document', type: 'document_excerpt', document: { documentId: docId, chunkId: id.slice(4) } }];
const other = (id, label, provider, type) => [id, { id, label, url: null, provider, type }];

const AM_EVIDENCE = new Map([file('file:1:main.py', 'main.py'), file('file:1:requirements.txt', 'requirements.txt'), file('file:1:README.md', 'README.md'), other('commit1', 'commit abc', 'github', 'commit')]);
const AM_FILES = new Map([['main.py', AM_MAIN], ['requirements.txt', 'numpy\nmatplotlib\nscipy\n'], ['README.md', '# AM-FM\n']]);
const AM_PATHS = new Set(AM_FILES.keys());

const APP_EVIDENCE = new Map([file('file:1:backend/app/main.py', 'backend/app/main.py'), file('file:1:backend/app/ai_interpreter.py', 'backend/app/ai_interpreter.py'), file('file:1:frontend/src/App.tsx', 'frontend/src/App.tsx'),
  doc('doc:d1:2', 'd1', 'Document "Handover Document" > 3.2 Technology Stack'), doc('doc:d1:9', 'd1', 'Document "Handover Document" > 3.6 Deployment'), doc('doc:d2:0', 'd2', 'Document "Deploy Notes"'),
  other('task1', 'Task: Slack Integration', 'relay', 'task'), other('issue3', 'acme/r issue #3', 'github', 'issue')]);
const APP_FILES = new Map([['backend/app/main.py', API_MAIN], ['backend/app/ai_interpreter.py', API_AI], ['frontend/src/App.tsx', 'export function App() { return null }\n']]);
const APP_PATHS = new Set(APP_FILES.keys());

function verificationFor(paths, over = {}) {
  return buildVerification({
    snapshots: [{ repositoryId: 1, fullName: 'acme/r', branch: 'main', commitSha: 'abc1234', status: 'completed', coverage: { analyzed: paths.size, eligible: paths.size, percent: 100 }, fileManifest: [...paths].map((path) => ({ path, category: 'source' })), knowledge: { buildAndTest: [], overview: { frameworks: [] }, deploy: [] } }],
    freshnessByRepo: new Map(), openWork: { openPullRequests: 0, openIssues: 0, openJira: null }, documents: { included: [], notIndexed: [] }, openTasks: 0, ...over,
  });
}

function pipeline({ ai, evidence, files, extra = {}, assemble = {} }) {
  const knownPaths = new Set(files.keys());
  const sym = buildSymbolTable(files, knownPaths);
  const verification = extra.verification || verificationFor(knownPaths);
  const { state, removed } = validateHandoff({ summary: 'A signal demo.', ...ai }, { evidence, knownPaths, symbols: sym.table, symbolInfo: sym.info, callEdges: sym.edges, verification, fallbackSummary: 'acme/r is a repository.', ...extra, evidenceText: extra.evidenceText || new Map([...files].map(([p, t]) => [`file:1:${p}`, t])) });
  const empty = { openPrs: [], openIssues: [], closedPrs: [], commits: [], jiraOpen: [] };
  const assembled = assembleReport({ state, evidence, activity: empty, setup: [], startFallback: [], verification, ...assemble });
  return { state, removed, verification, sym, ...assembled };
}

const storedReport = (r, over = {}) => ({
  projectId: 'p', projectName: 'Scenario', generatedAt: '2026-10-12T20:00:00Z', complexity: 'small', summary: r.brief.summary, brief: r.brief, verification: r.verification, sections: r.sections, sourceIndex: r.sourceIndex,
  repositories: [{ fullName: 'acme/r', branch: 'main', commitSha: 'abc1234', status: 'completed', coverage: { analyzed: 3, eligible: 3, percent: 100 }, freshness: 'current' }], limitations: [validationNote(r.removed)].filter(Boolean), ...over,
});

const amPath = () => ({
  title: 'Interactive AM modulation and envelope recovery', purpose: 'Shows how a message tone is amplitude-modulated onto a carrier and how the envelope is recovered, with sliders for the parameters.',
  entry_point: 'main.py', flow: 'main.py builds the signals in generate_signals and redraws the plots from the update slider callback.',
  steps: ['generate_signals builds a 2000-sample time axis covering 10 ms.', 'It forms the message cos(2*pi*fm*t) and the modulated carrier (1 + ma*message)*cos(2*pi*fc*t).', 'The envelope is the absolute value of the modulated signal.', 'update calls generate_signals with the slider values and replots the message.'],
  key_functions: [{ name: 'generate_signals', role: 'Takes fm, fc and ma and returns the time axis, message, modulated signal and envelope.' }, { name: 'update', role: 'Slider callback that regenerates the signals and replots.' }, { name: 'fm_demodulate', role: 'Does FM demodulation.' }],
  inputs: ['Slider values fm, fc, ma'], outputs: ['Three matplotlib subplots'], dependencies: ['numpy', 'matplotlib (Slider widget)'], limitations: ['No FM modulation or demodulation function exists in the analyzed code.'],
  files: ['main.py'], symbols: ['generate_signals', 'update'], kind: 'fact', source_ids: ['file:1:main.py'],
});

// ---------------------------------------------------------------------------------------------------------------
// PDF layout checks (pdfjs): no blank pages, nothing clipped
// ---------------------------------------------------------------------------------------------------------------

async function inspectPdf(buffer) {
  const pdf = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const { width, height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter((x) => x.str.trim());
    pages.push({ width, height, items, text: items.map((x) => x.str).join(' ') });
  }
  return pages;
}
function assertLayout(pages) {
  pages.forEach((p, i) => {
    assert.ok(p.items.length > 4, `page ${i + 1} is blank or nearly blank`);
    for (const it of p.items) {
      const [, , , , x, y] = it.transform;
      assert.ok(x >= 0 && x + it.width <= p.width - 20, `clipped on the right (page ${i + 1}): "${it.str.slice(0, 40)}" ends at ${Math.round(x + it.width)} of ${Math.round(p.width)}`);
      assert.ok(y > 10 && y < p.height - 10, `outside the page vertically (page ${i + 1}): "${it.str.slice(0, 40)}" y=${Math.round(y)}`);
    }
    assert.match(p.text, new RegExp(`page ${i + 1} of ${pages.length}`), 'footer and page numbering');
  });
}
const flat = (pages) => pages.map((p) => p.text).join(' ').replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------------------------------------------

describe('technical depth from real source (small, three-file project)', () => {
  it('derives definitions, nested callbacks and textual call sites from the source itself', () => {
    const defs = scanDefinitions('main.py', AM_MAIN);
    assert.deepEqual(defs.map((d) => [d.name, d.line]), [['generate_signals', 5], ['update', 14]]);
    const edges = callEdges(AM_FILES, new Set(defs.map((d) => d.name)));
    assert.deepEqual(edges, [{ file: 'main.py', from: 'update', to: 'generate_signals', line: 15 }]);
    const { text } = buildSymbolTable(AM_FILES, AM_PATHS);
    assert.match(text, /main\.py: .*generate_signals.*L5.*update.*L14/);
    assert.match(text, /textual call sites: update -> generate_signals L15/);
    assert.match(text, /if __name__|^main\.py/m, 'entry information is present');
  });

  it('keeps the execution flow, verified functions with line numbers and derived call sites; rejects an invented function', () => {
    const { state, removed, sections } = pipeline({ ai: { implementation_paths: [amPath()] }, evidence: AM_EVIDENCE, files: AM_FILES });
    const p = state.paths[0];
    assert.equal(p.entry, 'main.py');
    assert.equal(p.steps.length, 4);
    assert.deepEqual(p.functions.map((f) => [f.name, f.file, f.line]), [['generate_signals', 'main.py', 5], ['update', 'main.py', 14]]);
    assert.deepEqual(p.calls, [{ from: 'update', to: 'generate_signals', line: 15 }]);
    assert.equal(removed.unverifiedSymbols, 1, 'fm_demodulate does not exist');
    assert.deepEqual(p.limits, ['No FM modulation or demodulation function exists in the analyzed code.']);
    const item = sections.find((s) => s.key === 'walkthrough').items[0];
    assert.equal(item.type, 'subsystem'); assert.equal(item.kind, 'fact');
  });

  it('gives a small project a proportionate report: no empty sections, a walkthrough and an onboarding sequence', async () => {
    const r = pipeline({ ai: { implementation_paths: [amPath()], start_here: [{ file: 'main.py', reason: 'holds the whole program: generate_signals and the update callback', source_ids: ['file:1:main.py'] }] }, evidence: AM_EVIDENCE, files: AM_FILES });
    assert.deepEqual(r.sections.map((s) => s.key), ['walkthrough', 'first_30', 'verification']);
    const steps = r.sections.find((s) => s.key === 'first_30').items;
    assert.ok(steps.length >= 3 && steps.every((s) => s.type === 'step'));
    assert.match(steps[1].detail, /Follow "Interactive AM modulation and envelope recovery" from main\.py: generate_signals -> update/);
    assert.deepEqual(steps[0].reads, [{ file: 'main.py', why: 'holds the whole program: generate_signals and the update callback' }]);
    assert.match(r.sections.find((s) => s.key === 'first_30').intro, /not a measured estimate/);
    const pages = await inspectPdf(await renderReportPdf(storedReport(r)));
    assert.ok(pages.length <= 2, `a three-file project fits ${pages.length} page(s)`);
    assertLayout(pages);
    assert.match(flat(pages), /Your First 30 Minutes/); assert.match(flat(pages), /Execution flow/); assert.match(flat(pages), /generate_signals \(main\.py:5\)/);
  });
});

describe('multi-component full-stack application', () => {
  const route = (over = {}) => ({
    title: 'Signal upload and analysis', purpose: 'Accepts an uploaded signal and returns its spectrum with an AI interpretation.', entry_point: 'backend/app/main.py:analyze',
    flow: 'POST /api/signals/upload runs analyze, which preprocesses the signal, computes its spectrum and calls interpret.',
    steps: ['analyze handles POST /api/signals/upload and reads the uploaded file.', 'preprocess_signal cleans the raw bytes.', 'compute_frequency_spectrum produces the spectrum.', 'interpret in backend/app/ai_interpreter.py turns the spectrum into a summary.'],
    key_functions: [{ name: 'analyze', role: 'Route handler for the upload endpoint.' }, { name: 'preprocess_signal', role: 'Prepares the raw signal.' }, { name: 'compute_frequency_spectrum', role: 'Spectrum calculation.' }, { name: 'interpret', role: 'Builds the interpretation; reads GROQ_API_KEY from the environment.' }],
    inputs: ['Uploaded signal file'], outputs: ['JSON with summary and key_set'], dependencies: ['FastAPI', 'Groq API key via GROQ_API_KEY'], limitations: ['Whether interpret actually calls the Groq service is not shown in the analyzed excerpt.'],
    files: ['backend/app/main.py', 'backend/app/ai_interpreter.py'], symbols: ['analyze', 'interpret'], kind: 'fact', source_ids: ['file:1:backend/app/main.py', 'file:1:backend/app/ai_interpreter.py'], ...over,
  });

  it('exposes routes, imports and cross-file call sites to the model as evidence', () => {
    const { text, edges } = buildSymbolTable(APP_FILES, APP_PATHS);
    assert.match(text, /backend\/app\/main\.py: .*routes: POST \/api\/signals\/upload/);
    assert.ok(edges.some((e) => e.file === 'backend/app/main.py' && e.from === 'analyze' && e.to === 'interpret'));
    assert.match(text, /textual call sites: analyze -> preprocess_signal.*analyze -> interpret/);
  });

  it('keeps component-level explanations spanning files, with entry point file:function and cross-file relationships', () => {
    const { state, removed } = pipeline({ ai: { implementation_paths: [route()] }, evidence: APP_EVIDENCE, files: APP_FILES });
    const p = state.paths[0];
    assert.equal(p.entry, 'backend/app/main.py:analyze');
    assert.deepEqual(p.functions.map((f) => [f.name, f.file]), [['analyze', 'backend/app/main.py'], ['preprocess_signal', 'backend/app/main.py'], ['compute_frequency_spectrum', 'backend/app/main.py'], ['interpret', 'backend/app/ai_interpreter.py']]);
    assert.deepEqual(p.calls.map((c) => `${c.from}->${c.to}`).sort(), ['analyze->compute_frequency_spectrum', 'analyze->interpret', 'analyze->preprocess_signal']);
    assert.equal(removed.unverifiedSymbols, 0);
  });

  it('rejects an entry point that does not exist or a path that names a file outside the commit', () => {
    const { state, removed } = pipeline({ ai: { implementation_paths: [route({ entry_point: 'backend/app/ghost.py:analyze' }), route({ title: 'Ghost', files: ['backend/app/ghost.py'], source_ids: ['file:1:backend/app/main.py'] })] }, evidence: APP_EVIDENCE, files: APP_FILES });
    assert.equal(state.paths[0].entry, '');
    assert.ok(removed.unverifiedSymbols >= 1 && removed.unverifiedPaths >= 1);
  });

  it('renders a multi-subsystem report without blank pages or clipped text', async () => {
    const long = 'backend/app/services/with_a_really_long_module_name/another_long_directory_name/an_extremely_long_file_name_that_has_no_spaces_to_wrap_on.py';
    const r = pipeline({ ai: { implementation_paths: [route(), route({ title: 'Second path', entry_point: 'frontend/src/App.tsx', files: ['frontend/src/App.tsx'], symbols: [], key_functions: [], source_ids: ['file:1:frontend/src/App.tsx'] })], summary: 'A signal demo. '.repeat(10) }, evidence: APP_EVIDENCE, files: APP_FILES });
    const report = storedReport(r, { limitations: Array.from({ length: 12 }, (_, i) => `Limitation ${i} ${long}`) });
    const pages = await inspectPdf(await renderReportPdf(report));
    assertLayout(pages);
    assert.match(flat(pages), /Architecture and Technical Walkthrough/);
  });
});

describe('contradictory documentation', () => {
  const conflicts = [
    { requirement: 'Technology stack: Next.js, PostgreSQL, Prisma', status: 'conflicts', detail: 'The handover document describes a Next.js and PostgreSQL stack but the code uses FastAPI and has no database', source_ids: ['doc:d1:2', 'file:1:backend/app/main.py'] },
    { requirement: 'Deployment target', status: 'conflicts', detail: 'Handover document says GCP, deploy notes say Render', source_ids: ['doc:d1:9', 'doc:d2:0'] },
  ];
  const ai = () => ({
    documented_vs_implemented: conflicts,
    blockers: [{ text: 'The handover document describes a Next.js and PostgreSQL stack that conflicts with the FastAPI code, so it misleads a new developer.', kind: 'fact', source_ids: ['doc:d1:2', 'file:1:backend/app/main.py'] }],
    recommendations: [{ action: 'Rewrite the handover document for the FastAPI stack', why: 'The handover document describes a Next.js and PostgreSQL stack, which misleads a new developer', priority: 'P1', basis: 'confirmed', done_when: 'The handover document names FastAPI and contains no reference to Prisma', files: [], source_ids: ['doc:d1:2'] }],
  });

  it('explains each conflict once; the action and the page-one pointer only refer to it', () => {
    const r = pipeline({ ai: ai(), evidence: APP_EVIDENCE, files: APP_FILES });
    const mentioning = r.sections.flatMap((s) => s.items).filter((i) => /Next\.js/.test(i.text));
    assert.equal(mentioning.length, 1, 'the stack conflict is written out in exactly one place');
    assert.equal(r.state.blockers.length, 0, 'the blocker restated the conflict and was collapsed');
    assert.ok(r.removed.duplicate >= 1);
    const conflictItem = r.sections.find((s) => s.key === 'documented_vs_implemented').items[0];
    assert.equal(conflictItem.resolvedLabel, 'Do first #1');
    assert.match(r.brief.findings.text, /2 documentation conflicts/);
    assert.equal(r.brief.attention, undefined);
  });

  it('a conflict between two documents needs no code, but "matches" from a single document stays unverified', () => {
    const r = pipeline({ ai: { documented_vs_implemented: [...conflicts, { requirement: 'Uses Zod', status: 'matches', detail: 'only the document says so', source_ids: ['doc:d1:2'] }] }, evidence: APP_EVIDENCE, files: APP_FILES });
    assert.deepEqual(r.state.comparisons.map((c) => c.status), ['conflicts', 'conflicts', 'unverified']);
  });
});

describe('partial source analysis and unknown runtime behaviour', () => {
  it('keeps unanalyzed gaps visible and never lets the report claim the code runs', async () => {
    const partial = buildVerification({
      snapshots: [{ repositoryId: 1, fullName: 'acme/r', branch: 'main', commitSha: 'abc1234', status: 'partial', coverage: { analyzed: 66, eligible: 75, percent: 88, tooLarge: 9 }, fileManifest: [], knowledge: { buildAndTest: [], overview: { frameworks: [] }, deploy: [] } }],
      freshnessByRepo: new Map(), openWork: { openPullRequests: 0, openIssues: 0, openJira: null }, documents: { included: [], notIndexed: [] }, openTasks: 0,
    });
    const r = pipeline({
      ai: {
        how_it_works: [{ text: 'The script runs successfully and produces the correct plots.', kind: 'fact', source_ids: ['file:1:main.py'] }],
        implementation_paths: [{ ...amPath(), steps: ['Running python main.py displays the window without errors.', 'update calls generate_signals with the slider values and replots the message.'], limitations: ['Whether the plots look correct for every slider setting is not established.'] }],
        unknowns: [{ text: 'Runtime behaviour for extreme slider values was not observed.', kind: 'unknown', source_ids: [] }],
      }, evidence: AM_EVIDENCE, files: AM_FILES, extra: { verification: partial },
    });
    assert.equal(r.state.howItWorks.length, 0);
    assert.deepEqual(r.state.paths[0].steps, ['update calls generate_signals with the slider values and replots the message.']);
    assert.ok(r.removed.execution >= 2);
    assert.equal(r.verification.runtime.status, 'not_verified');
    assert.match(r.verification.coverage[0].gaps.join(), /9 file\(s\) over the size limit/);
    const pages = await inspectPdf(await renderReportPdf(storedReport(r, { limitations: [validationNote(r.removed)] })));
    assert.match(flat(pages), /Runtime behaviour/); assert.match(flat(pages), /not analyzed: 9 file\(s\) over the size limit/);
    assert.doesNotMatch(flat(pages), /runs successfully|without errors/);
    assertLayout(pages);
  });
});

describe('open tasks with unclear requirements and scope mismatches', () => {
  const rec = (over) => ({ action: 'Clarify the scope and acceptance criteria of the Slack Integration task', why: 'The task is open at high priority but nothing in the evidence says what it should do', priority: 'P2', basis: 'confirmed', done_when: 'The task description lists the Slack events to handle and is linked from the task', prerequisites: ['Product owner available'], files: [], source_ids: ['task1'], ...over });

  it('marks work that needs a decision as clarification_needed and never starts onboarding with it', () => {
    const r = pipeline({ ai: { recommendations: [rec()], outstanding_work: [{ text: 'The Slack Integration task is open and marked high priority.', kind: 'fact', source_ids: ['task1'] }], unknowns: [{ text: 'What the Slack Integration task is supposed to do is not specified.', kind: 'unknown', source_ids: ['task1'] }] }, evidence: APP_EVIDENCE, files: APP_FILES });
    assert.equal(r.state.recommendations[0].basis, 'clarification_needed');
    assert.equal(r.state.recommendations[0].priority, 'P2');
    assert.equal(r.state.unknowns.length + r.state.outstanding.length, 0, 'the action already covers the open task; it is not restated as tracked work or an unknown');
    const last = r.sections.find((s) => s.key === 'first_30').items.at(-1);
    assert.equal(last.text, 'Pick a safe first task'); assert.equal(last.kind, 'unknown');
    assert.match(last.detail, /Nothing is ready to start: Clarify the scope/);
  });

  it('treats work inferred only from the repository name as a scope mismatch, not a requirement', () => {
    const r = pipeline({ ai: { recommendations: [
      { action: 'Implement FM modulation and demodulation', why: 'The repository name AM-FM suggests FM is in scope but only AM is implemented in generate_signals', priority: 'P1', basis: 'confirmed', done_when: 'generate_signals has an FM branch that returns a modulated signal', files: ['main.py'], source_ids: ['file:1:main.py'] },
      { action: 'Add a test that checks generate_signals output shape', why: 'No tests exist, so changes to generate_signals are unchecked', priority: 'P2', basis: 'suggested', done_when: 'tests/test_signals.py asserts the returned arrays have 2000 samples', files: ['main.py'], source_ids: ['file:1:main.py'] },
    ] }, evidence: AM_EVIDENCE, files: AM_FILES });
    const [first, second] = r.state.recommendations;
    assert.equal(second.basis, 'clarification_needed'); assert.match(second.note, /Not a confirmed requirement/);
    assert.notEqual(second.priority, 'P1');
    assert.equal(first.basis, 'suggested');
    const firstTask = r.sections.find((s) => s.key === 'first_30').items.at(-1);
    assert.match(firstTask.detail, /Add a test that checks generate_signals output shape/);
  });
});

describe('recommendations carry observable completion criteria', () => {
  it('accepts concrete criteria and rejects vague ones', () => {
    for (const ok of ['pytest covers generate_signals with a 10 Hz tone', 'README.md lists the install and run commands', 'GET /health returns 200', 'The handover document names FastAPI']) assert.equal(observableCriterion(ok), true, ok);
    for (const bad of ['It is done', 'The work is complete', 'it works', 'Everything is fixed', 'good', 'Done.']) assert.equal(observableCriterion(bad), false, bad);
  });

  it('drops a recommendation whose criterion is "it works" and keeps the prerequisites of the others', () => {
    const base = { why: 'The module has no automated checks at all today', priority: 'P2', basis: 'suggested', files: ['main.py'], source_ids: ['file:1:main.py'] };
    const r = pipeline({ ai: { recommendations: [{ ...base, action: 'Add tests for generate_signals', done_when: 'It works', prerequisites: [] }, { ...base, action: 'Add a pytest for generate_signals', done_when: 'tests/test_signals.py asserts the envelope length equals 2000', prerequisites: ['numpy installed'] }] }, evidence: AM_EVIDENCE, files: AM_FILES });
    assert.equal(r.state.recommendations.length, 1);
    assert.deepEqual(r.state.recommendations[0].prerequisites, ['numpy installed']);
    assert.equal(r.removed.malformed, 1);
  });
});

describe('no open issues or pull requests', () => {
  it('states what an empty tracker means and never calls the project complete', async () => {
    const r = pipeline({ ai: {
      summary: 'A signal demo with no open issues, so the project is complete.',
      current_state: [{ text: 'No open issues or pull requests exist, so nothing is pending.', kind: 'fact', source_ids: ['commit1'] }, { text: 'main.py defines generate_signals and update.', kind: 'fact', source_ids: ['file:1:main.py'] }],
      outstanding_work: [{ text: 'There is no remaining work.', kind: 'inference', source_ids: ['commit1'] }],
    }, evidence: AM_EVIDENCE, files: AM_FILES });
    assert.deepEqual(r.brief.currentState.map((c) => c.text), ['main.py defines generate_signals and update.']);
    assert.equal(r.brief.summary, 'acme/r is a repository.');
    assert.ok(!r.sections.some((s) => ['open_items', 'jira_items', 'outstanding_work'].includes(s.key)), 'no empty open-work sections');
    const status = r.brief.status.map((s) => s.text).join(' ');
    assert.match(status, /0 open PR\(s\), 0 open issue\(s\), 0 open Relay task\(s\)\. An empty tracker describes the trackers only; it does not show the work is complete/);
    assert.match(status, /completion not established/);
    const pages = await inspectPdf(await renderReportPdf(storedReport(r)));
    assert.doesNotMatch(flat(pages), /project is complete|nothing is pending|no remaining work/i);
    assertLayout(pages);
  });
});

describe('unsupported AI-generated claims and invalid source references', () => {
  it('removes claims, ghost files and ghost sources, counts them, and summarizes them once', () => {
    const r = pipeline({ ai: {
      how_it_works: [{ text: 'All tests pass and the code compiles.', kind: 'fact', source_ids: ['file:1:main.py'] }, { text: 'Signals are produced in src/ghost/signals.py.', kind: 'fact', source_ids: ['file:1:main.py'] }, { text: 'Only a ghost supports this.', kind: 'fact', source_ids: ['file:9:nowhere.py'] }, { text: 'main.py computes the envelope with np.abs.', kind: 'fact', source_ids: ['file:1:main.py', 'file:9:nowhere.py'] }],
      implementation_paths: [{ ...amPath(), source_ids: ['file:9:nowhere.py'] }],
      start_here: [{ file: 'src/ghost/signals.py', reason: 'x', source_ids: [] }],
    }, evidence: AM_EVIDENCE, files: AM_FILES });
    assert.deepEqual(r.state.howItWorks.map((c) => c.text), ['main.py computes the envelope with np.abs.']);
    assert.equal(r.state.howItWorks[0].ids.length, 1);
    assert.equal(r.state.paths.length, 0, 'a path whose citations were all invented is dropped');
    assert.ok(r.removed.execution >= 1 && r.removed.unverifiedPaths >= 2 && r.removed.citations >= 2);
    const note = validationNote(r.removed);
    assert.match(note, /^Automated validation corrected the AI output before it was stored: /);
    assert.equal(note.split('\n').length, 1);
    assert.ok(r.sourceIndex.every((s) => AM_EVIDENCE.has(s.id)), 'only real sources are numbered');
    assert.equal(validationNote({ completion: 0, execution: 0, unverifiedPaths: 0, unverifiedSymbols: 0, contradiction: 0, citations: 0, aiDropped: 0, duplicate: 0 }), '');
  });
});

describe('duplicate findings are reduced', () => {
  it('describes one tracker item once across verified state, tracked work and unknowns', () => {
    const r = pipeline({ ai: {
      current_state: [{ text: "One open task exists for 'Slack Integration' with high priority.", kind: 'fact', source_ids: ['task1'] }],
      outstanding_work: [{ text: 'Slack Integration task is open and marked as high priority.', kind: 'fact', source_ids: ['task1'] }],
      unknowns: [{ text: "The status of the 'Slack Integration' task and what it entails.", kind: 'unknown', source_ids: ['task1'] }],
    }, evidence: APP_EVIDENCE, files: APP_FILES });
    const mentions = [...r.brief.currentState, ...r.sections.flatMap((s) => s.items)].map((i) => i.text).filter((t) => /Slack Integration/.test(t));
    assert.equal(mentions.length, 1);
    assert.equal(r.removed.duplicate, 2);
  });
});

describe('setup commands are shown without repeating README prose', () => {
  it('extracts only the commands from fenced blocks', () => {
    const excerpt = '## Getting Started\n### 1. Backend\n```bash\ncd backend\npython -m pip install -r requirements.txt\npython -m uvicorn app.main:app --reload\n```\n- API Base URL: `http://localhost:8000`\n```env\nVITE_API_BASE_URL=http://localhost:8000\n```';
    assert.deepEqual(commandsFrom(excerpt), ['cd backend', 'python -m pip install -r requirements.txt', 'python -m uvicorn app.main:app --reload']);
  });
});

describe('prose hygiene and evidence classes', () => {
  it('removes raw evidence ids from sentences but keeps them as citations', () => {
    const r = pipeline({ ai: { documented_vs_implemented: [{ requirement: 'Technology stack', status: 'conflicts', detail: 'The Handover Document (doc:d1:2) says Next.js but file:1:backend/app/main.py uses FastAPI.', source_ids: ['doc:d1:2', 'file:1:backend/app/main.py'] }] }, evidence: APP_EVIDENCE, files: APP_FILES });
    assert.equal(r.state.comparisons[0].detail, 'The Handover Document says Next.js but backend/app/main.py uses FastAPI.');
    assert.deepEqual(r.state.comparisons[0].ids, ['doc:d1:2', 'file:1:backend/app/main.py']);
  });

  it('repository-level evidence (dependencies, components, routes) can support a documentation conflict', () => {
    const evidence = new Map([...APP_EVIDENCE, other('repo:1:dependencies', 'acme/r dependencies', 'repository', 'repository_dependencies')]);
    const r = pipeline({ ai: { documented_vs_implemented: [{ requirement: 'Stack', status: 'conflicts', detail: 'Document says Prisma, the dependency manifests list none', source_ids: ['doc:d1:2', 'repo:1:dependencies'] }] }, evidence, files: APP_FILES });
    assert.equal(r.state.comparisons[0].status, 'conflicts');
  });

  it('links only findings to the action that addresses them, never verified-state facts', () => {
    const r = pipeline({ ai: {
      current_state: [{ text: 'backend/app/main.py exposes the upload route and the analysis pipeline.', kind: 'fact', source_ids: ['file:1:backend/app/main.py'] }],
      recommendations: [{ action: 'Add tests for the upload route and analysis pipeline in backend/app/main.py', why: 'The upload route and analysis pipeline in backend/app/main.py have no automated checks', priority: 'P2', basis: 'suggested', done_when: 'tests/test_api.py asserts POST /api/signals/upload returns 200', files: ['backend/app/main.py'], source_ids: ['file:1:backend/app/main.py'] }],
    }, evidence: APP_EVIDENCE, files: APP_FILES });
    assert.equal(r.brief.currentState[0].resolvedBy, undefined);
  });
});
