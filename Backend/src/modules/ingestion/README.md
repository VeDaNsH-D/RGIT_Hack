# Ingestion & Integrations Module (Relay)

> **Status:** Agreed application contract (aligned with Core Backend & Persistence)
> **Module owner:** Person 1 (Integrations & Data Ingestion Engineer)

---

## 1. Purpose

This module pulls project information from external sources, normalizes it into
`SourceRecordCandidate` objects, and hands those to a persistence adapter (Person 2's
`SourceRecord` model) and, through it, to the AI pipeline (Person 3).

| Source    | Status                                                              |
|-----------|---------------------------------------------------------------------|
| GitHub    | Implemented: App auth, discovery, repository/issues/PRs/commits, fetch-and-normalize |
| Documents | Planned (`.pdf`, `.docx`, `.txt`); contract fields already reserved |

Persistence, HTTP routes, and document extraction are **not** implemented here yet.

```
contracts/sourceRecord.js            Shared contract, validation, persistence mapping, ingestion result
providers/github/
  githubErrors.js                    Error codes, GitHubApiError, secret redaction
  githubClient.js                    HTTP transport: auth header, timeouts, bounded pagination, SSRF guards
  githubAppAuth.js                   App config validation, RS256 JWT, installation tokens, installation clients
  installationDiscovery.js           GET /installation/repositories
  repositories.js / issues.js / pullRequests.js / commits.js   Resource fetchers
  githubNormalizer.js                Raw GitHub payloads -> SourceRecordCandidate
  githubIngestionService.js          Unified fetch-and-normalize with partial-failure reporting
scripts/github-app-smoke.js     Read-only live check (Backend/scripts)
```

---

## 2. `SourceRecordCandidate` contract

```javascript
{
  projectId: string,          // Relay project ID (supplied by caller)
  provider: "github" | "document",
  recordType: "repository" | "issue" | "pull_request" | "commit" | "document",
  externalId: string,         // Stable provider ID (GitHub node_id; commits: "owner/repo#commit-<sha>")
  title: string,              // Non-empty
  content: string,            // Text for AI analysis ("" allowed)
  contentType: string,        // 'text/markdown' | 'text/plain' | ...
  url?: string,               // http(s) link back to the source (provenance)
  author?: string,            // Login or name
  authorId?: string,          // Provider user ID
  createdAt?: Date,           // Source creation time
  updatedAt?: Date,           // Source update time
  fetchedAt: Date,            // When Relay fetched it (same value for a whole run)
  version: number,            // Contract version, positive integer (1)
  isActive: boolean,          // false for closed issues / PRs
  isDeleted: boolean,
  metadata?: object,          // Provider-specific, bounded fields
  pageNumber?: number,        // Documents only
  passageReference?: string,  // Documents only
  extractionStatus?: string   // Documents only
}
```

`validateSourceRecordCandidate(record)` returns `{ valid, errors }`. It rejects:

- `id` / `_id` — database IDs are assigned by persistence, never by ingestion.
- `type` — that is the persisted field name; candidates use `recordType`.
- `observedAt` — deprecated; use `createdAt` / `updatedAt`.
- Unknown providers/record types, non-integer `version`, invalid `Date`s, non-http(s) `url`, array `metadata`.

Every normalizer validates its output before returning it.

`provider: "manual"` (`decision` / `note` records) is written directly by Person 2's
notes route and is intentionally not an ingestion provider.

### Timestamps

| Field       | Meaning                                                     |
|-------------|-------------------------------------------------------------|
| `createdAt` | Source creation (issue opened, commit **authored**)         |
| `updatedAt` | Source update (issue edited, commit **committed**)          |
| `fetchedAt` | When Relay fetched the record                               |

Candidates hold JS `Date`s; they serialize to ISO 8601 at API/JSON boundaries.

---

## 3. Candidate → persisted `SourceRecord`

`toSourceRecordDocument(candidate)` (pure, no DB access) is the single mapping onto
`src/models/SourceRecord.js`. No schema change is required.

| Candidate                                   | `SourceRecord` model                         |
|---------------------------------------------|----------------------------------------------|
| `projectId`, `provider`, `externalId`       | same — unique upsert key                     |
| `recordType`                                | **`type`**                                   |
| `title`, `content`                          | same                                         |
| `url` (optional)                            | `url` (`''` when absent, model default)      |
| `createdAt` / `updatedAt`                   | `metadata.sourceCreatedAt` / `metadata.sourceUpdatedAt` |
| `fetchedAt`, `contentType`, `author`, `authorId`, `version`, `isActive`, `isDeleted`, document fields | `metadata.<same name>` |
| `metadata`                                  | `metadata.providerMetadata`                  |
| —                                           | `_id`, `createdAt`, `updatedAt` (Mongoose), `isDemo` |

Source timestamps live in `metadata` because the model's own `createdAt`/`updatedAt`
are Mongoose persistence timestamps (`timestamps: true`) and must not be overwritten.

Suggested upsert for the future persistence adapter (not implemented here):

```javascript
const doc = toSourceRecordDocument(candidate);
await SourceRecord.findOneAndUpdate(
  { projectId: doc.projectId, provider: doc.provider, externalId: doc.externalId },
  { $set: doc },
  { upsert: true, new: true, includeResultMetadata: true }, // lastErrorObject.updatedExisting -> created vs updated
);
```

---

## 4. Ingestion result

```javascript
{
  provider: 'github',
  projectId,
  source: { owner, repo, fullName },
  status: 'succeeded' | 'partial' | 'failed',
  persisted: false,          // fetch-and-normalize never persists
  fetchedCount,              // items GitHub returned
  normalizedCount,           // valid candidates in `records`
  skippedCount,              // intentionally excluded (see below)
  failedCount,               // items rejected by normalization/validation
  createdCount: null,        // null until a persistence adapter runs — never fabricated
  updatedCount: null,
  resources: {
    repository:   { status, fetchedCount, normalizedCount, skippedCount, failedCount, hasMore },
    issues:       { ..., excludedPullRequestCount },
    pullRequests: { ... },
    commits:      { ..., repositoryEmpty },
  },
  errors: [{ resource, code, message, status, retryAt?, retryAfterSeconds? }],
  startedAt, completedAt      // ISO 8601
}
```

- Per category and in total: `fetchedCount = normalizedCount + skippedCount + failedCount`.
- `skippedCount` counts pull requests returned by the issues endpoint, items beyond the
  configured limit, and duplicate `externalId`s within a run (pagination shifts).
- Resource `status`: `succeeded` (an **empty** result is still `succeeded`), `failed`, or
  `skipped` (`skippedReason: 'disabled'` for a limit of 0, `'repository_unavailable'` after
  a fatal repository error).
- Overall `status`: `succeeded` with no errors; `partial` if something failed but at least
  one category succeeded; `failed` otherwise.
- Error messages are sanitized: credential-like strings are redacted and unknown internal
  errors become `INTERNAL_ERROR` / "Unexpected internal error."

---

## 5. GitHub App authentication

Relay uses a **GitHub App installation** flow (not OAuth, not a personal access token).
Relay's own email/password/JWT login is unrelated and unchanged.

```
GITHUB_APP_PRIVATE_KEY ─► RS256 App JWT (iss=App ID, iat=now-60s, exp=iat+9min)
                     ─► POST /app/installations/{id}/access_tokens
                     ─► installation token (≈1h, cached server-side until 5 min before expiry)
                     ─► GitHubClient({ token }) ─► GET /installation/repositories, /repos/...
```

- `GitHubAppAuthService#createInstallationClient(installationId)` always passes the
  installation token explicitly, so the client can never fall back to `GITHUB_TOKEN`.
- The private key, JWT and installation token are held in private class fields; they do
  not appear in `console.log`, `util.inspect` or `JSON.stringify` of the objects, and are
  never included in error messages. Installation tokens must never be returned to a
  frontend or stored in `SourceConnection.config`.

### Configuration (`Backend/.env`)

| Variable                     | Secret | Notes                                                    |
|------------------------------|--------|----------------------------------------------------------|
| `GITHUB_APP_ID`              | no     | Numeric App ID                                           |
| `GITHUB_APP_SLUG`            | no     | Lowercase slug (`github.com/apps/<slug>`)                |
| `GITHUB_APP_INSTALLATION_ID` | no     | Default installation for the smoke test/demo             |
| `GITHUB_APP_PRIVATE_KEY`     | **yes**| Full PEM contents, **not** the SHA256 fingerprint        |

The key may use real newlines or literal `\n` sequences. It is parsed with
`crypto.createPrivateKey` and must be an RSA key; anything else fails with
`CONFIG_ERROR` without echoing the value.

To put a downloaded `.pem` into `.env` as one line (prints nothing):

```bash
node -e 'const k=require("fs").readFileSync(process.argv[1],"utf8").trim().replace(/\n/g,"\\n");require("fs").appendFileSync(".env","\nGITHUB_APP_PRIVATE_KEY=\""+k+"\"\n")' /path/to/app.private-key.pem
```

Then remove any older `GITHUB_APP_PRIVATE_KEY` line. Never commit `.env` or `.pem` files.

### Required App permissions (read-only)

| Permission      | Level | Used for                                     |
|-----------------|-------|----------------------------------------------|
| Metadata        | Read  | Repository metadata, installation repo list  |
| Issues          | Read  | `GET /repos/{o}/{r}/issues`                  |
| Pull requests   | Read  | `GET /repos/{o}/{r}/pulls`                   |
| Contents        | Read  | `GET /repos/{o}/{r}/commits`                 |

No write permissions are needed. `checkInstallationPermissions(permissions)` reports
missing reads and unnecessary write grants.

---

## 6. Usage

```javascript
import {
  GitHubAppAuthService,
  fetchGitHubRepositoryData,
  fetchGitHubRepositoryDataForInstallation,
  listInstallationRepositories,
} from './providers/github/index.js';
import { config } from '../../config.js';

const auth = new GitHubAppAuthService({
  appId: config.githubApp.appId,
  privateKey: config.githubApp.privateKey,
});

// Discover repositories the installation can see
const { client } = await auth.createInstallationClient(installationId);
const { repositories } = await listInstallationRepositories(client, { maxRepos: 100 });

// Fetch + normalize one repository (no database needed)
const { records, repository, result } = await fetchGitHubRepositoryData({
  owner: 'acme',
  repo: 'relay',
  projectId: String(project._id),
  client,
  limits: { issues: 100, pullRequests: 100, commits: 50 }, // defaults; max 500 each; 0 disables
  since: '2026-09-01T00:00:00Z',                           // optional: issues/commits updated since
});

// Or in one call
const out = await fetchGitHubRepositoryDataForInstallation({
  authService: auth, installationId, owner: 'acme', repo: 'relay', projectId,
});
```

Invalid `owner`/`repo`/`projectId`/`limits`/`since` throw `INVALID_INPUT` before any
request. GitHub failures do **not** throw; they appear in `result.errors`, and records
from successful categories are still returned.

Behavior notes:

- Pull requests returned by the issues endpoint are excluded from issue records (and
  `normalizeIssue` refuses PR-shaped input), so a PR is only ever a `pull_request` record.
- GitHub's `409 Git Repository is empty` on commits is a successful empty result.
- Pagination is bounded: `perPage ≤ 100`, at most 20 pages per call, item limits ≤ 500.
- Requests run sequentially to stay clear of GitHub secondary rate limits.
- `AUTH_FAILED`, `FORBIDDEN`, `NOT_FOUND` or `RATE_LIMITED` on the repository request
  stops the run (remaining categories `skipped`); other repository errors do not.

### Error codes

`INVALID_INPUT`, `CONFIG_ERROR`, `AUTH_FAILED` (401), `FORBIDDEN` (403 / 422 on token
scoping), `RATE_LIMITED` (403 with exhausted quota or rate-limit message, 429),
`NOT_FOUND` (404), `SERVER_ERROR` (5xx), `TIMEOUT`, `NETWORK_ERROR`,
`UNEXPECTED_RESPONSE`, `NORMALIZATION_FAILED`, `HTTP_ERROR`, `INTERNAL_ERROR`.

---

## 7. Live smoke test (read-only)

```bash
cd Backend
npm run smoke:github-app
npm run smoke:github-app -- --repo owner/name            # + repository metadata
npm run smoke:github-app -- --repo owner/name --ingest   # + fetch-and-normalize summary (counts only)
npm run smoke:github-app -- --installation-id 123 --limit 5
```

Steps: validate config → sign JWT → `GET /app` → installation token exchange → list
repositories → optional metadata/ingestion. Only GET requests are made, plus the token
exchange POST GitHub requires. Output contains only non-secret metadata (App ID, slug,
repository names, permission names, counts); the key, JWT, token and headers are never
printed. Exit codes: `0` passed, `1` GitHub/runtime failure, `2` local configuration error
(with setup instructions).

---

## 8. Tests

```bash
cd Backend
node --test 'src/modules/ingestion/**/*.test.js'
```

(`node --test src/modules/ingestion/` does not work on Node 22 — pass the glob.) All
GitHub responses are mocked; no credentials or network are required.
