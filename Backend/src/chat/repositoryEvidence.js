import { tokenize } from '../services/documentContext.js';

const forms = new Map([
  ['technologies', 'technology'], ['frameworks', 'framework'],
  ['dependencies', 'dependency'], ['languages', 'language'],
  ['packages', 'package'], ['requirements', 'requirement'],
  ['built', 'build'], ['building', 'build'],
  ['running', 'run'], ['runs', 'run'],
  ['locally', 'local'],
  ['starts', 'start'], ['starting', 'start'],
  ['installing', 'install'], ['installation', 'install'],
  ['executing', 'execute'], ['execution', 'execute'],
  ['developing', 'develop'], ['development', 'develop'],
  ['testing', 'test'], ['tests', 'test'],
  ['ports', 'port'], ['servers', 'server'],
  ['variables', 'variable'], ['configs', 'config'],
  ['configurations', 'config'], ['configured', 'config'],
  ['endpoints', 'endpoint'], ['routes', 'route'],
  ['databases', 'database'],
]);
export function chatTerms(text) {
  return new Set([...tokenize(text)].map(term => forms.get(term) || term));
}

export function isFollowUpQuestion(question) {
  if (/\b(it|its|they|them|their|this|that|these|those|there|here|the same|also|instead|too|else|otherwise|what about|how about|and|why)\b/i.test(question)) return true;
  if (/\b(port|env|environment|variable|entrypoint|docker|script|command|database|db|config|test|tests)\b/i.test(question)) return true;
  if (chatTerms(question).size <= 3) return true;
  return false;
}

export function questionIntent(question, history = []) {
  const terms = chatTerms(question);
  if (['technology', 'stack', 'framework', 'dependency', 'language'].some(term => terms.has(term))) return 'stack';
  if (/\b(project|repo(?:sitory)?|app(?:lication)?)\b.*\b(about|purpose|overview|brief|summary)\b|\b(summarize|summarise|overview|purpose)\b/i.test(question)) return 'overview';
  if (/\b(run|running|start|starting|setup|set up|install|installation|local|locally|dev|develop|development|execute|execution|launch)\b/i.test(question)) return 'setup';
  if (/\b(route|routes|endpoint|endpoints|api|url|urls|path|paths|controller)\b/i.test(question)) return 'route';
  if (/\b(model|models|schema|schemas|database|db|entity|entities|collection|table|tables)\b/i.test(question)) return 'schema';
  if (history && history.length && isFollowUpQuestion(question)) {
    for (let i = history.length - 1; i >= 0; i--) {
      const prior = history[i]?.question;
      if (!prior) continue;
      const priorIntent = questionIntent(prior);
      if (priorIntent) return priorIntent;
    }
  }
  return null;
}

export function expandedQuery(question, history = []) {
  const terms = chatTerms(question);
  const intent = questionIntent(question, history);
  if (intent === 'stack') {
    for (const term of ['technology', 'stack', 'framework', 'dependency', 'language', 'package', 'requirements']) terms.add(term);
  }
  if (intent === 'setup') {
    for (const term of ['run', 'start', 'dev', 'build', 'script', 'command', 'install', 'setup', 'entrypoint', 'node', 'npm', 'port', 'env', 'server']) terms.add(term);
  }
  if (intent === 'route') {
    for (const term of ['route', 'endpoint', 'api', 'method', 'path', 'controller', 'request', 'response', 'server', 'express']) terms.add(term);
  }
  if (intent === 'schema') {
    for (const term of ['model', 'schema', 'database', 'db', 'mongoose', 'table', 'collection', 'entity', 'data']) terms.add(term);
  }
  if (history && history.length && isFollowUpQuestion(question)) {
    for (const turn of history.slice(-2)) {
      if (!turn?.question) continue;
      for (const term of chatTerms(turn.question)) {
        if (!['what', 'how', 'why', 'when', 'where', 'which', 'who', 'is', 'are', 'do', 'does', 'can', 'could', 'the', 'this', 'that', 'it', 'its'].includes(term)) {
          terms.add(term);
        }
      }
    }
  }
  return terms;
}

export function repositoryFileKind(path) {
  const name = path.split('/').pop().toLowerCase();
  if (/^readme(?:\.|$)/.test(name)) return 'readme';
  if (/^(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|gemfile|composer\.json)$/.test(name)) return 'manifest';
  if (/^(index|main|app|server)\.[a-z0-9]+$/i.test(name)) return 'entrypoint';
  return 'file';
}

// Only pass knowledge from an authorized, published snapshot. Keep the file/commit
// provenance rather than treating an inferred framework as an uncited project fact.
export function repositoryEvidence(snapshot) {
  const knowledge = snapshot.knowledge || {};
  const overview = knowledge.overview || {};
  const root = `https://github.com/${snapshot.fullName}/tree/${snapshot.commitSha}`;
  const rows = [];
  const details = [overview.description, overview.purposeFromReadme].filter(Boolean);
  if (details.length) rows.push({
    key: `overview:${snapshot._id}`, kind: 'overview', provider: 'github',
    title: `${snapshot.fullName} — Repository overview @ ${snapshot.commitSha.slice(0, 7)}`,
    text: details.join('\n'), url: root,
  });
  const stack = [];
  if (overview.languages?.length) stack.push(`Languages observed in repository files: ${overview.languages.map(item => typeof item === 'string' ? item : item.language).join(', ')}`);
  if (overview.frameworks?.length) stack.push(`Frameworks detected from dependency manifests: ${overview.frameworks.join(', ')}`);
  if (stack.length) rows.push({
    key: `stack:${snapshot._id}`, kind: 'stack', provider: 'github',
    title: `${snapshot.fullName} — Technology stack @ ${snapshot.commitSha.slice(0, 7)}`,
    text: stack.join('\n'), url: root,
  });
  for (const dependency of knowledge.dependencies || []) {
    if (!dependency.file || !dependency.top?.length) continue;
    rows.push({
      key: `dependencies:${snapshot._id}:${dependency.file}`, kind: 'manifest', provider: 'github',
      title: `${snapshot.fullName}/${dependency.file} — Dependencies @ ${snapshot.commitSha.slice(0, 7)}`,
      text: `Dependency manifest: ${dependency.file}\nDeclared production dependencies (not proof of runtime usage): ${dependency.top.join(', ')}`,
      url: `https://github.com/${snapshot.fullName}/blob/${snapshot.commitSha}/${dependency.file}`,
    });
  }
  const setup = [];
  if (Array.isArray(knowledge.buildAndTest) && knowledge.buildAndTest.length) {
    setup.push('Build, start, and development commands detected in repository manifests:');
    for (const cmd of knowledge.buildAndTest) {
      const prefix = cmd.file ? `${cmd.file}: ` : '';
      setup.push(`- ${prefix}${cmd.name} -> \`${cmd.command}\``);
    }
  }
  if (Array.isArray(knowledge.entryPoints) && knowledge.entryPoints.length) {
    setup.push(`Entry points: ${knowledge.entryPoints.join(', ')}`);
  }
  if (Array.isArray(knowledge.envVariables) && knowledge.envVariables.length) {
    setup.push(`Environment variables referenced: ${knowledge.envVariables.map(v => v.name).filter(Boolean).join(', ')}`);
  }
  if (setup.length) rows.push({
    key: `setup:${snapshot._id}`, kind: 'setup', provider: 'github',
    title: `${snapshot.fullName} — Build and run commands @ ${snapshot.commitSha.slice(0, 7)}`,
    text: setup.join('\n'), url: root,
  });
  if (Array.isArray(knowledge.routes) && knowledge.routes.length) {
    const list = knowledge.routes.slice(0, 30).map(r => `- ${r.method} ${r.path} (${r.file}:${r.line})`);
    rows.push({
      key: `routes:${snapshot._id}`, kind: 'route', provider: 'github',
      title: `${snapshot.fullName} — API routes and endpoints @ ${snapshot.commitSha.slice(0, 7)}`,
      text: `Declared API endpoints and routes:\n${list.join('\n')}`,
      url: root,
    });
  }
  if (Array.isArray(knowledge.models) && knowledge.models.length) {
    const list = knowledge.models.slice(0, 30).map(m => `- ${m.name} (${m.kind}) in ${m.file}:${m.line}`);
    rows.push({
      key: `models:${snapshot._id}`, kind: 'schema', provider: 'github',
      title: `${snapshot.fullName} — Data models and schemas @ ${snapshot.commitSha.slice(0, 7)}`,
      text: `Declared data models and schemas:\n${list.join('\n')}`,
      url: root,
    });
  }
  if (Array.isArray(knowledge.importGraph) && knowledge.importGraph.length) {
    const connections = knowledge.importGraph.slice(0, 25).map(g => `- ${g.file} -> imports: ${g.imports.join(', ')}`);
    rows.push({
      key: `imports:${snapshot._id}`, kind: 'entrypoint', provider: 'github',
      title: `${snapshot.fullName} — Module dependencies and import graph @ ${snapshot.commitSha.slice(0, 7)}`,
      text: `Local module dependency graph:\n${connections.join('\n')}`,
      url: root,
    });
  }
  return rows;
}

