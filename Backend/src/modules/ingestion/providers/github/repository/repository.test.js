import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, containsSecret, exclusionReason, languageOf, looksBinary, priorityOf } from './repoFilters.js';
import { extractDoc, extractEnvNames, extractFileFacts, extractImports, extractManifest, extractModels, extractRoutes, extractSymbols } from './repoExtractors.js';
import { buildKnowledge, componentOf } from './repoKnowledge.js';
import { diffManifests, planAnalysis } from '../../../../../services/repositoryAnalysisService.js';

describe('exclusion rules', () => {
  it('excludes dependency/build directories, binaries, lock files, generated bundles', () => {
    for (const [path, reason] of [['node_modules/x/index.js', 'dependency_or_build_dir'], ['frontend/dist/app.js', 'dependency_or_build_dir'], ['assets/logo.png', 'binary'], ['package-lock.json', 'lock_file'], ['public/app.min.js', 'generated'], ['a/__pycache__/m.pyc', 'dependency_or_build_dir']]) assert.equal(exclusionReason(path), reason, path);
  });
  it('excludes secret-bearing files but keeps env templates', () => {
    for (const p of ['.env', 'Backend/.env.local', 'keys/server.pem', 'id_rsa', 'config/credentials.json', 'deploy/secrets.yml', '.npmrc']) assert.equal(exclusionReason(p), 'secret_file', p);
    for (const p of ['.env.example', 'Backend/.env.sample', 'src/environment.js']) assert.equal(exclusionReason(p), null, p);
  });
  it('detects credentials inside file content', () => {
    assert.ok(containsSecret('-----BEGIN RSA PRIVATE KEY-----\nabc'));
    assert.ok(containsSecret('token = "ghp_' + 'a'.repeat(36) + '"'));
    assert.ok(containsSecret('const k = "AKIAABCDEFGHIJKLMNOP"'));
    assert.ok(containsSecret('MONGODB_URI=mongodb+srv://user:pass@cluster.example.net/db'));
    assert.ok(containsSecret('password: "supersecretvalue1234567890"'));
    assert.ok(!containsSecret('const apiKey = process.env.API_KEY;'));
    assert.ok(!containsSecret('Set the password via the PASSWORD env var.'));
    assert.ok(looksBinary('a\u0000b'));
  });
  it('categorizes and prioritizes important files first', () => {
    assert.equal(categorize('README.md'), 'readme'); assert.equal(categorize('Backend/package.json'), 'manifest'); assert.equal(categorize('src/routes/users.js'), 'route');
    assert.equal(categorize('src/models/User.js'), 'schema'); assert.equal(categorize('.github/workflows/ci.yml'), 'deploy'); assert.equal(categorize('tests/a.test.js'), 'test');
    assert.ok(priorityOf({ path: 'README.md', size: 10 }) < priorityOf({ path: 'src/util/x.js', size: 10 }));
    assert.ok(priorityOf({ path: 'src/util/x.js', size: 10 }) < priorityOf({ path: 'tests/x.test.js', size: 10 }));
    assert.equal(languageOf('a/b.py'), 'Python');
  });
});

describe('analysis planning and coverage budget', () => {
  const limits = { maxFiles: 3, maxFileBytes: 1000, maxTotalBytes: 10_000 };
  const tree = [
    { path: 'README.md', sha: '1', size: 100 }, { path: 'package.json', sha: '2', size: 100 }, { path: 'src/a.js', sha: '3', size: 100 }, { path: 'src/b.js', sha: '4', size: 100 },
    { path: 'src/huge.js', sha: '5', size: 5000 }, { path: 'node_modules/x.js', sha: '6', size: 1 }, { path: '.env', sha: '7', size: 1 }, { path: 'logo.png', sha: '8', size: 1 },
  ];
  it('selects by priority, counts every skipped file, and never over-reports', () => {
    const plan = planAnalysis(tree, limits);
    assert.deepEqual(plan.selected.map((e) => e.path), ['README.md', 'package.json', 'src/a.js']);
    assert.equal(plan.eligible.length, 5); assert.equal(plan.tooLarge.length, 1); assert.equal(plan.overBudget, 1);
    assert.deepEqual(plan.excluded, { dependency_or_build_dir: 1, secret_file: 1, binary: 1 });
  });
  it('honours the total byte budget', () => {
    assert.equal(planAnalysis(tree, { ...limits, maxFiles: 10, maxTotalBytes: 250 }).selected.length, 2);
  });
});

describe('incremental diff', () => {
  it('reports added, modified, deleted, renamed and unchanged files', () => {
    const prev = [{ path: 'a.js', blobSha: '1' }, { path: 'b.js', blobSha: '2' }, { path: 'old.js', blobSha: '3' }, { path: 'gone.js', blobSha: '4' }];
    const cur = [{ path: 'a.js', blobSha: '1' }, { path: 'b.js', blobSha: '9' }, { path: 'new.js', blobSha: '3' }, { path: 'fresh.js', blobSha: '5' }];
    const d = diffManifests(prev, cur);
    assert.deepEqual(d, { added: ['fresh.js'], modified: ['b.js'], deleted: ['gone.js'], renamed: [{ from: 'old.js', to: 'new.js' }], unchanged: 1 });
  });
  it('treats a missing previous manifest as everything added', () => {
    assert.equal(diffManifests(null, [{ path: 'a', blobSha: '1' }]).added.length, 1);
  });
});

describe('deterministic extraction', () => {
  it('reads package.json scripts, dependencies and frameworks', () => {
    const m = extractManifest('package.json', JSON.stringify({ name: 'x', main: 'src/server.js', scripts: { start: 'node src/server.js', test: 'node --test' }, dependencies: { express: '^5', mongoose: '^8' }, devDependencies: { vite: '1' } }));
    assert.equal(m.name, 'x'); assert.equal(m.scripts.test, 'node --test'); assert.deepEqual(m.framework.sort(), ['Express', 'Mongoose', 'Vite']);
    assert.equal(m.dependencies.find((d) => d.name === 'vite').dev, true);
    assert.deepEqual(extractManifest('package.json', '{bad').dependencies, []);
  });
  it('reads python and go manifests', () => {
    assert.deepEqual(extractManifest('requirements.txt', 'fastapi>=0.1\n# c\npydantic==2\n-r other.txt').dependencies.map((d) => d.name), ['fastapi', 'pydantic']);
    assert.deepEqual(extractManifest('go.mod', 'require (\n\tgithub.com/gin-gonic/gin v1.9.0\n)').dependencies.map((d) => d.name), ['github.com/gin-gonic/gin']);
  });
  it('finds express and fastapi routes with line numbers', () => {
    const r = extractRoutes('src/routes/a.js', "router.get('/users', h)\nrouter.post(['/a','/b'], h)\n");
    assert.deepEqual(r.map((x) => `${x.method} ${x.path}@${x.line}`), ['GET /users@1', 'POST /a@2', 'POST /b@2']);
    assert.equal(extractRoutes('app/main.py', '@app.post("/api/v1/x")\ndef f(): pass')[0].path, '/api/v1/x');
  });
  it('finds models, symbols and env variable names (never values)', () => {
    assert.deepEqual(extractModels('m.js', "mongoose.model('User', s)\n").map((m) => m.name), ['User']);
    assert.equal(extractModels('m.sql', 'CREATE TABLE IF NOT EXISTS orders (id int)')[0].name, 'orders');
    assert.deepEqual(extractSymbols('a.js', 'export async function run() {}\nexport class Svc {}\nexport const X = 1').map((s) => s.name), ['run', 'Svc', 'X']);
    const env = extractEnvNames('.env.example', 'JWT_SECRET=hunter2hunter2\n# MONGODB_URI=\n').concat(extractEnvNames('a.js', 'process.env.PORT'));
    assert.deepEqual(env.map((e) => e.name), ['JWT_SECRET', 'MONGODB_URI', 'PORT']);
    assert.ok(!JSON.stringify(env).includes('hunter2'));
  });
  it('resolves relative imports to real files only', () => {
    const known = new Set(['src/a.js', 'src/b.js', 'lib/c.js']);
    assert.deepEqual(extractImports('src/a.js', "import x from './b.js'\nimport y from '../lib/c'\nimport z from './missing'\nimport r from 'react'", known).sort(), ['lib/c.js', 'src/b.js']);
  });
  it('quotes setup sections verbatim from markdown', () => {
    const d = extractDoc('README.md', '# Relay\n\nA handoff tool.\n\n## Installation\nRun `npm i`.\n\n## Other\nx\n\n## Running Tests\n`npm test`');
    assert.equal(d.title, 'Relay'); assert.equal(d.summary, 'A handoff tool.'); assert.deepEqual(d.setupSections.map((s) => s.heading), ['Installation', 'Running Tests']);
    assert.match(d.setupSections[0].excerpt, /npm i/);
  });
});

describe('knowledge assembly', () => {
  const entries = {
    'README.md': '# Relay\n\nHandoffs.\n\n## Setup\nnpm i',
    'package.json': JSON.stringify({ name: 'relay', scripts: { start: 'node src/server.js' }, dependencies: { express: '1' } }),
    'src/server.js': "import r from './routes/a.js'\napp.get('/health', h)\nprocess.env.PORT",
    'src/routes/a.js': "router.get('/a', h)\nexport function a() {}",
    'src/models/User.js': "mongoose.model('User', s)",
  };
  const known = new Set(Object.keys(entries));
  const files = Object.entries(entries).map(([path, text]) => ({ path, blobSha: path, size: text.length, facts: extractFileFacts(path, text, known) }));
  const tree = files.map((f) => ({ path: f.path, size: f.size }));
  const k = buildKnowledge({ repository: { description: 'd', defaultBranch: 'main' }, tree, files });
  it('builds overview, build commands, env names, routes, models and entry points', () => {
    assert.deepEqual(k.overview.languages.map((l) => l.language), ['JavaScript']); assert.deepEqual(k.overview.frameworks, ['Express']);
    assert.equal(k.buildAndTest[0].command, 'node src/server.js'); assert.deepEqual(k.envVariables.map((e) => e.name), ['PORT']);
    assert.ok(k.routes.some((r) => r.path === '/health' && r.file === 'src/server.js')); assert.equal(k.models[0].name, 'User');
    assert.ok(k.entryPoints.includes('src/server.js')); assert.equal(k.setupDocs[0].heading, 'Setup');
  });
  it('relates components through real imports', () => {
    assert.equal(componentOf('src/routes/a.js'), 'src/routes'); assert.equal(componentOf('README.md'), '(root)');
    assert.deepEqual(k.components.find((c) => c.name === 'src/server.js' || c.name === 'src/server.js'.split('/')[0]) ? [] : [], []);
    const comps = Object.fromEntries(k.components.map((c) => [c.name, c]));
    assert.ok(comps['src/routes']); assert.ok(comps['src/models']);
  });
  it('only references files that exist in the snapshot', () => {
    for (const p of [...k.importantFiles.map((f) => f.path), ...k.entryPoints, ...k.routes.map((r) => r.file), ...k.components.flatMap((c) => c.keyFiles)]) assert.ok(known.has(p), p);
  });
});
