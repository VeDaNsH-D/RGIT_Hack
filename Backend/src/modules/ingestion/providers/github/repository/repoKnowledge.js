import { languageOf } from './repoFilters.js';

/**
 * Builds the structured knowledge document from per-file facts. Pure and deterministic: every list entry
 * references a real stored file, so nothing here can name a path that does not exist in the snapshot.
 */

const WRAPPER_DIRS = new Set(['src', 'app', 'apps', 'lib', 'packages', 'server', 'backend', 'frontend', 'services']);

export function componentOf(path) {
  const parts = path.split('/');
  if (parts.length === 1) return '(root)';
  if (WRAPPER_DIRS.has(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

/**
 * @param {Object} input
 * @param {Array<{path,size,type}>} input.tree           every blob in the repository tree (for language/structure stats)
 * @param {Array<{path,blobSha,size,facts}>} input.files analyzed files with their extracted facts
 */
export function buildKnowledge({ repository, tree, files, readmeText }) {
  const langCount = new Map();
  const dirCount = new Map();
  for (const entry of tree) {
    const lang = languageOf(entry.path);
    if (lang && lang !== 'Markdown') langCount.set(lang, (langCount.get(lang) || 0) + 1);
    const dir = entry.path.includes('/') ? entry.path.split('/')[0] : '(root)';
    dirCount.set(dir, (dirCount.get(dir) || 0) + 1);
  }

  const manifests = files.filter((f) => f.facts.manifest);
  const frameworks = [...new Set(manifests.flatMap((f) => f.facts.manifest.framework))];
  const dependencies = manifests.map((f) => ({ file: f.path, name: f.facts.manifest.name, count: f.facts.manifest.dependencies.length, top: f.facts.manifest.dependencies.filter((d) => !d.dev).slice(0, 15).map((d) => d.name) }));
  const buildAndTest = [];
  for (const f of manifests) for (const [name, command] of Object.entries(f.facts.manifest.scripts)) if (/^(start|dev|build|test|lint|serve|seed|migrate)/.test(name)) buildAndTest.push({ name, command, file: f.path });
  const docs = files.filter((f) => f.facts.doc).map((f) => ({ path: f.path, title: f.facts.doc.title, summary: f.facts.doc.summary, headings: f.facts.doc.headings.slice(0, 12) }));
  const setupDocs = files.filter((f) => f.facts.doc?.setupSections.length).flatMap((f) => f.facts.doc.setupSections.map((s) => ({ file: f.path, heading: s.heading, excerpt: s.excerpt }))).slice(0, 8);
  const envVariables = [...new Map(files.flatMap((f) => f.facts.env || []).map((e) => [e.name, e])).values()].slice(0, 80);
  const routes = files.flatMap((f) => f.facts.routes || []).slice(0, 150);
  const models = files.flatMap((f) => f.facts.models || []).slice(0, 80);
  const entryPoints = [...new Set([
    ...manifests.filter((f) => f.facts.manifest.entry).map((f) => `${f.path.split('/').slice(0, -1).concat(f.facts.manifest.entry).join('/')}`),
    ...files.filter((f) => f.facts.category === 'entrypoint').map((f) => f.path),
  ])].slice(0, 15);

  const known = new Set(files.map((f) => f.path));
  const comps = new Map();
  for (const f of files) {
    const key = componentOf(f.path);
    const c = comps.get(key) || { name: key, files: [], languages: new Map(), routes: 0, models: [], symbols: [], dependsOn: new Set() };
    c.files.push(f);
    if (f.facts.language) c.languages.set(f.facts.language, (c.languages.get(f.facts.language) || 0) + 1);
    c.routes += (f.facts.routes || []).length;
    c.models.push(...(f.facts.models || []).map((m) => m.name));
    c.symbols.push(...(f.facts.symbols || []).slice(0, 3).map((s) => ({ name: s.name, kind: s.kind, file: s.file, line: s.line })));
    for (const imp of f.facts.imports || []) if (known.has(imp) && componentOf(imp) !== key) c.dependsOn.add(componentOf(imp));
    comps.set(key, c);
  }
  const rank = { readme: 0, entrypoint: 1, manifest: 2, route: 3, schema: 3, doc: 4, source: 5, config: 6, deploy: 6, test: 8, other: 9 };
  const components = [...comps.values()].sort((a, b) => b.files.length - a.files.length).slice(0, 25).map((c) => ({
    name: c.name,
    fileCount: c.files.length,
    languages: top(c.languages, 3).map(([l]) => l),
    keyFiles: c.files.slice().sort((a, b) => (rank[a.facts.category] ?? 9) - (rank[b.facts.category] ?? 9)).slice(0, 5).map((f) => f.path),
    routeCount: c.routes,
    models: [...new Set(c.models)].slice(0, 8),
    symbols: c.symbols.slice(0, 8),
    dependsOn: [...c.dependsOn].slice(0, 8),
    description: c.files.find((f) => f.facts.doc && f.path.split('/').length > 1 && /readme/i.test(f.path))?.facts.doc.summary || null,
  }));

  const importantFiles = files
    .filter((f) => ['readme', 'manifest', 'entrypoint', 'route', 'schema', 'deploy'].includes(f.facts.category) || (f.facts.doc && f.path.split('/').length <= 2))
    .slice(0, 40).map((f) => ({ path: f.path, category: f.facts.category }));
  const deploy = files.filter((f) => f.facts.category === 'deploy').map((f) => f.path).slice(0, 20);
  const tests = files.filter((f) => f.facts.category === 'test').length;

  return {
    overview: {
      description: repository?.description || null,
      purposeFromReadme: files.find((f) => /^readme/i.test(f.path.split('/').pop()) && f.path.split('/').length === 1)?.facts.doc?.summary || (readmeText ? readmeText.slice(0, 400) : null),
      languages: top(langCount, 6).map(([language, files]) => ({ language, files })),
      frameworks,
      defaultBranch: repository?.defaultBranch || null,
      topDirectories: top(dirCount, 12).map(([name, count]) => ({ name, files: count })),
    },
    entryPoints, buildAndTest, setupDocs, envVariables, dependencies, routes, models, components, importantFiles, docs, deploy,
    testFileCount: tests,
  };
}
