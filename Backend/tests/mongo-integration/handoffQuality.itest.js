/**
 * Engineering-handoff quality: the evidence rules end to end. Real app + disposable MongoDB; GitHub and the AIML service are
 * mocked. The "bad model" below reproduces what the earlier SNS-PROJECT handoff said (project complete, code runs, no risks,
 * facts backed only by commits) so we can prove none of it survives, and that the report is still useful.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { startMongo, stopMongo, resetCollections } from './harness.js';

await startMongo();
const { app } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { resetGitHubAppAuth } = await import('../../src/services/githubRepositoryService.js');
const { resetSyncAuth } = await import('../../src/services/githubSyncEngine.js');
const { User, Project, ProjectMembership, GitHubInstallation, SourceConnection, SourceRecord } = await import('../../src/models/index.js');
const { extractPdfText } = await import('../../src/modules/ingestion/documents/documentExtraction.js');
after(async () => { await stopMongo(); });

const realFetch = globalThis.fetch;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const J = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const sha = (s) => createHash('sha1').update(s).digest('hex');

const MAIN_PY = `import numpy as np
import matplotlib.pyplot as plt
from scipy.signal import butter, filtfilt

def message(t, fm=5):
    return np.sin(2 * np.pi * fm * t)

def am_modulate(t, fc=100, ka=0.5):
    return (1 + ka * message(t)) * np.cos(2 * np.pi * fc * t)

def fm_modulate(t, fc=100, kf=20):
    return np.cos(2 * np.pi * fc * t + kf * np.cumsum(message(t)) / len(t))

def am_demodulate(signal, fs=1000):
    b, a = butter(4, 20 / (fs / 2))
    return filtfilt(b, a, np.abs(signal))

if __name__ == "__main__":
    t = np.linspace(0, 1, 1000)
    plt.plot(t, am_demodulate(am_modulate(t)))
    plt.show()
`;
const SMALL = () => ({ 'main.py': MAIN_PY, 'README.md': '# SNS PROJECT\n', 'requirements.txt': 'numpy\nmatplotlib\nscipy\n' });
const LARGE = () => {
  const files = { 'README.md': '# Platform\n\nA multi-service platform.\n\n## Setup\nRun `npm install` then `npm start`.', 'package.json': JSON.stringify({ name: 'platform', main: 'src/server.js', scripts: { start: 'node src/server.js', test: 'node --test' }, dependencies: { express: '^5', mongoose: '^8' } }), 'src/server.js': "import a from './mod0/routes.js'\napp.use(a)\n" };
  for (let m = 0; m < 10; m += 1) {
    files[`src/mod${m}/routes.js`] = `router.get('/api/mod${m}', handle)\nexport function handle() {}\n`;
    files[`src/mod${m}/service.js`] = `export function service${m}() { return ${m} }\n`;
    files[`src/mod${m}/model.js`] = `export const M${m} = mongoose.model('M${m}', schema)\n`;
    for (let k = 0; k < 5; k += 1) files[`src/mod${m}/helper${k}.js`] = `export function help${m}${k}() {}\n`;
  }
  return files;
};

describe('engineering handoff quality', () => {
  let server, base, alice, project, connection, gh, ai, sent, files;
  const tok = (u) => `Bearer ${signAuthToken(u)}`;
  const call = async (method, path, u, body) => {
    const res = await realFetch(`${base}${path}`, { method, headers: { ...(u ? { Authorization: tok(u) } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
    return { status: res.status, body: json, buf };
  };
  const P = () => `/api/projects/${project._id}`;
  const analyze = () => call('POST', `${P()}/integrations/github/${connection._id}/analyze`, alice);
  const generate = (force = true) => call('POST', `${P()}/handoff-reports`, alice, force ? { force: true } : undefined);
  const setRepo = async (name, repoFiles) => { files = repoFiles; await SourceConnection.updateOne({ _id: connection._id }, { 'config.fullName': name, 'config.repo': name.split('/')[1], 'config.htmlUrl': `https://github.com/${name}` }); };

  /** What the earlier SNS-PROJECT handoff claimed, plus the genuinely useful content a good model would add. */
  const badModel = (pack) => {
    const id = (s) => pack.sources.find((x) => x.id.endsWith(s))?.id;
    const commit = pack.sources.find((x) => x.record_type === 'commit')?.id;
    return J({
      case_id: pack.case_id,
      summary: 'A Python script that amplitude- and frequency-modulates a tone and recovers it with a low-pass filter. No open issues or pull requests are pending; the project is complete.',
      current_state: [
        { text: 'No open issues or pull requests are pending; the project is complete.', kind: 'fact', source_ids: [commit].filter(Boolean) },
        { text: 'All dependencies are listed in requirements.txt and the script runs with Python 3.', kind: 'fact', source_ids: [id(':requirements.txt')] },
        { text: 'main.py defines message, am_modulate, fm_modulate and am_demodulate and has a __main__ block that plots the demodulated signal.', kind: 'fact', source_ids: [id(':main.py')] },
      ],
      how_it_works: [
        { text: 'The code compiles and runs as per the README.', kind: 'fact', source_ids: [id(':README.md')] },
        { text: 'am_modulate multiplies a carrier by 1 + ka*message(t); am_demodulate takes the envelope with np.abs and smooths it with a 4th-order Butterworth low-pass via filtfilt.', kind: 'fact', source_ids: [id(':main.py')] },
      ],
      implementation_paths: [{ title: 'AM round trip', flow: 'The __main__ block builds a 1000-sample time axis, calls am_modulate, passes the result to am_demodulate and plots the recovered message.', files: ['main.py'], symbols: ['am_modulate', 'am_demodulate', 'phantom_filter'], kind: 'fact', source_ids: [id(':main.py')] }],
      risks: [{ text: 'No blockers or risks are identified; the code compiles and runs.', kind: 'inference', source_ids: [id(':main.py')] }, { text: 'The 20 Hz cutoff and 1000 Hz sample rate are hard-coded, so other carrier or message frequencies may be distorted.', kind: 'inference', source_ids: [id(':main.py')] }],
      unknowns: [], blockers: [],
      recommendations: [
        { action: 'Run main.py to verify the plots and consider adding unit tests', why: 'It is the sensible next step.', priority: 'P1', basis: 'confirmed', done_when: 'it is done', files: ['main.py'], source_ids: [id(':main.py')] },
        { action: 'Parameterize the cutoff and sample rate in am_demodulate', why: 'They are hard-coded in main.py, which limits reuse for other signals.', priority: 'P2', basis: 'suggested', done_when: 'am_demodulate accepts cutoff and fs arguments and the demo plot is unchanged', files: ['main.py'], source_ids: [id(':main.py')] },
      ],
      start_here: [{ file: 'main.py', reason: 'It holds all of the logic.', source_ids: [id(':main.py')] }, { file: 'src/ghost.py', reason: 'x', source_ids: [] }],
    });
  };

  before(async () => {
    Object.assign(config.githubApp, { appId: '5283491', privateKey, appSlug: 'x', clientId: 'c', clientSecret: 's', enabled: true });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.includes('api.github.com')) return gh(new URL(u));
      if (u.includes(':8001')) { sent = JSON.parse(init.body); return ai(sent); }
      return realFetch(url, init);
    };
  });
  after(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); });
  beforeEach(async () => {
    await resetCollections(); resetGitHubAppAuth(); resetSyncAuth(); sent = null; files = SMALL(); ai = badModel;
    alice = await User.create({ email: 'a@example.com', name: 'Alice' });
    await GitHubInstallation.create({ userId: alice._id, installationId: 777, accountLogin: 'acme', accountType: 'Organization', connectedAt: new Date() });
    project = await Project.create({ name: 'SNS PROJECT', description: 'AM/FM demo', ownerId: alice._id, createdBy: alice._id });
    await ProjectMembership.create({ projectId: project._id, userId: alice._id, role: 'owner', invitedBy: alice._id });
    connection = await SourceConnection.create({ projectId: project._id, provider: 'github', connectedBy: alice._id, config: { sync: { status: 'completed', lastSuccessAt: new Date() }, installationId: 777, repositoryId: 101, owner: 'acme', repo: 'am-fm', fullName: 'acme/am-fm', htmlUrl: 'https://github.com/acme/am-fm', isPrivate: true } });
    await SourceRecord.create({ projectId: project._id, provider: 'github', externalId: 'C1', type: 'commit', title: 'Add files via upload', url: 'https://github.com/acme/am-fm/commit/8607ab2', content: '', metadata: { author: 'pallav', sourceCreatedAt: new Date('2025-10-16'), providerMetadata: { sha: '8607ab2afcfc0be132913f9cb2c7e81dc45d7ce6', repositoryFullName: 'acme/am-fm', repositoryId: 101 } } });
    gh = (u) => {
      if (u.pathname.endsWith('/access_tokens')) return J({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
      if (/^\/repos\/acme\/[\w-]+$/.test(u.pathname)) return J({ id: 101, full_name: 'acme/am-fm', default_branch: 'main', description: 'AM FM demo', private: true });
      if (u.pathname.endsWith('/branches/main')) return J({ commit: { sha: 'b'.repeat(40), commit: { tree: { sha: 'tree1' } } } });
      if (u.pathname.includes('/git/trees/')) return J({ tree: Object.entries(files).map(([path, t]) => ({ path, type: 'blob', sha: sha(t), size: t.length })), truncated: false });
      const m = u.pathname.match(/\/git\/blobs\/(.+)$/);
      if (m) { const e = Object.entries(files).find(([, t]) => sha(t) === m[1]); return J({ encoding: 'base64', content: Buffer.from(e[1]).toString('base64') }); }
      return J({ message: 'nf' }, 404);
    };
  });

  describe('small script repository with an empty tracker (the SNS-PROJECT case)', () => {
    it('never says the project is complete or that the code runs, and explains why in verification status', async () => {
      await analyze();
      const r = (await generate()).body.report;
      const all = JSON.stringify([r.brief, r.sections, r.summary]);
      assert.doesNotMatch(all, /project is complete|code compiles|runs as per|runs with Python 3|No blockers or risks/i);
      assert.doesNotMatch(r.summary, /complete/i); assert.match(r.summary, /amplitude- and frequency-modulates/);
      assert.equal(r.verification.completion.status, 'not_established');
      assert.match(r.verification.workTracking.detail, /No open issues, pull requests.*were found.*does not show that the work is complete/);
      assert.match(r.verification.requirements.detail, /completion against requirements cannot be assessed/);
      assert.match(r.verification.tests.executed.detail, /No test results are available.*No test files or test scripts were found/);
      assert.equal(r.verification.runtime.status, 'not_verified');
      const note = r.limitations.filter((l) => /^Automated validation corrected the AI output/.test(l));
      assert.equal(note.length, 1, 'one compact line instead of one alarming line per rule');
      assert.match(note[0], /completion\/execution claim\(s\) no evidence supports/); assert.match(note[0], /reference\(s\) to files not in the analyzed commit/); assert.match(note[0], /unverifiable function\/class name/);
    });

    it('sends the model the whole script and its real symbols, so it can explain the code instead of listing files', async () => {
      await analyze(); await generate();
      assert.match(sent.case_description, /\[Complexity\] small/);
      assert.match(sent.case_description, /Tests executed: none/); assert.match(sent.case_description, /0 PRs, 0 issues, 0 tasks \(an empty tracker does not mean the work is complete\)/);
      const main = sent.sources.find((s) => s.id === 'file:101:main.py');
      assert.ok(main.content.includes('filtfilt(b, a, np.abs(signal))'), 'the full algorithm is in the evidence, not a 900-character excerpt');
      const sym = sent.sources.find((s) => s.id === 'repo:101:symbols').content;
      assert.match(sym, /main\.py: def message\(t, fm=5\) L5; def am_modulate\(t, fc=100, ka=0\.5\) L8;/);
      assert.match(sym, /if __name__ == "__main__" entry block/);
      assert.match(sym, /textual call sites: am_modulate -> message L9/);
      assert.ok(!sent.sources.some((s) => s.id === 'repo:101:components'), 'no component map for a one-file script');
    });

    it('produces a focused, verified brief: facts, inference, unknowns and actionable prioritized steps', async () => {
      await analyze();
      const r = (await generate()).body.report;
      assert.equal(r.complexity, 'small');
      assert.deepEqual(r.brief.currentState.map((c) => c.kind), ['fact']);
      assert.match(r.brief.currentState[0].text, /main\.py defines message, am_modulate/);
      // symbols are verified against the analyzed source: the invented one is gone
      const path = r.sections.find((s) => s.key === 'walkthrough').items.find((i) => i.type === 'subsystem');
      assert.deepEqual(path.symbols, ['am_modulate', 'am_demodulate']); assert.deepEqual(path.files, ['main.py']);
      // the generic recommendation (no why, no completion criterion) is gone; the specific one stays, as suggested P2
      assert.deepEqual(r.brief.doFirst.map((x) => [x.priority, x.basis]), [['P2', 'suggested']]);
      assert.match(r.brief.doFirst[0].doneWhen, /accepts cutoff and fs arguments/);
      assert.ok(!JSON.stringify(r).includes('Run main.py to verify'));
      // inferred risk is labelled as such, not as a defect; hard-coded values are explained
      const risk = r.sections.find((s) => s.key === 'blockers_risks').items;
      assert.ok(risk.length === 1 && risk[0].kind === 'inference' && risk[0].label === 'inferred risk' && /hard-coded/.test(risk[0].text));
      // what was not established is stated as unknown
      assert.ok(r.sections.find((s) => s.key === 'unknowns').items.some((a) => a.kind === 'unknown' && /No setup, build or run instructions/.test(a.text)));
      assert.match(r.brief.findings.text, /1 inferred risk, 1 unknown/);
      // fake start-here file is dropped; real one kept, and the onboarding sequence reads only real files
      const reads = r.sections.find((s) => s.key === 'first_30').items.flatMap((i) => i.reads.map((x) => x.file));
      assert.ok(reads.length > 0 && reads.every((f) => f === 'main.py'), JSON.stringify(reads));
      // no generic filler sections, nothing repeated
      assert.deepEqual(r.sections.map((s) => s.key).filter((k) => ['important_files', 'links', 'coverage', 'executive_summary', 'architecture', 'modules'].includes(k)), []);
      const texts = [...r.brief.currentState, ...r.brief.doFirst, ...r.sections.flatMap((s) => s.items)].map((i) => i.text);
      assert.equal(new Set(texts).size, texts.length, 'no statement appears twice');
    });

    it('a small repository yields a short report and a one-or-two page PDF with page one carrying the brief', async () => {
      await analyze();
      const r = (await generate()).body.report;
      const pdf = await call('GET', `${P()}/handoff-reports/${r.id}/pdf`, alice);
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf.buf), isEvalSupported: false }).promise;
      assert.ok(doc.numPages <= 2, `${doc.numPages} pages`);
      const first = (await (await doc.getPage(1)).getTextContent()).items.map((t) => t.str).join(' ').replace(/\s+/g, ' ');
      for (const must of ['am_modulate', 'Do first'.toUpperCase().replace(/ /g, ''), 'none executed by Relay', 'completion not established']) assert.ok(first.replace(/\s/g, '').includes(must.replace(/\s/g, '')), `page 1 lacks ${must}`);
      const { text } = await extractPdfText(pdf.buf, { maxTextLength: 1e6, maxPages: 20 });
      assert.ok(!/project is complete/i.test(text));
    });
  });

  describe('tests that exist but were never run', () => {
    it('lists discovered tests, says none were executed, and removes "tests pass" / "no tests" statements', async () => {
      files = { ...SMALL(), 'requirements.txt': 'numpy\npytest\n', 'tests/test_main.py': 'from main import am_modulate\n\ndef test_am():\n    assert am_modulate\n' };
      await analyze();
      ai = (pack) => J({ case_id: pack.case_id, summary: 'A modulation demo with a pytest suite.', current_state: [{ text: 'All tests pass and the suite is green.', kind: 'fact', source_ids: ['file:101:tests/test_main.py'] }],
        risks: [{ text: 'The repository lacks any automated tests.', kind: 'inference', source_ids: ['file:101:main.py'] }], how_it_works: [{ text: 'tests/test_main.py imports am_modulate from main.py and asserts that it exists.', kind: 'fact', source_ids: ['file:101:tests/test_main.py'] }], recommendations: [] });
      const r = (await generate()).body.report;
      assert.equal(r.verification.tests.discovered.fileCount, 1); assert.deepEqual(r.verification.tests.discovered.files, ['tests/test_main.py']);
      assert.match(r.verification.tests.executed.detail, /1 test file\(s\) were found but not executed/);
      assert.match(sent.case_description, /Tests discovered: 1 file\(s\) \(pytest\)/);
      const flat = JSON.stringify([r.brief, r.sections]);
      assert.doesNotMatch(flat, /tests pass|suite is green|lacks any automated tests/);
      assert.match(flat, /imports am_modulate/);
      assert.ok(r.limitations.some((l) => /statement\(s\) contradicting verified data/.test(l)));
    });
  });

  describe('large repository', () => {
    it('gets architecture depth: component map, routes, models, more sections and higher list caps', async () => {
      files = LARGE();
      await analyze();
      ai = (pack) => {
        const id = (s) => pack.sources.find((x) => x.id.endsWith(s))?.id;
        const topics = ['routing', 'persistence', 'validation', 'billing', 'scheduling', 'caching', 'auditing', 'search', 'exports', 'webhooks', 'sessions', 'throttling', 'metrics', 'migrations'];
        const claims = topics.map((t, i) => ({ text: `Module mod${i % 10} exposes ${t}Handler${i} and keeps ${t} state in ${t}_store_${i}.`, kind: 'fact', source_ids: [id(':src/server.js')] }));
        return J({ case_id: pack.case_id, summary: 'A multi-module Express platform.', how_it_works: claims, current_state: [], recommendations: [], implementation_paths: [{ title: 'Module request path', flow: 'src/server.js mounts the module routers, each module exposes handle() through routes.js.', files: ['src/server.js', 'src/mod0/routes.js'], symbols: ['handle'], kind: 'fact', source_ids: [id(':src/server.js')] }] });
      };
      const r = (await generate()).body.report;
      assert.equal(r.complexity, 'large');
      assert.match(sent.case_description, /\[Complexity\] large/);
      const ids = sent.sources.map((s) => s.id);
      for (const must of ['repo:101:components', 'repo:101:routes', 'repo:101:models', 'repo:101:symbols']) assert.ok(ids.includes(must), must);
      assert.ok(!ids.includes('file:101:src/mod9/helper4.js'), 'a large repository is summarized, not dumped');
      const walk = r.sections.find((s) => s.key === 'walkthrough').items;
      assert.ok(walk.filter((i) => i.type === 'overview').length >= 5, 'large repositories get an architecture overview');
      assert.deepEqual(walk.find((i) => i.type === 'subsystem').symbols, ['handle']);
    });
  });
});
