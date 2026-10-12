import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReport, indexSources, BRIEF_ACTIONS } from '../../src/services/handoffAssembly.js';

const evidence = new Map(['a', 'b', 'c'].map((x) => [`file:1:${x}.py`, { id: `file:1:${x}.py`, label: `repo/${x}.py`, url: `https://github.com/acme/r/blob/abc/${x}.py`, provider: 'repository', type: 'file' }]));
const rec = (n, priority = 'P2', basis = 'suggested') => ({ action: `Action ${n} for the module`, why: 'Because it matters here', doneWhen: 'A check passes', priority, basis, files: [], ids: ['file:1:a.py'] });
const empty = { openPrs: [], openIssues: [], closedPrs: [], commits: [], jiraOpen: [] };
const base = { summary: 'S', currentState: [], howItWorks: [], paths: [], outstanding: [], blockers: [], risks: [], unknowns: [], comparisons: [], recommendations: [], startHere: [] };
const build = (state, extra = {}) => assembleReport({ state: { ...base, ...state }, evidence, activity: empty, setup: [], startFallback: [], ...extra });

describe('assembleReport', () => {
  it('puts the top actions in the brief and only the remainder in the recommendations section', () => {
    const { brief, sections } = build({ recommendations: [rec(1, 'P1', 'confirmed'), rec(2), rec(3), rec(4), rec(5, 'P3')] });
    assert.equal(brief.doFirst.length, BRIEF_ACTIONS);
    assert.deepEqual(sections.find((s) => s.key === 'recommendations').items.map((i) => i.text), ['Action 4 for the module', 'Action 5 for the module']);
    assert.equal(brief.doFirst[0].priority, 'P1'); assert.equal(brief.doFirst[0].type, 'recommendation');
  });

  it('explains each finding once in the risks group and only points to it from page one', () => {
    const { brief, sections } = build({
      blockers: [{ text: 'Blocker one', kind: 'fact', ids: ['file:1:a.py'] }, { text: 'Blocker two', kind: 'fact', ids: [] }],
      risks: [{ text: 'A risk', kind: 'inference', ids: ['file:1:b.py'] }],
      unknowns: [{ text: 'An unknown', kind: 'unknown', ids: [] }],
      comparisons: [{ requirement: 'Tokens expire', status: 'conflicts', detail: 'code differs', ids: ['file:1:a.py'] }],
    });
    assert.equal(brief.attention, undefined, 'page one no longer repeats the findings');
    assert.match(brief.findings.text, /1 documentation conflict, 2 confirmed blockers, 1 inferred risk, 1 unknown\. Each is explained once/);
    const keys = sections.map((s) => s.key);
    assert.deepEqual(keys, ['documented_vs_implemented', 'blockers_risks', 'unknowns']);
    assert.ok(sections.every((s) => s.group === 'Known Risks, Unknowns, and Verification Status'));
    assert.equal(JSON.stringify(sections).split('Blocker one').length - 1, 1);
    assert.equal(sections.find((s) => s.key === 'blockers_risks').items.at(-1).label, 'inferred risk');
  });

  it('links a finding to the action that addresses it instead of repeating the explanation', () => {
    const { sections } = build({
      comparisons: [{ requirement: 'Technology stack Next.js PostgreSQL', status: 'conflicts', detail: 'handover document describes Next.js PostgreSQL but code uses FastAPI', ids: ['file:1:a.py'] }],
      recommendations: [{ action: 'Rewrite the handover document for the FastAPI stack', why: 'The handover document describes Next.js PostgreSQL which misleads a new developer', doneWhen: 'handover document names FastAPI', priority: 'P1', basis: 'confirmed', files: [], ids: ['file:1:a.py'] }],
    });
    const item = sections.find((s) => s.key === 'documented_vs_implemented').items[0];
    assert.equal(item.resolvedBy, 1); assert.equal(item.resolvedLabel, 'Do first #1');
  });

  it('omits empty sections instead of filling a template, and adapts to what exists', () => {
    assert.deepEqual(build({}).sections.map((s) => s.key), ['first_30'].filter(() => false));
    const { sections } = build({ howItWorks: [{ text: 'It works like this', kind: 'fact', ids: ['file:1:a.py'] }] });
    assert.deepEqual(sections.map((s) => s.key), ['walkthrough', 'first_30']);
    const big = build({ howItWorks: [{ text: 'x one', kind: 'fact', ids: [] }], outstanding: [{ text: 'o', kind: 'fact', ids: [] }], unknowns: Array.from({ length: 6 }, (_, i) => ({ text: `u${i}`, kind: 'unknown', ids: [] })) });
    assert.deepEqual(big.sections.map((s) => s.key), ['walkthrough', 'first_30', 'outstanding_work', 'unknowns']);
  });

  it('numbers each cited source once in reading order and stamps refs on items', () => {
    const { brief, sections, sourceIndex } = build({
      currentState: [{ text: 'cs', kind: 'fact', ids: ['file:1:b.py'] }],
      recommendations: [rec(1)],
      howItWorks: [{ text: 'hw', kind: 'fact', ids: ['file:1:b.py', 'file:1:c.py'] }],
    });
    assert.deepEqual(sourceIndex.map((s) => [s.n, s.id]), [[1, 'file:1:b.py'], [2, 'file:1:a.py'], [3, 'file:1:c.py']]);
    assert.deepEqual(brief.currentState[0].refs, [1]); assert.deepEqual(brief.doFirst[0].refs, [2]);
    assert.deepEqual(sections[0].items[0].refs, [1, 3]);
    assert.ok(sourceIndex.every((s) => s.label && s.type === 'repository_file'));
  });

  it('falls back to deterministic entry points when the model gave no reading order, and keeps deterministic extras', () => {
    const fallback = [{ text: 'main.py: entry point', kind: 'fact', type: 'start', files: ['main.py'], evidence: [] }];
    const { sections } = build({}, { startFallback: fallback, extraUnknowns: [{ text: 'No setup instructions were found.', ids: [] }], setup: [{ text: '`start` runs `node x`', kind: 'fact', inline: true, evidence: [] }] });
    assert.deepEqual(sections.map((s) => [s.key, s.origin]), [['first_30', 'ai'], ['setup', 'deterministic'], ['unknowns', 'ai']]);
    const steps = sections[0].items;
    assert.equal(steps[0].reads[0].file, 'main.py'); assert.equal(steps[0].reads[0].why, 'detected entry point');
    assert.ok(indexSources({ currentState: [], doFirst: [] }, []).length === 0);
  });
});
