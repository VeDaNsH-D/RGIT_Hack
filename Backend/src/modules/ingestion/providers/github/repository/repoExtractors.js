/**
 * Deterministic extraction of repository facts from file CONTENT. No code is executed and nothing is
 * inferred by a model: every fact carries the file (and line when known) it came from, so any path or
 * symbol later shown to a user can be verified against the stored repository content.
 */
import { categorize, languageOf } from './repoFilters.js';

const line = (text, index) => text.slice(0, index).split('\n').length;
/** The declaration line itself (trimmed, bounded), so an explanation can cite a symbol's real signature. */
const signature = (text, index) => text.slice(index, (text.indexOf('\n', index) + 1 || text.length + 1) - 1).trim().replace(/\s*[{:]\s*$/, '').slice(0, 120);
const dedupe = (items, key) => { const seen = new Set(); return items.filter((i) => { const k = key(i); if (seen.has(k)) return false; seen.add(k); return true; }); };
const MAX = { symbols: 15, routes: 60, models: 40, env: 60, deps: 80 };

export function extractManifest(path, text) {
  const name = path.split('/').pop().toLowerCase();
  const out = { dependencies: [], scripts: {}, name: null, entry: null, engines: null, framework: [] };
  try {
    if (name === 'package.json') {
      const pkg = JSON.parse(text);
      out.name = typeof pkg.name === 'string' ? pkg.name : null;
      out.entry = typeof pkg.main === 'string' ? pkg.main : null;
      out.engines = pkg.engines && typeof pkg.engines === 'object' ? pkg.engines : null;
      for (const [k, v] of Object.entries(pkg.scripts || {})) if (typeof v === 'string') out.scripts[k] = v;
      for (const kind of ['dependencies', 'devDependencies']) for (const [dep, ver] of Object.entries(pkg[kind] || {})) out.dependencies.push({ name: dep, version: String(ver), dev: kind === 'devDependencies' });
    } else if (name.startsWith('requirements') && name.endsWith('.txt')) {
      for (const l of text.split('\n')) { const m = l.trim().match(/^([A-Za-z0-9_.-]+)\s*([<>=!~]=?[^#\s]*)?/); if (m && !l.trim().startsWith('#') && !l.trim().startsWith('-')) out.dependencies.push({ name: m[1], version: m[2] || '', dev: false }); }
    } else if (name === 'pyproject.toml') {
      const deps = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (deps) for (const m of deps[1].matchAll(/["']([A-Za-z0-9_.-]+)\s*([^"']*)["']/g)) out.dependencies.push({ name: m[1], version: m[2].trim(), dev: false });
      for (const m of text.matchAll(/^([A-Za-z0-9_.-]+)\s*=\s*["'](\^?~?[\d.*][^"']*)["']/gm)) if (!['name', 'version', 'python'].includes(m[1])) out.dependencies.push({ name: m[1], version: m[2], dev: false });
    } else if (name === 'go.mod') {
      for (const m of text.matchAll(/^\s*([\w./-]+\.[\w./-]+)\s+(v[\w.+-]+)/gm)) out.dependencies.push({ name: m[1], version: m[2], dev: false });
    } else if (name === 'cargo.toml') {
      const sec = text.match(/\[dependencies\]([\s\S]*?)(\n\[|$)/);
      if (sec) for (const m of sec[1].matchAll(/^([\w-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) out.dependencies.push({ name: m[1], version: m[2] || m[3] || '', dev: false });
    } else if (name === 'pom.xml') {
      for (const m of text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) out.dependencies.push({ name: m[1], version: '', dev: false });
    }
  } catch { /* A malformed manifest simply yields no facts. */ }
  out.dependencies = dedupe(out.dependencies, (d) => d.name).slice(0, MAX.deps);
  const names = new Set(out.dependencies.map((d) => d.name.toLowerCase()));
  for (const [dep, label] of [['react', 'React'], ['vue', 'Vue'], ['next', 'Next.js'], ['express', 'Express'], ['fastify', 'Fastify'], ['mongoose', 'Mongoose'], ['vite', 'Vite'], ['fastapi', 'FastAPI'], ['flask', 'Flask'], ['django', 'Django'], ['sqlalchemy', 'SQLAlchemy'], ['pydantic', 'Pydantic'], ['jest', 'Jest'], ['pytest', 'pytest'], ['prisma', 'Prisma']]) if (names.has(dep)) out.framework.push(label);
  return out;
}

export function extractEnvNames(path, text) {
  const out = [];
  if (/^\.env\.(example|sample|template|defaults?)$/i.test(path.split('/').pop())) {
    for (const m of text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]{2,})\s*=/gm)) out.push({ name: m[1], file: path });
  }
  for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) out.push({ name: m[1], file: path, line: line(text, m.index) });
  for (const m of text.matchAll(/os\.(?:environ(?:\.get)?\(|getenv\(|environ\[)\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) out.push({ name: m[1], file: path, line: line(text, m.index) });
  return dedupe(out, (e) => e.name).slice(0, MAX.env);
}

export function extractRoutes(path, text) {
  const out = [];
  for (const m of text.matchAll(/\b(?:router|app|server|api)\.(get|post|put|patch|delete|all)\(\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/g)) {
    const paths = [...m[2].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    for (const p of paths) out.push({ method: m[1].toUpperCase(), path: p, file: path, line: line(text, m.index) });
  }
  for (const m of text.matchAll(/@(?:\w+)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g)) out.push({ method: m[1].toUpperCase(), path: m[2], file: path, line: line(text, m.index) });
  for (const m of text.matchAll(/@\w+\.route\(\s*["']([^"']+)["']/g)) out.push({ method: 'ANY', path: m[1], file: path, line: line(text, m.index) });
  return dedupe(out, (r) => `${r.method} ${r.path}`).slice(0, MAX.routes);
}

export function extractModels(path, text) {
  const out = [];
  for (const m of text.matchAll(/mongoose\.model\(\s*['"`](\w+)['"`]/g)) out.push({ name: m[1], kind: 'mongoose', file: path, line: line(text, m.index) });
  for (const m of text.matchAll(/^\s*model\s+(\w+)\s*\{/gm)) out.push({ name: m[1], kind: 'prisma', file: path, line: line(text, m.index) });
  for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi)) out.push({ name: m[1], kind: 'sql', file: path, line: line(text, m.index) });
  for (const m of text.matchAll(/^class\s+(\w+)\((?:[\w.]*BaseModel|[\w.]*Base|[\w.]*models\.Model|[\w.]*db\.Model)\)/gm)) out.push({ name: m[1], kind: 'python-model', file: path, line: line(text, m.index) });
  return dedupe(out, (x) => `${x.kind}:${x.name}`).slice(0, MAX.models);
}

export function extractSymbols(path, text) {
  const out = [];
  const lang = languageOf(path);
  if (lang === 'JavaScript' || lang === 'TypeScript') {
    for (const m of text.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(function\*?|class)\s+(\w+)/gm)) out.push({ name: m[2], kind: m[1].startsWith('function') ? 'function' : 'class', file: path, line: line(text, m.index), signature: signature(text, m.index) });
    for (const m of text.matchAll(/^export\s+const\s+(\w+)\s*=/gm)) out.push({ name: m[1], kind: 'const', file: path, line: line(text, m.index), signature: signature(text, m.index) });
    if (!out.length) for (const m of text.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)) out.push({ name: m[1], kind: 'function', file: path, line: line(text, m.index), signature: signature(text, m.index) });
  } else if (lang === 'Python') {
    for (const m of text.matchAll(/^(?:async\s+)?(def|class)\s+(\w+)/gm)) if (!m[2].startsWith('_')) out.push({ name: m[2], kind: m[1] === 'def' ? 'function' : 'class', file: path, line: line(text, m.index), signature: signature(text, m.index) });
  } else if (lang === 'Go') {
    for (const m of text.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm)) out.push({ name: m[1], kind: 'function', file: path, line: line(text, m.index), signature: signature(text, m.index) });
  }
  return out.slice(0, MAX.symbols);
}

/** Relative JS/TS imports and in-repo Python imports, resolved against the known file set. */
export function extractImports(path, text, knownPaths) {
  const lang = languageOf(path);
  const dir = path.split('/').slice(0, -1);
  const resolved = new Set();
  const tryResolve = (candidate) => {
    const exts = ['', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.py', '/index.js', '/index.ts', '/__init__.py'];
    return exts.map((e) => candidate + e).find((c) => knownPaths.has(c)) || null;
  };
  const normalize = (parts) => { const out = []; for (const p of parts) { if (p === '.' || p === '') continue; if (p === '..') out.pop(); else out.push(p); } return out.join('/'); };
  if (lang === 'JavaScript' || lang === 'TypeScript') {
    for (const m of text.matchAll(/(?:from\s+|require\(\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) { const r = tryResolve(normalize([...dir, ...m[1].split('/')])); if (r) resolved.add(r); }
  } else if (lang === 'Python') {
    for (const m of text.matchAll(/^(?:from|import)\s+([A-Za-z_][\w.]*)/gm)) { const r = tryResolve(m[1].split('.').join('/')) || tryResolve([...dir, ...m[1].split('.')].join('/')); if (r && r !== path) resolved.add(r); }
  }
  resolved.delete(path);
  return [...resolved].slice(0, 40);
}

const DOC_SECTION = /(install|setup|set up|getting started|quick ?start|running|run |usage|test|prerequisite|requirements|environment|configuration|deploy)/i;

/** Headings, opening paragraph, and setup/test sections quoted verbatim from a markdown document. */
export function extractDoc(path, text) {
  const headings = [...text.matchAll(/^(#{1,3})\s+(.+?)\s*#*$/gm)].map((m) => ({ level: m[1].length, text: m[2].trim(), index: m.index }));
  const first = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('!['));
  const sections = [];
  headings.forEach((h, i) => {
    if (!DOC_SECTION.test(h.text)) return;
    const end = headings.slice(i + 1).find((n) => n.level <= h.level)?.index ?? text.length;
    sections.push({ heading: h.text, excerpt: text.slice(h.index, end).trim().slice(0, 1500) });
  });
  return { title: headings[0]?.text || null, headings: headings.slice(0, 30).map((h) => h.text), summary: first ? first.slice(0, 600) : null, setupSections: sections.slice(0, 4) };
}

export function extractFileFacts(path, text, knownPaths) {
  const category = categorize(path);
  const facts = { category, language: languageOf(path), lines: text.split('\n').length };
  if (category === 'manifest') facts.manifest = extractManifest(path, text);
  if (category === 'readme' || category === 'doc') if (/\.(md|mdx|rst|txt)$/i.test(path)) facts.doc = extractDoc(path, text);
  facts.env = extractEnvNames(path, text);
  if (['source', 'route', 'entrypoint', 'schema', 'test'].includes(category) || facts.language) {
    facts.routes = extractRoutes(path, text);
    facts.models = extractModels(path, text);
    facts.symbols = extractSymbols(path, text);
    facts.imports = extractImports(path, text, knownPaths);
  }
  return facts;
}
