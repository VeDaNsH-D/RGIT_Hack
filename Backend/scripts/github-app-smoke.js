#!/usr/bin/env node
/**
 * Read-only live smoke test for the GitHub App integration.
 *
 *   npm run smoke:github-app -- [--installation-id <id>] [--repo owner/name] [--ingest] [--limit <n>]
 *
 * Steps: validate config -> sign App JWT -> GET /app -> exchange installation
 * token -> list installation repositories -> (optional) repository metadata ->
 * (optional, --ingest) fetch-and-normalize with small limits.
 *
 * Safety: performs only GET requests plus the token exchange POST GitHub
 * requires; never prints the private key, JWT, installation token, or headers;
 * prints only non-secret metadata and sanitized errors. Exits non-zero on failure
 * (1 = GitHub/runtime failure, 2 = local configuration error).
 *
 * Reads Backend/.env directly instead of src/config.js so it does not require
 * MongoDB/JWT settings.
 */

import 'dotenv/config';
import {
  GitHubAppAuthService,
  GitHubClient,
  readGitHubAppEnv,
  validateAppConfig,
  validateAppSlug,
  validateInstallationId,
  checkInstallationPermissions,
  listInstallationRepositories,
  fetchRepositoryMetadata,
  mapRepositoryMetadata,
  fetchGitHubRepositoryData,
  toSafeErrorSummary,
  GITHUB_ERROR_CODES,
} from '../src/modules/ingestion/providers/github/index.js';

const CONFIG_HELP = `
Local setup (never paste the key into chat, tickets, or commits):
  1. GitHub -> Settings -> Developer settings -> GitHub Apps -> <your app> -> "Private keys"
     -> "Generate a private key". A .pem file downloads. The SHA256 fingerprint shown
     on that page is NOT the key.
  2. Convert the .pem to a single .env line (run locally; prints nothing):
       node -e 'const k=require("fs").readFileSync(process.argv[1],"utf8").trim().replace(/\\n/g,"\\\\n");require("fs").appendFileSync(".env","\\nGITHUB_APP_PRIVATE_KEY=\\""+k+"\\"\\n")' /path/to/app.private-key.pem
     then delete the old GITHUB_APP_PRIVATE_KEY line from Backend/.env.
  3. Set GITHUB_APP_ID, GITHUB_APP_SLUG and GITHUB_APP_INSTALLATION_ID in Backend/.env.
  4. Re-run: npm run smoke:github-app`;

function parseArgs(argv) {
  const args = { ingest: false, limit: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--installation-id') args.installationId = argv[++i];
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--ingest') args.ingest = true;
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
    throw new Error('--limit must be an integer between 1 and 100');
  }
  return args;
}

const ok = (msg) => console.log(`  [ok]   ${msg}`);
const warn = (msg) => console.log(`  [warn] ${msg}`);

function fail(step, err) {
  const summary = toSafeErrorSummary(err);
  console.error(`  [FAIL] ${step}: ${summary.code}${summary.status ? ` (HTTP ${summary.status})` : ''} - ${summary.message}`);
  if (summary.code === GITHUB_ERROR_CODES.CONFIG_ERROR) {
    console.error(CONFIG_HELP);
    process.exit(2);
  }
  if (summary.code === GITHUB_ERROR_CODES.AUTH_FAILED) {
    console.error('  Hint: GitHub rejected the credentials. Check that GITHUB_APP_ID matches the app the key was generated for, and that the system clock is correct.');
  }
  if (summary.code === GITHUB_ERROR_CODES.NOT_FOUND && step.includes('token')) {
    console.error('  Hint: installation not found for this App. Check GITHUB_APP_INSTALLATION_ID (github.com/settings/installations/<id>).');
  }
  process.exit(1);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const env = readGitHubAppEnv();
  console.log('GitHub App smoke test (read-only)');

  // 1. Configuration
  let cfg;
  let installationId;
  try {
    cfg = validateAppConfig({ appId: env.appId, privateKey: env.privateKey });
    if (env.appSlug) validateAppSlug(env.appSlug);
    installationId = validateInstallationId(args.installationId || env.installationId);
  } catch (err) {
    fail('configuration', err);
  }
  ok(`configuration valid (appId=${cfg.appId}, slug=${env.appSlug || '(unset)'}, installationId=${installationId}, privateKey=present)`);

  const auth = new GitHubAppAuthService({ appId: env.appId, privateKey: env.privateKey });

  // 2. App JWT accepted by GitHub (GET /app)
  try {
    const appClient = new GitHubClient({ token: auth.createAppJwt() });
    const { data: app } = await appClient.get('/app');
    ok(`App JWT accepted (app="${app.name}", slug=${app.slug})`);
    if (env.appSlug && app.slug !== env.appSlug) {
      warn(`GITHUB_APP_SLUG (${env.appSlug}) does not match GitHub's slug (${app.slug})`);
    }
  } catch (err) {
    fail('App JWT authentication', err);
  }

  // 3. Installation token exchange
  let client;
  try {
    const result = await auth.createInstallationClient(installationId);
    client = result.client;
    ok(`installation token issued (expires ${result.expiresAt ? result.expiresAt.toISOString() : 'unknown'}, repository_selection=${result.repositorySelection})`);
    const perms = Object.entries(result.permissions).map(([k, v]) => `${k}:${v}`).sort().join(', ');
    ok(`granted permissions: ${perms || '(none)'}`);
    const check = checkInstallationPermissions(result.permissions);
    if (check.missing.length) warn(`missing read permissions needed by Relay: ${check.missing.join(', ')} (enable "Read-only" for each in the App settings, then accept the new permissions on the installation)`);
    if (check.writeGranted.length) warn(`write/admin permissions granted but not needed: ${check.writeGranted.join(', ')}`);
  } catch (err) {
    fail('installation token exchange', err);
  }

  // 4. Repository discovery
  try {
    const { repositories, totalCount, hasMore } = await listInstallationRepositories(client, { perPage: args.limit, maxPages: 1, maxRepos: args.limit });
    ok(`installation can access ${totalCount} repositories${hasMore ? ` (showing ${repositories.length})` : ''}`);
    for (const r of repositories) console.log(`         - ${r.fullName} (${r.isPrivate ? 'private' : 'public'}, default branch ${r.defaultBranch ?? 'n/a'})`);
  } catch (err) {
    fail('repository discovery', err);
  }

  // 5. Optional repository metadata / ingestion
  if (args.repo) {
    const [owner, repo, extra] = String(args.repo).split('/');
    if (!owner || !repo || extra !== undefined) {
      console.error('--repo must be in the form owner/name');
      process.exit(2);
    }

    try {
      const { repository } = await fetchRepositoryMetadata(client, owner, repo);
      const m = mapRepositoryMetadata(repository);
      ok(`repository metadata: ${m.fullName} | ${m.visibility} | language=${m.language ?? 'n/a'} | default=${m.defaultBranch ?? 'n/a'} | created=${m.createdAt} | updated=${m.updatedAt}`);
    } catch (err) {
      fail('repository metadata', err);
    }

    if (args.ingest) {
      const { result } = await fetchGitHubRepositoryData({
        owner, repo, projectId: 'smoke-test', client,
        limits: { issues: args.limit, pullRequests: args.limit, commits: args.limit },
      });
      ok(`fetch-and-normalize status=${result.status} fetched=${result.fetchedCount} normalized=${result.normalizedCount} skipped=${result.skippedCount} failed=${result.failedCount} persisted=${result.persisted}`);
      for (const [name, r] of Object.entries(result.resources)) {
        console.log(`         - ${name}: ${r.status} (fetched ${r.fetchedCount}, normalized ${r.normalizedCount}, skipped ${r.skippedCount})`);
      }
      for (const e of result.errors) console.log(`  [warn] ${e.resource}: ${e.code} - ${e.message}`);
      if (result.status === 'failed') process.exit(1);
    }
  }

  console.log('Smoke test passed.');
}

main().catch((err) => fail('unexpected', err));
