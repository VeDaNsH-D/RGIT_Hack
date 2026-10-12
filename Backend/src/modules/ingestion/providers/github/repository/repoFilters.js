/**
 * Pure rules deciding which repository files may be analyzed. Nothing here touches the network.
 *
 * A file is excluded BEFORE any content is fetched when its path says it is a dependency directory, build
 * output, binary, lock file or likely secret. Content is scanned again after fetching (secret patterns),
 * so a credential hidden in an innocently named file is still never stored.
 */

export const ANALYZER_VERSION = 1;

const EXCLUDED_DIRS = new Set(['node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', 'coverage', '.git', '__pycache__', '.venv', 'venv', 'env', '.tox', '.idea', '.vscode', '.gradle', 'Pods', '.terraform', '.cache', '.turbo']);
const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'pdf', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'jar', 'war', 'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'pyc', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'psd', 'ai', 'sketch', 'db', 'sqlite', 'sqlite3', 'wasm', 'map', 'lock']);
const LOCK_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'bun.lockb']);
const SECRET_NAMES = [/^\.env(\..+)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.jks$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /(^|\/)credentials(\.json)?$/i, /(^|\/)secrets?(\.[a-z]+)?$/i, /\.keystore$/i, /(^|\/)\.npmrc$/i, /(^|\/)\.netrc$/i, /service-?account.*\.json$/i];
const TEMPLATE_ENV = /^\.env\.(example|sample|template|defaults?)$/i;
const SOURCE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rb', 'java', 'kt', 'rs', 'php', 'cs', 'swift', 'scala', 'sql', 'prisma', 'graphql', 'gql', 'proto', 'sh', 'vue', 'svelte']);
const CONFIG_EXT = new Set(['json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'gradle', 'properties']);
const LANGUAGES = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', go: 'Go', rb: 'Ruby', java: 'Java', kt: 'Kotlin', rs: 'Rust', php: 'PHP', cs: 'C#', swift: 'Swift', scala: 'Scala', sql: 'SQL', prisma: 'Prisma', graphql: 'GraphQL', gql: 'GraphQL', proto: 'Protobuf', sh: 'Shell', vue: 'Vue', svelte: 'Svelte', css: 'CSS', scss: 'SCSS', html: 'HTML', md: 'Markdown' };

const ext = (path) => { const base = path.split('/').pop(); const i = base.lastIndexOf('.'); return i > 0 ? base.slice(i + 1).toLowerCase() : ''; };
const base = (path) => path.split('/').pop();

export const languageOf = (path) => LANGUAGES[ext(path)] || null;

/** Why a path is excluded, or null when it may be analyzed. */
export function exclusionReason(path) {
  const parts = path.split('/');
  if (parts.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir))) return 'dependency_or_build_dir';
  const name = base(path);
  if (TEMPLATE_ENV.test(name)) return null;
  if (SECRET_NAMES.some((re) => re.test(name) || re.test(path))) return 'secret_file';
  if (LOCK_FILES.has(name)) return 'lock_file';
  if (/\.min\.(js|css)$/i.test(name) || /\.(bundle|chunk)\.js$/i.test(name)) return 'generated';
  if (BINARY_EXT.has(ext(path))) return 'binary';
  return null;
}

/** Coarse category used for prioritization and the knowledge base. */
export function categorize(path) {
  const name = base(path);
  const lower = path.toLowerCase();
  if (/^readme(\.|$)/i.test(name)) return 'readme';
  if (/^(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|build\.gradle|gemfile|composer\.json|pipfile)$/i.test(name)) return 'manifest';
  if (/\.(md|mdx|rst|txt)$/i.test(name) || /(^|\/)docs?\//i.test(path)) return 'doc';
  if (TEMPLATE_ENV.test(name)) return 'config';
  if (/(^|\/)\.github\/workflows\//.test(path) || /^(dockerfile|docker-compose[\w.-]*\.ya?ml|vercel\.json|netlify\.toml|procfile|makefile|\.gitlab-ci\.yml|jenkinsfile)$/i.test(name) || /(^|\/)(k8s|kubernetes|helm|deploy|terraform)\//i.test(path)) return 'deploy';
  if (/(^|\/)(tests?|__tests__|spec|e2e)\//i.test(path) || /\.(test|spec)\.[a-z]+$/i.test(name) || /^test_.*\.py$/.test(name)) return 'test';
  if (/(^|\/)(models?|schemas?|migrations?|entities)\//i.test(path) || /\.(sql|prisma)$/i.test(name)) return 'schema';
  if (/(^|\/)(routes?|controllers?|api|endpoints?|handlers?)\//i.test(path)) return 'route';
  if (/(^|\/)(server|app|main|index|manage|wsgi|asgi)\.(js|mjs|ts|py|go|rb|java)$/i.test(lower)) return 'entrypoint';
  if (SOURCE_EXT.has(ext(path))) return 'source';
  if (CONFIG_EXT.has(ext(path)) || /^\.[\w-]*rc(\.\w+)?$/.test(name) || /^(tsconfig|jsconfig|eslint\.config|vite\.config|webpack\.config|babel\.config)/i.test(name)) return 'config';
  return 'other';
}

const PRIORITY = { readme: 0, manifest: 1, entrypoint: 2, doc: 3, route: 4, schema: 4, deploy: 5, config: 6, source: 7, test: 9, other: 10 };

/** Lower is analyzed first; shallow, small files win ties. */
export function priorityOf(entry) {
  const depth = entry.path.split('/').length - 1;
  return (PRIORITY[categorize(entry.path)] ?? 10) * 1000 + Math.min(depth, 20) * 20 + Math.min(Math.floor((entry.size || 0) / 4096), 19);
}

// Content-level detection. These are conservative on purpose: a hit means the whole file is skipped.
const SECRET_CONTENT = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, /\bsk-[A-Za-z0-9]{32,}\b/, /\bgsk_[A-Za-z0-9]{30,}\b/, /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_=.-]{20,}["']/i,
  /\bmongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@/i,
];
export const containsSecret = (text) => SECRET_CONTENT.some((re) => re.test(text));

export function looksBinary(text) {
  return text.includes('\u0000');
}
