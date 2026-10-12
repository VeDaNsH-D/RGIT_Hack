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
| Notion    | Implemented: authorized pages, recursive block trees, database records (see `Backend/docs/notion-integration.md`) |
| Jira      | Implemented: Jira Cloud issues via JQL search (see `Backend/docs/jira-integration.md`) |
| Slack     | Implemented: channel messages and threads (see `Backend/docs/slack-integration.md`) |
| Documents | Implemented (internal): `.pdf`, `.docx`, `.txt` validation, extraction, storage, Document + SourceRecord persistence (section 9). No upload route yet. |

Persistence (section 3a) and document processing (section 9) are implemented. HTTP routes are **not** implemented here yet.

```
contracts/sourceRecord.js            Shared contract, validation, persistence mapping, ingestion result
persistence/sourceRecordStore.js     Idempotent upserts of candidates into the SourceRecord model
persistence/inMemorySourceRecordModel.js   bulkWrite test double (unique index, races, write errors)
providers/github/
  githubErrors.js                    Error codes, GitHubApiError, secret redaction
  githubClient.js                    HTTP transport: auth header, timeouts, bounded pagination, SSRF guards
  githubAppAuth.js                   App config validation, RS256 JWT, installation tokens, installation clients
  installationDiscovery.js           GET /installation/repositories
  repositories.js / issues.js / pullRequests.js / commits.js   Resource fetchers
  githubNormalizer.js                Raw GitHub payloads -> SourceRecordCandidate
  githubIngestionService.js          Unified fetch-and-normalize with partial-failure reporting (no DB)
  githubSyncService.js               Fetch -> normalize -> persist; SourceConnection-driven sync
documents/                           Validation, extraction, storage, normalizer, processing service (section 9)
providers/notion/, providers/jira/, providers/slack/   Client, connector, extractor, normalizer per provider
scripts/github-app-smoke.js          Read-only live check (Backend/scripts)
```

---

## 2. `SourceRecordCandidate` contract

```javascript
{
  projectId: string,          // Relay project ID (supplied by caller)
  provider: "github" | "notion" | "jira" | "slack" | "document",
  recordType: "repository" | "issue" | "pull_request" | "commit" | "document"
            | "note" | "decision" | "message",
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
notes route and is intentionally not an ingestion provider; the `note`/`decision`
record types are also used by ingestion providers such as Notion.

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

### 3a. Persistence and deduplication

`persistSourceRecordCandidates({ projectId, records })` (`persistence/sourceRecordStore.js`)
writes candidates with one unordered `SourceRecord.bulkWrite` of `updateOne` upserts per
chunk (500), keyed on the model's unique index `{ projectId, provider, externalId }`.

- **Idempotent:** re-ingesting a source updates the existing document; `_id`, `isDemo`
  and Mongoose `createdAt` are preserved.
- **Merge, not replace:** `type`, `title`, `content` are always set; `url` only when
  present; metadata via dotted `$set` paths, so fields a provider omits stay intact.
  `null` in provider metadata is written (cleared at source); `undefined` is skipped.
- **Authoritative projectId:** must be a 24-hex ObjectId supplied by the caller from an
  authorized project association. Records whose `projectId` differs (including the
  `'default-project'` placeholder some normalizers use) fail with `PROJECT_MISMATCH`.
- **Input:** `SourceRecordCandidate`s only. Legacy `integrations/common/types.js` records
  (`id`/`type`/`observedAt`) fail with `UNSUPPORTED_RECORD_FORMAT`; use the providers'
  candidate output (`asCandidate: true` for Jira/Slack connectors).
- **Races:** an `E11000` from a concurrent writer is retried once and becomes an update.
- **Secrets:** provider metadata is scrubbed before writing: credential-like keys
  (`*token*`, `*secret*`, `*password*`, `*apikey*`, `authorization`, ...) are dropped and
  token-like values (GitHub, Slack, Notion, Atlassian, Bearer, JWT, PEM) are redacted.
- **Never throws** for record or database errors; throws only for an invalid `projectId`
  or a non-array `records` argument.

Result (same conventions as the ingestion result):

```javascript
{
  provider: 'github' | 'notion' | 'jira' | 'slack' | 'mixed' | null,
  projectId, status: 'succeeded' | 'partial' | 'failed',
  persisted,            // true only if at least one write was acknowledged
  receivedCount, createdCount, updatedCount,
  skippedCount,         // duplicates of the same identity within the batch
  failedCount,          // invalid records + write failures
  errors: [{ index, provider, externalId, code, message }],   // index into `records`
  startedAt, completedAt,
}
```

Error codes: `INVALID_RECORD`, `UNSUPPORTED_RECORD_FORMAT`, `PROJECT_MISMATCH`,
`RECORD_TOO_LARGE`, `DUPLICATE_IN_BATCH` (skipped), `WRITE_FAILED`, `DATABASE_ERROR`
(non-write failure such as a lost connection: the whole chunk is reported failed),
`ERRORS_TRUNCATED`.

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

Persistence-enabled path (imported directly; not re-exported from `providers/github/index.js`
so the fetch-only barrel has no database dependency):

```javascript
import { syncGitHubRepository, syncGitHubSourceConnection } from './providers/github/githubSyncService.js';

// projectId must be the authorized Relay project's ObjectId (e.g. req.project._id)
const { result } = await syncGitHubRepository({ owner, repo, projectId: req.project._id, client });
// result.persisted, result.createdCount, result.updatedCount, result.persistence

// Or from a GitHub SourceConnection: projectId comes from the connection document.
// Proposed config shape: { installationId, owner, repo }
const { result: r } = await syncGitHubSourceConnection({ connection, authService: auth });
```

In sync results, persistence errors are appended to `result.errors` with
`resource: 'persistence'`, and `status` reflects both fetch and persistence errors.

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

---

## 9. Documents (Part 6; upload route: POST /api/projects/:id/documents)

```
documents/
  documentErrors.js              Error codes; safe messages (no content, stacks, or paths)
  zipInspector.js                Bounded in-memory ZIP inspection (no disk extraction)
  documentValidation.js          Allowlists, filename sanitizing, signature/structure/encoding checks
  documentExtraction.js          extractDocumentText({ buffer, filename, mimeType }) — PDF.js / mammoth / TXT
  documentStorage.js             Storage adapter interface + local filesystem adapter
  documentNormalizer.js          Persisted Document -> SourceRecordCandidate
  documentProcessingService.js   processDocumentUpload(): the pipeline
```

### Validation

A file is accepted only if extension, client MIME type and content all agree:

| Format | Extension | Accepted MIME                                   | Content check |
|--------|-----------|-------------------------------------------------|---------------|
| PDF    | `.pdf`    | `application/pdf`, `application/x-pdf`          | `%PDF-` in first 1 KiB, then a full PDF.js parse |
| DOCX   | `.docx`   | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | ZIP container; every entry inflated with a hard size cap and CRC-checked; `[Content_Types].xml` must declare a WordprocessingML **document** main part that exists; macro-enabled (`.docm`), templates and `vbaProject.bin` rejected; plain ZIPs rejected |
| TXT    | `.txt`    | `text/plain` (parameters ignored)               | Strict UTF-8 (BOM optional) or UTF-16 LE/BE with BOM; NUL/binary content and PDF/ZIP signatures rejected |

Also: missing/empty files, size > `maxBytes` (default 10 MiB, `DOCUMENT_MAX_BYTES`),
filenames with path separators, `..`, or > 255 chars. ZIP limits: 2000 entries, 50 MiB
total inflated, no ZIP64 / encryption / multi-disk / unsafe entry names.

### Extraction

`extractDocumentText({ buffer, filename, mimeType, limits })` returns
`{ extractedText, detectedFormat, status: 'extracted' | 'empty', metadata }`.

- **PDF** (pdfjs-dist, `isEvalSupported: false`): text per page, pages separated by a blank
  line; `pageCount`; max 1000 pages. No OCR — scanned PDFs return `status: 'empty'`.
  Encrypted → `ENCRYPTED_DOCUMENT`; unparseable → `MALFORMED_DOCUMENT`.
- **DOCX** (mammoth `extractRawText`): paragraphs separated by a blank line. Only runs after
  ZIP inspection has bounded every entry. Unparseable XML → `MALFORMED_DOCUMENT`.
- **TXT**: strict decoding; invalid encodings → `UNSUPPORTED_ENCODING` (never guessed).
- All: CRLF/CR → LF, trailing spaces trimmed, 3+ newlines → 2, control characters removed;
  text limit 1,000,000 characters (= SourceRecord content limit) → `TEXT_TOO_LARGE`.
- `empty` (valid document, no text) is distinct from a thrown parse failure.

### Storage

Adapter interface: `put({ buffer, extension }) -> { key, storageRef, warnings }`,
`delete(key)`, `read(key)`. `createLocalDocumentStorage({ rootDir })` (default
`<os tmpdir>/relay-documents`, `DOCUMENT_STORAGE_DIR`) writes `<uuid>.<ext>` via a temp
file + hard link (never overwrites), mode 0600, and never exposes paths.

**Limitations:** local storage is not durable on Vercel (ephemeral, per-instance `/tmp`) or
multi-instance hosts. The Document schema's `storageRef.provider` enum is
`'vercel-blob' | 's3' | 'none'` with no `'local'`, so local files are recorded as
`{ provider: 'none', key: '<uuid>.<ext>', url: '' }`. A Vercel Blob / S3 adapter with the same
interface is needed for production. Extracted text is stored in MongoDB regardless.

### Pipeline: `processDocumentUpload(...)`

validate → SHA-256 → extract → identical-content check → store file → `Document.create`
→ normalize → `persistSourceRecordCandidates`.

```javascript
import { processDocumentUpload, createLocalDocumentStorage } from './documents/index.js';

const result = await processDocumentUpload({
  projectId: req.project._id,     // from attachProject() — never from the request body
  uploadedBy: req.user._id,       // from requireAuth
  file: { buffer, filename: originalName, mimeType },
  title,                          // optional; defaults to the filename without extension
  storage: createLocalDocumentStorage({ rootDir: config.documents.storageDir || undefined }),
  duplicatePolicy: 'reuse',       // or 'allow'
  limits: { maxBytes: config.documents.maxBytes },
});
// result.status: 'succeeded' | 'duplicate' | 'partial' | 'failed'
```

Result: `{ status, stage, projectId, document: { id, title, filename, mimeType, size,
storageProvider, createdAt }, contentHash, extraction, duplicateOf, sourceRecord
(persistence result), persisted: { file, document, sourceRecord }, errors[{ stage, code,
message }], warnings, reconciliation, startedAt, completedAt }`.

| Failure stage | Outcome |
|---------------|---------|
| validation / extraction / duplicate_check | `failed`; nothing stored or persisted |
| storage | `failed`; no Document; adapter removed its temp file |
| document | `failed`; the newly stored file is deleted; if that fails: `CLEANUP_FAILED` + `reconciliation: { action: 'delete_orphaned_file', storageKey }` |
| source_record | `partial`; Document and file kept; `reconciliation: { action: 'retry_source_record', documentId, contentHash }` — retry with `persistDocumentSourceRecord({ document, extraction, contentHash })` using the stored Document and its `extractedText` |

### Document ↔ SourceRecord

`provider: 'document'`, `type: 'document'`, `externalId` = the Document's `_id` (one
SourceRecord per upload instance), `title`, `content` = extracted text,
`metadata.sourceCreatedAt/sourceUpdatedAt` = Document timestamps,
`metadata.authorId` = uploader, `metadata.extractionStatus` = `extracted | empty`,
`metadata.providerMetadata = { documentId, filename, mimeType, size, contentHash,
contentHashAlgorithm: 'sha256', detectedFormat, characterCount, pageCount?, encoding?,
storageProvider, uploadedBy }`.

### Identical content and versions

- The Document schema has no hash field, so the SHA-256 lives in
  `SourceRecord.metadata.providerMetadata.contentHash`.
- `duplicatePolicy: 'reuse'` (default): identical bytes already ingested **in the same
  project** → `status: 'duplicate'` with `duplicateOf`; nothing new is stored.
  `'allow'` always creates a new instance.
- Same filename with different bytes → a new Document and SourceRecord; nothing is
  overwritten. Filenames never identify documents.
- No version chain: uploads are independent instances (no "v2 of document X" link).
  The duplicate check is not atomic (no unique index on the hash), so two concurrent
  identical uploads can both be stored, and a `partial` upload (no SourceRecord) is not
  seen by later duplicate checks.


---

## 10. Read APIs (Phase 7)

All routes live in `src/routes/ingestion.js`, are mounted under `/api/projects`, and run
`requireAuth` → ObjectId validation → `attachProject()` → `requireRole('viewer')`.
Viewer, member and owner may all read. Non-members and unknown projects get `404`
(project existence is not leaked); a missing/invalid bearer token gets `401`.
Every query is scoped to the authorized project; no client filter object reaches MongoDB.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/projects/:id/source-records` | Paginated list (no `content`) |
| GET | `/api/projects/:id/source-records/:recordId` | One record incl. `content` and redacted provider metadata |
| GET | `/api/projects/:id/documents` | Paginated Document metadata + processing status |
| GET | `/api/projects/:id/documents/:documentId` | One Document's metadata |
| GET | `/api/projects/:id/ingestion/status` | Supported/connected providers, record counts |

**Pagination** (list endpoints): `page` (default 1, max 10000) and `limit` (default 20,
max 100); positive integers only. Order is `createdAt desc, _id desc`. Response:
`{ items: [...], pagination: { page, limit, total, totalPages, hasNextPage } }`.

**Filters** (`source-records` only): `provider` ∈ `github|document|notion|jira|slack`,
`type` ∈ `repository|issue|pull_request|commit|document|note|decision|message`.
Only ingestion providers are listed; `manual` notes/decisions (notes API) are excluded.

**Errors**: `400 {error:'validation_error', message}` (bad ids, page/limit, filters, repeated
params), `401 unauthorized`, `404 not_found`, `500 {error:'internal_error', message:'Internal server error'}`.

```jsonc
// GET /api/projects/:id/source-records?provider=github&limit=1
{ "items": [{ "id": "…", "projectId": "…", "provider": "github", "type": "issue",
    "externalId": "acme/app#12", "title": "…", "url": "https://…", "author": "alice",
    "sourceCreatedAt": "…", "sourceUpdatedAt": "…", "fetchedAt": "…",
    "extractionStatus": null, "createdAt": "…", "updatedAt": "…" }],
  "pagination": { "page": 1, "limit": 1, "total": 7, "totalPages": 7, "hasNextPage": true } }
```
The detail response is `{ item }` with the same fields plus `content`, `contentType`,
`version`, `isActive`, `isDeleted`, and `metadata` (provider metadata with any key matching
token/secret/password/credential/authorization/api key/private key/cookie/path removed).

```jsonc
// GET /api/projects/:id/documents/:documentId  -> { item }
{ "id": "…", "projectId": "…", "title": "Sprint 12 handoff", "filename": "handoff.txt",
  "mimeType": "text/plain", "size": 1234, "uploadedBy": "…", "storageProvider": "none",
  "url": null,
  "processing": { "status": "indexed", "extractionStatus": "extracted",
    "sourceRecordId": "…", "contentHash": "<sha256>", "characterCount": 980, "pageCount": null },
  "createdAt": "…", "updatedAt": "…" }
```
The Document schema has no status field. A stored Document has already been validated and
extracted; `processing.status` is `indexed` when its `document` SourceRecord exists and
`pending_indexing` when it does not (a `partial` upload awaiting retry). Storage keys/paths,
file bytes and `extractedText` are never returned by the document endpoints (the SourceRecord
detail endpoint returns the normalized text, like the existing context APIs).

```jsonc
// GET /api/projects/:id/ingestion/status
{ "projectId": "…",
  "providers": [{ "provider": "github", "supported": true, "connected": false,
                  "connectionCount": 0, "recordCount": 0 } /* jira, notion, slack */],
  "documents": { "available": true, "uploadEndpoint": "/api/projects/:id/documents",
                 "maxFileBytes": 10485760, "supportedFormats": ["pdf","docx","txt"], "recordCount": 3 },
  "totalRecords": 3 }
```
`connected` is true only if a persisted `SourceConnection` exists for the project and provider;
connection `config` is never read or returned.

### Not implemented: GitHub sync endpoint

There is deliberately no `POST …/github/sync`. `syncGitHubSourceConnection` still works
internally, but nothing creates or verifies a project↔GitHub installation/repository
`SourceConnection` (its `{ installationId, owner, repo }` config is "proposed; Person 2 to
confirm"), so an endpoint would have to trust caller-supplied owner/repo. **Decision needed
from Person 2:** an authenticated owner-only flow (e.g. GitHub App install callback with a
signed `state` bound to user + project) that writes `SourceConnection{ provider:'github',
config:{ installationId, owner, repo } }` after verifying the installation grants access to
that repo. Sync can then be a member-role `POST` that loads the connection by project.

### Security note (outside this phase)

`requireAuth` (`src/middleware/auth.js`) accepts an `x-user-id` header as identity when no
bearer token is sent. The Phase 7 routes do not rely on or extend this; it should be removed
or gated to `NODE_ENV=test` as a separate fix.
