import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankChunks } from './retrieval.js';
import { chatTerms, questionIntent, repositoryEvidence, repositoryFileKind } from './repositoryEvidence.js';
import { splitEvidence, selectEvidence } from './evidenceSelection.js';
import { knowledgeMessages } from './knowledgeStatus.js';

test('chunks keep Markdown sections and function declarations as separate evidence', () => {
  const chunks = splitEvidence('# Purpose\nRoom booking.\n## Setup\nRun npm install.');
  assert.equal(chunks.length, 2);
  assert.match(chunks[1].text, /^## Setup/);
  assert.equal(splitEvidence('function first() {\n return 1;\n}\nfunction second() {\n return 2;\n}').length, 2);
  assert.ok(splitEvidence('x'.repeat(3500)).every(chunk => chunk.text.length <= 1200));
});
test('reranking removes duplicate text while retaining source diversity and budget', () => {
  const ranked = rankChunks([
    { key: 'file:1:0', text: 'retry queue', title: 'retry' },
    { key: 'file:2:0', text: 'retry queue', title: 'retry' },
    { key: 'file:3:0', text: 'retry failures', title: 'retry' },
  ], 'retry');
  const selected = selectEvidence(ranked);
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map(row => row.id), ['S1', 'S2']);
  assert.equal(selectEvidence(ranked, { budget: 1 }).length, 0);
});
test('knowledge status distinguishes unavailable, partial, and stale repository analysis', () => {
  const missing = knowledgeMessages([{ config: { analysis: { status: 'failed' } } }], [], [{ status: 'failed' }]);
  assert.match(missing.join(' '), /no usable repository analysis/);
  assert.match(missing.join(' '), /not indexed/);
  const messages = knowledgeMessages([{ config: { analysis: { currentSnapshotId: 's', staleAt: 'yesterday' } } }], [{ _id: 's', fullName: 'team/repo', commitSha: 'abcdefg123', status: 'partial', analyzedAt: new Date('2026-10-13T00:00:00Z'), coverage: { analyzed: 2, eligible: 5, tooLarge: 3 } }], []);
  assert.match(messages.join(' '), /abcdefg/);
  assert.match(messages.join(' '), /3 too large/);
  assert.match(messages.join(' '), /last published snapshot/);
});

const snapshot = {
  _id: 'snapshot', fullName: 'team/scout', commitSha: 'a'.repeat(40),
  knowledge: {
    overview: { purposeFromReadme: 'Scout helps teams find available meeting rooms.', languages: [{ language: 'JavaScript', files: 12 }], frameworks: ['React', 'Express'] },
    dependencies: [{ file: 'Frontend/package.json', top: ['react', 'vite'] }],
  },
};
test('generic technology question retrieves analyzed stack and manifest without naming a framework', () => {
  const rows = rankChunks(repositoryEvidence(snapshot), 'what technologies were used to build the project');
  assert.ok(rows.some(row => row.kind === 'stack' && row.text.includes('React')));
  assert.ok(rows.some(row => row.kind === 'manifest' && row.text.includes('vite')));
  assert.ok(rows.every(row => row.url.includes(snapshot.commitSha)));
});
test('overview question prioritizes repository purpose above a shallow project description', () => {
  const rows = rankChunks([{ key: 'project:1', title: 'Project overview', text: 'Scout refining the project' }, ...repositoryEvidence(snapshot)], 'what is this project about tell me in brief');
  assert.equal(rows[0].kind, 'overview');
  assert.match(rows[0].text, /meeting rooms/);
});
test('local run question retrieves build and run commands from analyzed snapshot', () => {
  const snapWithSetup = {
    ...snapshot,
    knowledge: {
      ...snapshot.knowledge,
      buildAndTest: [{ name: 'dev', command: 'vite', file: 'Frontend/package.json' }],
      entryPoints: ['Backend/index.js'],
      envVariables: [{ name: 'PORT' }],
    },
  };
  const rows = rankChunks(repositoryEvidence(snapWithSetup), 'how do I run this project locally');
  assert.ok(rows.some(row => row.kind === 'setup' && row.text.includes('vite')));
  assert.ok(rows.some(row => row.kind === 'setup' && row.text.includes('PORT')));
});
test('raw manifest and README are retrieved even without overlapping question words', () => {
  const rows = [{ key: 'file:1', title: 'Frontend/package.json', kind: repositoryFileKind('Frontend/package.json'), text: '{"react":"19"}' }, { key: 'file:2', title: 'README.md', kind: repositoryFileKind('README.md'), text: 'Scout locates rooms.' }];
  assert.equal(rankChunks(rows, 'What is the technology stack?')[0].key, 'file:1');
  assert.equal(rankChunks(rows, 'Summarize this repository')[0].key, 'file:2');
});
test('normalizes word forms and preserves specific lexical retrieval without unrelated fallback', () => {
  assert.deepEqual([...chatTerms('technologies frameworks dependencies built')], ['technology', 'framework', 'dependency', 'build']);
  assert.equal(questionIntent('What did we decide about payments?'), null);
  assert.equal(rankChunks(repositoryEvidence(snapshot), 'zebras migration rollback').length, 0);
  assert.equal(rankChunks([{ key: 'file:1', title: 'retry.js', text: 'retry queue' }], 'queue retry')[0].key, 'file:1');
});
test('follow-up question inherits intent and context from previous user turn', () => {
  const snapWithSetup = {
    ...snapshot,
    knowledge: {
      ...snapshot.knowledge,
      buildAndTest: [{ name: 'dev', command: 'vite', file: 'Frontend/package.json' }],
      entryPoints: ['Backend/index.js'],
      envVariables: [{ name: 'PORT' }],
    },
  };
  const history = [{ question: 'how do I run this project locally' }];
  const rows = rankChunks(repositoryEvidence(snapWithSetup), 'what port does it listen on?', history);
  assert.ok(rows.length > 0);
  assert.equal(rows[0].kind, 'setup');
  assert.ok(rows[0].text.includes('PORT'));
});
test('route question retrieves API endpoints and schema question retrieves models', () => {
  const snapWithRoutes = {
    ...snapshot,
    knowledge: {
      ...snapshot.knowledge,
      routes: [{ method: 'POST', path: '/api/auth/login', file: 'Backend/routes/auth.js', line: 12 }],
      models: [{ name: 'User', kind: 'mongoose', file: 'Backend/models/User.js', line: 5 }],
      importGraph: [{ file: 'Backend/index.js', imports: ['Backend/routes/auth.js'] }],
    },
  };
  const routeRows = rankChunks(repositoryEvidence(snapWithRoutes), 'what are the api routes and login endpoints?');
  assert.ok(routeRows.length > 0);
  assert.equal(routeRows[0].kind, 'route');
  assert.ok(routeRows[0].text.includes('/api/auth/login'));

  const modelRows = rankChunks(repositoryEvidence(snapWithRoutes), 'what database models exist?');
  assert.ok(modelRows.length > 0);
  assert.equal(modelRows[0].kind, 'schema');
  assert.ok(modelRows[0].text.includes('User'));
});

