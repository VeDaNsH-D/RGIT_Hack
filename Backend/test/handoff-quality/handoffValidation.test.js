import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateHandoff, unsupportedAssertion, validationLimitations } from '../../src/services/handoffValidation.js';
import { buildVerification, classifyComplexity, testEvidence, verificationNotes } from '../../src/services/engineeringState.js';

const ev = (id, label, provider, type, extra = {}) => [id, { id, label, url: null, provider, type, ...extra }];
const EVIDENCE = new Map([
  ev('file:1:main.py', 'repo/main.py@abc', 'repository', 'file'),
  ev('file:1:README.md', 'repo/README.md@abc', 'repository', 'file'),
  ev('repo:1:overview', 'repo overview', 'repository', 'repository_overview'),
  ev('gh_issue_4', 'repo issue #4', 'github', 'issue'),
  ev('gh_pr_9', 'repo PR #9', 'github', 'pull_request'),
  ev('slack_1', 'Slack #dev', 'slack', 'note'),
  ev('jira_1', 'Jira PAY-1', 'jira', 'issue'),
  ev('doc:d1:0', 'Document "PRD" > Auth', 'document', 'document_excerpt', { document: { documentId: 'd1' } }),
  ev('doc:d2:0', 'Document "Plan"', 'document', 'document_excerpt', { document: { documentId: 'd2' } }),
]);
const KNOWN = new Set(['main.py', 'README.md', 'src/util/signal.py', 'tests/test_main.py']);
const SYMBOLS = new Map([['main.py', new Set(['am_modulate', 'fm_demodulate'])]]);

const verification = (over = {}) => buildVerification({
  snapshots: [{ repositoryId: 1, fullName: 'acme/sig', branch: 'main', commitSha: 'abc1234', status: 'completed', coverage: { analyzed: 3, eligible: 3, percent: 100 }, fileManifest: [{ path: 'main.py', category: 'entrypoint' }], knowledge: { buildAndTest: [], overview: { frameworks: [] }, deploy: [] } }],
  freshnessByRepo: new Map(), openWork: { openPullRequests: 0, openIssues: 0, openJira: null }, documents: { included: [], notIndexed: [] }, openTasks: 0, ...over,
});
const run = (ai, ctx = {}) => validateHandoff({ summary: 'A signal demo.', ...ai }, { evidence: EVIDENCE, knownPaths: KNOWN, symbols: SYMBOLS, verification: verification(), fallbackSummary: 'acme/sig is a Python repository.', ...ctx });
const claim = (text, kind = 'fact', ids = ['file:1:main.py']) => ({ text, kind, source_ids: ids });

describe('unsupported completion and execution claims', () => {
  it('detects completion and execution assertions and exempts negated statements', () => {
    for (const t of ['The project is complete.', 'No open issues are pending; the project is complete.', 'All requirements are met.', 'The work is fully implemented.', 'There is no remaining work.', 'Nothing left to implement.']) assert.equal(unsupportedAssertion(t), 'completion', t);
    for (const t of ['All tests pass.', 'The test suite passes.', 'The code compiles and runs.', 'The script runs successfully.', 'The script runs with Python 3.', 'No errors were found.', 'The code compiles, runs as per the README.']) assert.equal(unsupportedAssertion(t), 'execution', t);
    for (const t of ['Whether the project is complete is not established.', 'It was not verified that the script runs successfully.', 'Tests were not executed.', 'The code has not been shown to compile.', 'No test results are available.']) assert.equal(unsupportedAssertion(t), null, t);
    assert.equal(unsupportedAssertion('All tests pass.', { executionEvidence: true }), null, 'real execution evidence would allow it');
  });

  it('removes them from every list, the summary and recommendations, and counts why', () => {
    const { state, removed } = run({
      summary: 'A signal demo. The project is complete and all tests pass.',
      current_state: [claim('The project is complete.'), claim('main.py defines am_modulate and fm_demodulate.')],
      how_it_works: [claim('The code compiles and runs as per the README.', 'fact', ['file:1:README.md'])],
      recommendations: [{ action: 'Ship it; everything works', why: 'The project is fully implemented and done.', priority: 'P1', basis: 'confirmed', done_when: 'the release ships to all users', files: [], source_ids: ['file:1:main.py'] }],
    });
    assert.deepEqual(state.currentState.map((c) => c.text), ['main.py defines am_modulate and fm_demodulate.']);
    assert.equal(state.howItWorks.length, 0); assert.equal(state.recommendations.length, 0);
    assert.equal(state.summary, 'A signal demo.');
    assert.ok(removed.completion >= 3 && removed.execution >= 1, JSON.stringify(removed));
    const lines = validationLimitations(removed).join('\n');
    assert.match(lines, /claimed the work is complete/); assert.match(lines, /code runs, compiles or tests pass/);
  });

  it('falls back to a neutral summary when nothing in it survives', () => {
    assert.equal(run({ summary: 'The project is complete.' }).state.summary, 'acme/sig is a Python repository.');
  });
});

describe('absence is not completion', () => {
  it('drops "no X" statements presented as facts or inferences but keeps them as unknowns', () => {
    const { state, removed } = run({
      current_state: [claim('No open issues or pull requests exist, so nothing is pending.'), claim('There are no blockers or risks.', 'inference')],
      unknowns: [{ text: 'No requirements document was provided, so completion cannot be assessed.', kind: 'unknown', source_ids: [] }],
    });
    assert.equal(state.currentState.length, 0);
    assert.equal(removed.absence, 2);
    assert.equal(state.unknowns[0].kind, 'unknown');
  });

  it('states what an empty tracker does and does not show, and that completion is not established', () => {
    const v = verification();
    assert.match(v.workTracking.detail, /No open issues, pull requests.*were found.*does not show that the work is complete/);
    assert.equal(v.completion.status, 'not_established');
    assert.match(v.completion.detail, /no requirements were provided to compare against; no tests were executed; runtime behaviour was not verified/);
    assert.match(verificationNotes(v, 'small'), /an empty tracker does not mean the work is complete/);
  });

  it('missing requirements: completion against requirements cannot be assessed; with documents it says so differently', () => {
    assert.equal(verification().requirements.status, 'none_provided');
    assert.match(verification().requirements.detail, /completion against requirements cannot be assessed/);
    const withDoc = verification({ documents: { included: [{ title: 'PRD' }], notIndexed: [] } });
    assert.equal(withDoc.requirements.status, 'documents_provided');
    assert.doesNotMatch(withDoc.completion.detail, /no requirements were provided/);
    assert.match(withDoc.completion.detail, /Completion is not established/);
  });
});

describe('tests discovered vs executed', () => {
  const snap = { repositoryId: 1, fullName: 'a/b', branch: 'main', commitSha: 'abc', status: 'completed', coverage: { analyzed: 5, eligible: 5, percent: 100 },
    fileManifest: [{ path: 'main.py', category: 'entrypoint' }, { path: 'tests/test_main.py', category: 'test' }, { path: 'tests/test_util.py', category: 'test' }],
    knowledge: { buildAndTest: [{ name: 'test', command: 'pytest', file: 'package.json' }, { name: 'start', command: 'node x', file: 'package.json' }], overview: { frameworks: ['pytest', 'Express'] }, deploy: ['.github/workflows/ci.yml'] } };

  it('lists discovered tests but always reports that none were executed and runtime was not verified', () => {
    const t = testEvidence([snap]);
    assert.deepEqual([t.fileCount, t.frameworks, t.ci, t.scripts.map((s) => s.name)], [2, ['pytest'], ['.github/workflows/ci.yml'], ['test']]);
    const v = verification({ snapshots: [snap] });
    assert.equal(v.tests.executed.status, 'none_available');
    assert.match(v.tests.executed.detail, /does not run code.*2 test file\(s\) and 1 test script\(s\) were found but not executed/);
    assert.equal(v.runtime.status, 'not_verified');
    assert.match(verification().tests.executed.detail, /No test files or test scripts were found/);
  });

  it('removes statements that contradict the discovered-test facts', () => {
    const withTests = verification({ snapshots: [snap] });
    const { state, removed } = run({ risks: [{ text: 'The repository lacks any automated tests.', kind: 'inference', source_ids: ['file:1:main.py'] }], how_it_works: [claim('There are no tests in the project.')] }, { verification: withTests });
    assert.equal(state.risks.length, 0); assert.equal(state.howItWorks.length, 0); assert.ok(removed.contradiction >= 1 || removed.absence >= 1);
    const none = run({ how_it_works: [claim('The project has automated unit tests covering the filters.')] });
    assert.equal(none.state.howItWorks.length, 0); assert.equal(none.removed.contradiction, 1);
  });

  it('removes "no open issues" when the trackers show open work', () => {
    const v = verification({ openWork: { openPullRequests: 2, openIssues: 0, openJira: null } });
    const { state, removed } = run({ outstanding_work: [claim('There are no open issues for this repository.', 'inference', ['gh_pr_9'])] }, { verification: v });
    assert.equal(state.outstanding.length, 0); assert.ok(removed.absence + removed.contradiction >= 1);
  });
});

describe('fact vs inference vs unknown', () => {
  it('blockers need a confirming source; otherwise they become inferred risks', () => {
    const { state } = run({ blockers: [
      claim('Issue 4 reports that login fails.', 'fact', ['gh_issue_4']),
      claim('The retry queue may slip.', 'fact', ['slack_1']),
      claim('main.py might be slow.', 'inference', ['file:1:main.py']),
      claim('Unsupported speculation.', 'inference', []),
    ] });
    assert.deepEqual(state.blockers.map((b) => b.text), ['Issue 4 reports that login fails.']);
    assert.ok(state.blockers.every((b) => b.kind === 'fact'));
    assert.ok(!state.blockers.some((b) => /slip/.test(b.text)), 'Slack-only evidence cannot confirm a blocker');
    assert.ok(state.risks.every((r) => r.kind === 'inference' && r.ids.length > 0));
    assert.ok(state.risks.some((r) => /retry queue may slip/.test(r.text)));
    assert.ok(!state.risks.some((r) => /speculation/.test(r.text)), 'a risk with no evidence is speculation and is dropped');
  });

  it('current state keeps only verified facts; inferences and unknowns move to where they belong; uncited facts are downgraded', () => {
    const { state, removed } = run({ current_state: [claim('main.py defines am_modulate.'), claim('It probably targets teaching.', 'inference'), claim('Test coverage is unknown.', 'unknown', []), claim('An uncited fact.', 'fact', [])] });
    assert.deepEqual(state.currentState.map((c) => c.text), ['main.py defines am_modulate.']);
    assert.ok(state.howItWorks.some((c) => /teaching/.test(c.text)) && state.unknowns.some((c) => /Test coverage/.test(c.text)));
    assert.ok(removed.downgraded >= 2);
  });

  it('ids that were not sent to the model are ignored and the claim is downgraded', () => {
    const { state } = run({ how_it_works: [claim('Cites a ghost.', 'fact', ['file:1:ghost.py', 'file:1:main.py'])] });
    assert.deepEqual(state.howItWorks[0].ids, ['file:1:main.py']);
  });
});

describe('file and symbol references are checked against the analyzed commit', () => {
  it('removes statements naming files that do not exist and keeps documented paths cited to a document', () => {
    const doc = new Map([['doc:d1:0', 'The exporter lives in src/exporter/pdf.js']]);
    const { state, removed } = run({
      how_it_works: [claim('Signals are generated in src/util/signal.py.'), claim('Filtering happens in src/ghost/filter.py.')],
      outstanding_work: [{ text: 'Per the PRD the exporter lives in src/exporter/pdf.js.', kind: 'inference', source_ids: ['doc:d1:0'] }],
    }, { docText: doc });
    assert.deepEqual(state.howItWorks.map((c) => c.text), ['Signals are generated in src/util/signal.py.']);
    assert.equal(state.outstanding.length, 1);
    assert.equal(removed.unverifiedPaths, 1);
  });

  it('implementation paths keep only verified files and symbols, and say fact only with code evidence', () => {
    const { state, removed } = run({ implementation_paths: [
      { title: 'Modulation', flow: 'main.py builds the carrier and calls am_modulate to shape its amplitude.', files: ['main.py', 'ghost.py'], symbols: ['am_modulate', 'made_up', 'fm_demodulate'], kind: 'fact', source_ids: ['file:1:main.py'] },
      { title: 'Ghost flow', flow: 'Runs through a module that does not exist.', files: ['ghost.py'], symbols: [], kind: 'fact', source_ids: ['file:1:main.py'] },
      { title: 'Doc-only', flow: 'Described only by the README text, no code cited.', files: ['README.md'], symbols: [], kind: 'fact', source_ids: ['gh_issue_4'] },
    ] });
    assert.equal(state.paths.length, 2);
    assert.deepEqual([state.paths[0].files, state.paths[0].symbols, state.paths[0].kind], [['main.py'], ['am_modulate', 'fm_demodulate'], 'fact']);
    assert.equal(state.paths[1].kind, 'inference');
    assert.equal(removed.unverifiedSymbols, 1); assert.ok(removed.unverifiedPaths >= 2);
  });

  it('start-here list contains only real files, once each', () => {
    const { state } = run({ start_here: [{ file: 'main.py', reason: 'core', source_ids: ['file:1:main.py'] }, { file: 'main.py', reason: 'dup', source_ids: [] }, { file: 'nope.py', reason: 'x', source_ids: [] }] });
    assert.deepEqual(state.startHere.map((s) => s.file), ['main.py']);
  });
});

describe('model slips that are corrected rather than punished', () => {
  it('accepts an evidence id where a file path belongs', () => {
    const { state } = run({
      implementation_paths: [{ title: 'Main flow', flow: 'main.py runs am_modulate and then plots the signal it produced.', files: ['file:1:main.py'], symbols: ['am_modulate'], kind: 'fact', source_ids: ['file:1:main.py'] }],
      start_here: [{ file: 'file:1:main.py', reason: 'all logic', source_ids: ['file:1:main.py'] }],
      recommendations: [{ action: 'Parameterize the cutoff in am_modulate', why: 'It is hard-coded in the script today.', priority: 'P2', basis: 'suggested', done_when: 'am_modulate accepts a cutoff argument', files: ['file:1:main.py'], source_ids: ['file:1:main.py'] }],
    });
    assert.deepEqual([state.paths[0].files, state.startHere[0].file, state.recommendations[0].files], [['main.py'], 'main.py', ['main.py']]);
  });

  it('code can confirm a defect only through an explicit marker (TODO / placeholder / not implemented), never by being cited', () => {
    const rec = (ids) => ({ action: 'Implement fm_demodulate properly', why: 'The function is a stub and returns a meaningless result.', priority: 'P1', basis: 'confirmed', done_when: 'fm_demodulate recovers a known message tone', files: ['main.py'], source_ids: ids });
    const marked = run({ recommendations: [rec(['file:1:main.py'])], blockers: [claim('fm_demodulate is a placeholder and returns the wrong thing.', 'fact', ['file:1:main.py'])] }, { evidenceText: new Map([['file:1:main.py', 'def fm_demodulate(s):\n    analytic = s  # placeholder\n']]) });
    assert.deepEqual([marked.state.recommendations[0].priority, marked.state.recommendations[0].basis], ['P1', 'confirmed']);
    assert.equal(marked.state.blockers.length, 1);
    const unmarked = run({ recommendations: [rec(['file:1:main.py'])], blockers: [claim('fm_demodulate is wrong.', 'fact', ['file:1:main.py'])] }, { evidenceText: new Map([['file:1:main.py', 'def fm_demodulate(s):\n    return 1\n']]) });
    assert.deepEqual([unmarked.state.recommendations[0].priority, unmarked.state.recommendations[0].basis], ['P2', 'suggested']);
    assert.equal(unmarked.state.blockers.length, 0); assert.equal(unmarked.state.risks.length, 1);
  });

  it('does not repeat a recommendation as outstanding work, a risk or an unknown', () => {
    const { state, removed } = run({
      outstanding_work: [claim('Add unit tests for am_modulate and fm_demodulate functions', 'inference', ['gh_issue_4']), claim('The envelope filter cutoff is fixed at 20 Hz', 'fact', ['gh_issue_4'])],
      recommendations: [{ action: 'Add unit tests for the am_modulate and fm_demodulate functions', why: 'No tests exist so behaviour is unchecked.', priority: 'P2', basis: 'suggested', done_when: 'pytest covers both functions with a tone', files: [], source_ids: ['file:1:main.py'] }],
    });
    assert.deepEqual(state.outstanding.map((c) => c.text), ['The envelope filter cutoff is fixed at 20 Hz']);
    assert.ok(removed.duplicate >= 1);
  });
});

describe('outstanding work is tracked work', () => {
  it('only tracked or documented items stay; unconfirmed ones become inferred risks, uncited ones are dropped', () => {
    const { state, removed } = run({ outstanding_work: [
      claim('Issue 4 asks for the retry queue to be finished.', 'fact', ['gh_issue_4']),
      claim('The retry queue looks unfinished from the code.', 'fact', ['file:1:main.py']),
      claim('Something nobody tracked.', 'inference', []),
    ] });
    assert.deepEqual(state.outstanding.map((c) => c.text), ['Issue 4 asks for the retry queue to be finished.']);
    assert.ok(state.risks.some((r) => /looks unfinished/.test(r.text) && r.kind === 'inference'));
    assert.ok(removed.downgraded >= 1 && removed.malformed >= 1);
  });

  it('an explicit TODO marker in the cited code confirms unfinished work', () => {
    const { state } = run({ outstanding_work: [claim('fm_demodulate is marked as a placeholder.', 'fact', ['file:1:main.py'])] }, { evidenceText: new Map([['file:1:main.py', 'def fm_demodulate(s):\n    return s  # TODO real demodulation\n']]) });
    assert.equal(state.outstanding.length, 1);
  });
});

describe('recommendations are prioritized by evidence, not enthusiasm', () => {
  const rec = (over) => ({ action: 'Add unit tests for am_modulate', why: 'No tests exist for the core function.', priority: 'P2', basis: 'suggested', done_when: 'pytest covers am_modulate edge cases', files: ['main.py'], source_ids: ['file:1:main.py'], ...over });

  it('suggested work can never be P1; confirmed work can; order is priority then confirmed first', () => {
    const { state } = run({ recommendations: [
      rec({ action: 'Rewrite everything now', priority: 'P1', basis: 'suggested', why: 'Because it would be cleaner overall.' }),
      rec({ action: 'Fix the login failure from issue 4', why: 'Issue 4 reports failures for all users.', priority: 'P1', basis: 'confirmed', done_when: 'Login returns 200 for valid users', source_ids: ['gh_issue_4'] }),
      rec({ action: 'Document the CLI flags', priority: 'P3', why: 'The README does not list the flags.' }),
    ] });
    assert.deepEqual(state.recommendations.map((r) => [r.priority, r.basis]), [['P1', 'confirmed'], ['P2', 'suggested'], ['P3', 'suggested']]);
    assert.match(state.recommendations[0].action, /login failure/);
  });

  it('a "confirmed" recommendation that cites nothing, or only Slack, is only suggested', () => {
    const { state } = run({ recommendations: [rec({ priority: 'P1', basis: 'confirmed', source_ids: [] }), rec({ action: 'Pick up recurring invoices work', why: 'Slack says nobody owns it.', priority: 'P2', basis: 'confirmed', source_ids: ['slack_1'] })] });
    assert.ok(state.recommendations.every((r) => r.basis === 'suggested' && r.priority !== 'P1'));
  });

  it('drops generic items missing a reason or completion criteria, ghost files and duplicates; does not invent urgency', () => {
    const { state, removed } = run({ recommendations: [
      rec({ action: 'Improve code quality', why: '', done_when: '' }),
      rec({ action: 'Refactor src/ghost/engine.py', why: 'It is unclear what it does today.' }),
      rec(), rec({ action: 'Add unit tests for am_modulate function' }),
    ] });
    assert.equal(state.recommendations.length, 1);
    assert.ok(removed.malformed >= 1 && removed.unverifiedPaths >= 1 && removed.duplicate >= 1);
    assert.ok(state.recommendations.every((r) => r.priority !== 'P1'), 'no confirmed evidence -> no top priority');
    assert.deepEqual(Object.keys(state.recommendations[0]).sort(), ['action', 'basis', 'doneWhen', 'files', 'ids', 'note', 'prerequisites', 'priority', 'symbols', 'why']);
  });
});

describe('documented requirements vs implementation', () => {
  it('needs a document; matches/conflicts need a second evidence class; two documents can conflict', () => {
    const { state, removed } = run({ documented_vs_implemented: [
      { requirement: 'Tokens expire in 15 minutes', status: 'conflicts', detail: 'auth code sets 24h', source_ids: ['doc:d1:0', 'file:1:main.py'] },
      { requirement: 'Passwords use bcrypt', status: 'matches', detail: 'only the PRD says so', source_ids: ['doc:d1:0'] },
      { requirement: 'Deploy target', status: 'conflicts', detail: 'Plan says Vercel, PRD says AWS', source_ids: ['doc:d1:0', 'doc:d2:0'] },
      { requirement: 'No document at all', status: 'matches', detail: 'x', source_ids: ['file:1:main.py'] },
    ] });
    assert.deepEqual(state.comparisons.map((c) => [c.requirement, c.status]), [['Tokens expire in 15 minutes', 'conflicts'], ['Passwords use bcrypt', 'unverified'], ['Deploy target', 'conflicts']]);
    assert.equal(removed.malformed, 1);
  });
});

describe('repetition across lists is collapsed', () => {
  it('drops a statement that restates one already made', () => {
    const { state, removed } = run({
      current_state: [claim('main.py is the single Python script and contains all signal logic.')],
      how_it_works: [claim('main.py is the single Python script that contains all of the signal logic.'), claim('am_modulate scales the carrier amplitude by the message.')],
    });
    assert.deepEqual(state.howItWorks.map((c) => c.text), ['am_modulate scales the carrier amplitude by the message.']);
    assert.equal(removed.duplicate, 1);
  });
});

describe('complexity classification adapts the report to the repository', () => {
  const snap = (analyzed, components = 1, routes = 0, code = 2) => ({ coverage: { analyzed }, fileManifest: Array.from({ length: code }, () => ({ category: 'source' })), knowledge: { components: Array.from({ length: components }), routes: Array.from({ length: routes }) } });
  it('small script, medium service, large application, multiple repositories', () => {
    assert.equal(classifyComplexity([snap(3)]), 'small');
    assert.equal(classifyComplexity([snap(30, 4, 10, 18)]), 'medium');
    assert.equal(classifyComplexity([snap(120, 9, 40, 70)]), 'large');
    assert.equal(classifyComplexity([snap(3), snap(3)]), 'medium');
  });
});

describe('long text is shortened at a boundary, never mid-word', () => {
  it('fit() keeps whole sentences or words and marks the cut', async () => {
    const { fit } = await import('../../src/services/handoffValidation.js');
    assert.equal(fit('Short text.', 50), 'Short text.');
    const long = 'First sentence is complete. Second sentence keeps going with many words that will not fit into the limit given';
    assert.equal(fit(long, 60), 'First sentence is complete. Second sentence keeps going...');
    assert.ok(fit(long, 60).length <= 60 && fit(long, 60).endsWith('...') && !/\bwor\.\.\.$/.test(fit(long, 60)));
    assert.match(fit('word '.repeat(40), 33), /^(word )*word\.\.\.$/);
  });
});
