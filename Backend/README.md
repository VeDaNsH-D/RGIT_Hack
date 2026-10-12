# Relay Backend

Core backend for **Relay**: structured handoffs between project owners,
with completeness validation before a handoff can complete, atomic
ownership transfer on acknowledgement, and a tamper-evident audit trail.

This is Person 2's module (database, handoff workflow, completeness
validation, audit history, auth/access control). GitHub/document ingestion
(Person 1), AI summaries/conflict detection (Person 3), and notification
delivery (Person 4, in `src/notifications/`) plug into the interfaces
documented here.

## Setup

```bash
cd Backend
npm install
cp .env.example .env   # fill in the values below
npm run dev            # http://localhost:8000 (or PORT from .env)
```

`npm run seed` populates a demo project ("Project Atlas") — see
[Known limitations](#known-limitations) and the seed script
(`scripts/seed.js`) for details; it's safe to re-run.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | yes | MongoDB connection string. **Must be a replica set** (e.g. any MongoDB Atlas cluster) for the handoff-acknowledgement transaction to run atomically — see the Vercel/Atlas note below. |
| `JWT_SECRET` | yes | ≥ 32 characters. Signs both login JWTs and the stateless OAuth `state` parameter. |
| `CRON_SECRET` | yes | Bearer token required on `GET /api/cron/overdue`. |
| `FRONTEND_URL` | no | Added to the CORS allowlist; OAuth callbacks redirect here with `?token=<jwt>`. |
| `CORS_ORIGINS` | no | Comma-separated extra allowed origins, in addition to `FRONTEND_URL`. |
| `API_BASE_URL` | no | Public base URL of this API; used to build the OAuth callback URL. Defaults to `http://localhost:<PORT>`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Google OAuth is disabled automatically if either is missing. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | Same, for GitHub. |
| `ACK_SLA_HOURS` | no (default `48`) | Hours a `SUBMITTED` handoff can wait before the cron job flags it overdue. |
| `PORT` | no (default `8000`) | Local dev server port. |
| `MONGODB_URI_TEST` | no | Not currently required — the one test that needs full DB isolation (`test/integration/atlas-e2e.test.js`) uses an in-memory MongoDB replica set via `mongodb-memory-server` instead. Kept as an escape hatch if that ever needs to point at a real DB (e.g. a locked-down CI with no internet egress to download the MongoDB binary). |

`src/config.js` fails fast at boot if `MONGODB_URI`, `JWT_SECRET`, or
`CRON_SECRET` is missing, or `JWT_SECRET` is under 32 characters.

## Running tests

```bash
npm test
```

Runs everything under `test/` via Node's built-in test runner. This
includes:
- Pure unit tests (lifecycle state machine, completeness validator, audit
  hash chain, Zod contracts) — no DB needed.
- Integration tests against your configured `MONGODB_URI` (routes, access
  control, cron, conflicts, notifications-delivery adapter). These create
  and clean up their own throwaway data.
- One fully self-contained end-to-end test
  (`test/integration/atlas-e2e.test.js`) that spins up its own disposable
  MongoDB **replica set** in-memory via `mongodb-memory-server` — chosen
  over a standalone instance specifically so the acknowledge step's
  transaction runs for real. No environment variables needed for this one;
  if `mongodb-memory-server` can't download its MongoDB binary (e.g. no
  internet egress in some CI environments), point it at `MONGODB_URI_TEST`
  instead.

Person 4's notification module has its own test suite under `tests/`
(note: different directory than Person 2's `test/`), run separately or
together — `package.json`'s `test` script covers both.

## Deployment (Vercel)

- `api/index.js` is the serverless entrypoint; `vercel.json` rewrites
  `/api/*` to it and defines the daily cron (`0 0 * * *`) hitting
  `/api/cron/overdue`. **Hobby plans only allow daily crons** — if you need
  more frequent overdue checks, upgrade the plan or trigger the endpoint
  externally.
- Set every variable from the table above in the Vercel project's
  environment settings (all environments you deploy to).
- **Use a MongoDB Atlas cluster, not a standalone `mongod`.** Atlas
  clusters are replica sets by default, which is required for the
  handoff-acknowledgement transaction (`withTx()` in `src/db.js`) to be
  atomic. Against a standalone instance, `withTx()` detects the lack of
  replica-set support and falls back to a non-atomic path (logging a
  one-time warning) — functionally works, but loses the atomicity
  guarantee on ownership transfer.
- The Mongo connection is cached on `globalThis` across warm serverless
  invocations (`src/db.js`) — never assume in-memory state survives a cold
  start otherwise.

## Handoff state machine

```
DRAFT ──SUBMIT(blocked)──> EDITING ──SUBMIT(blocked)──┐
  │                           │  ▲                     │
  │ SUBMIT(ready)             │  │ RESPOND              │
  ▼                           ▼  │                      ▼
SUBMITTED ──REQUEST_CLARIFICATION──> CLARIFICATION_REQUESTED
  │
  │ ACKNOWLEDGE
  ▼
ACKNOWLEDGED  (terminal)

CANCEL is legal from DRAFT, EDITING, SUBMITTED, or CLARIFICATION_REQUESTED
(outgoing owner only) -> CANCELLED (terminal)
```

- `SUBMIT` is fired by the **outgoing owner**; the pure state machine
  (`src/handoffs/lifecycle.js`) routes it to `SUBMITTED` or back to
  `EDITING` based on the validation result passed in by the caller — the
  route (`POST /api/handoffs/:id/submit`) always re-runs validation
  server-side and never trusts a client-supplied "ready" flag.
- `ACKNOWLEDGE` and `REQUEST_CLARIFICATION` are fired by the **incoming
  owner**; `RESPOND` and `CANCEL` by the **outgoing owner**.
- Every transition is applied via a conditional DB update filtered on the
  handoff's current state, so a double-click or a race between two
  requests can't apply the same transition twice — the loser gets `409`.
- Ownership (`Project.ownerId`) changes **only** on `ACKNOWLEDGE`, inside
  one MongoDB transaction that also swaps `ProjectMembership` roles and
  appends to `Project.ownershipHistory`. The outgoing owner remains the
  accountable project owner for everything up to that exact moment.

## Completeness validation

`src/handoffs/validation.js` (pure function, no DB/clock) runs 8 checks
against a `ValidationInput` built from live DB state by
`src/handoffs/service.js`:

| Check | Passes when | Waivable? |
|---|---|---|
| `project_exists` | The project exists. | **Never** |
| `incoming_owner_specified` | `toUserId` is set and differs from `fromUserId`. | **Never** |
| `current_status_documented` | `currentStatus` is a non-blank string. | yes |
| `pending_actions_listed` | `items[]` is non-empty, OR there's at least one open task, OR `noPendingActionsConfirmed` is explicitly true. | yes |
| `task_owners_assigned` | Every open task in the project has an `assignee`. | yes |
| `mandatory_deadlines_present` | Every open `high`/`critical` priority task has a `deadline`. | yes |
| `supporting_links_provided` | At least one supporting link or linked document. | yes |
| `critical_conflicts_reviewed` | No open conflicts with `severity` `high` or `critical`. | yes |

A failed, waivable check can be waived via
`POST /api/handoffs/:id/exceptions` (outgoing owner only, non-blank reason
required) — waived checks still count toward `score`, but are shown with
`waived: true` and their reason, and every exception is audited. The two
non-waivable checks reject an exception attempt even if submitted.

`validateHandoff()` returns:
```json
{
  "ready": false,
  "score": 75,
  "missingFields": ["supporting_links_provided"],
  "checks": [
    { "name": "project_exists", "passed": true, "waived": false, "reason": "", "waivedReason": "" },
    "... one entry per check ..."
  ]
}
```

## API reference

All routes except `/api/health`, `/api/auth/register`, `/api/auth/login`,
and the OAuth routes require `Authorization: Bearer <jwt>`. Project-scoped
routes return **404** (not 403) for a non-member, so project existence is
never leaked; a member with too low a role gets **403**.

### Auth

| Method & path | Access | Notes |
|---|---|---|
| `POST /api/auth/register` | public | `{ email, password (≥8 chars), name }` → `{ token, user }` |
| `POST /api/auth/login` | public, rate-limited (20/15min per instance) | `{ email, password }` → `{ token, user }`; generic `401` on any bad credential |
| `GET /api/auth/me` | authenticated | → `{ user: { id, email, name, lastLoginAt } }` |
| `GET /api/auth/oauth/:provider` | public | `provider` is `google` or `github`; `404` if disabled (missing client id/secret) or unknown. Redirects to the provider. |
| `GET /api/auth/oauth/:provider/callback` | public (state-verified) | Stateless `state` JWT (5 min expiry, bound to provider) prevents CSRF/replay without server-side session storage. Redirects to `FRONTEND_URL?token=<jwt>`. |

Example:
```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alex@atlas-demo.example","password":"AtlasDemo123!"}'
# -> {"token":"eyJ...","user":{"id":"...","email":"...","name":"..."}}
```

### Projects & members

| Method & path | Access | Notes |
|---|---|---|
| `POST /api/projects` | authenticated | `{ name, description? }` → creates project, caller becomes `owner` |
| `GET /api/projects` | authenticated | Lists only the caller's projects, with `myRole` |
| `GET /api/projects/:id` | viewer+ | |
| `PATCH /api/projects/:id` | owner only | `{ name?, description? }`, at least one field |
| `GET /api/projects/:id/ownership-history` | viewer+ | Resolves `fromUser`/`toUser` to `{id, name, email}` |
| `POST /api/projects/:id/members` | owner only | `{ email, role: 'viewer'\|'member' }` — owner is never grantable here |
| `GET /api/projects/:id/context` | viewer+ | Single aggregated view for a new owner: project, members, tasks (with `overdue` flags), document metadata (no text/storage internals), non-manual source record metadata, `decisions`/`notes` (manual records — decisions include `content`, notes don't), open conflicts, the active handoff, counts |
| `GET /api/projects/:id/source-records` | member+ | Filters `?provider=&type=`, paginated, **includes full `content`** — the raw read endpoint for Person 3 |

### Tasks

| Method & path | Access | Notes |
|---|---|---|
| `POST /api/projects/:id/tasks` | member+ | `{ title, description?, assignee?, deadline?, priority? }`; `origin` is always forced to `manual` server-side; `assignee` must be a project member |
| `GET /api/projects/:id/tasks` | viewer+ | Filters `?status=&assignee=&overdue=true\|false`, paginated |
| `PATCH /api/tasks/:id` | member+ | Completing (`status: 'completed'`) sets `completedAt`; reopening clears it. Imported tasks (`origin: 'imported'`) are never written back to their source — this route only ever touches the `Task` document. |

### Manual decisions & notes

Stored as `SourceRecord` documents with `provider: 'manual'` — no separate
model.

| Method & path | Access | Notes |
|---|---|---|
| `POST /api/projects/:id/notes` | member+ | `{ recordType: 'decision'\|'note', title, content?, observedAt?, url? }` |
| `GET /api/projects/:id/notes` | viewer+ | Filters `?recordType=`, paginated, newest first |
| `PATCH /api/notes/:id` | author or project owner only | `404` if the record isn't `provider: 'manual'` (never touches GitHub/document records) |
| `DELETE /api/notes/:id` | author or project owner only | Same `404` guard |

### Handoffs

| Method & path | Access | Notes |
|---|---|---|
| `POST /api/projects/:id/handoffs` | current project owner only | `{ toUserId }`; `409` if an open handoff already exists for the project |
| `GET /api/projects/:id/handoffs` | viewer+ | |
| `GET /api/handoffs/:id` | viewer+ | |
| `PATCH /api/handoffs/:id` | outgoing owner, `DRAFT`/`EDITING` only | `{ currentStatus?, items?, noPendingActionsConfirmed?, supportingLinks?, documentIds? }`. An `items[].sourceRecordId` must reference a `SourceRecord` in the **same project** (`400` otherwise). |
| `POST /api/handoffs/:id/validate` | outgoing owner | Re-runs validation, stores `lastValidation`, doesn't change state |
| `POST /api/handoffs/:id/exceptions` | outgoing owner, `DRAFT`/`EDITING` only | `{ checkName, reason }`; `400` if the check isn't currently failing or is non-waivable |
| `POST /api/handoffs/:id/submit` | outgoing owner | Always re-validates server-side; adds the recipient as a `viewer` member on success; response includes the full validation result regardless of outcome |
| `POST /api/handoffs/:id/acknowledge` | incoming owner, `SUBMITTED` only | Atomic: handoff → `ACKNOWLEDGED`, ownership transferred, membership roles swapped, `ownershipHistory` appended |
| `POST /api/handoffs/:id/clarify` | incoming owner, `SUBMITTED` only | `{ note }` → `CLARIFICATION_REQUESTED` |
| `POST /api/handoffs/:id/respond` | outgoing owner, `CLARIFICATION_REQUESTED` only | `{ note }` → `EDITING` (resubmit required) |
| `POST /api/handoffs/:id/cancel` | outgoing owner, any open state | → `CANCELLED` (terminal) |
| `GET /api/handoffs/:id/activity` | viewer+ | Audit events scoped to this handoff |

Example — blocked submit:
```json
POST /api/handoffs/<id>/submit
{}
```
```json
{
  "handoff": { "id": "...", "state": "EDITING", "...": "..." },
  "validation": {
    "ready": false,
    "score": 63,
    "missingFields": ["task_owners_assigned", "supporting_links_provided"],
    "checks": ["..."]
  }
}
```

### Conflicts (Person 3 contract)

| Method & path | Access | Notes |
|---|---|---|
| `POST /api/projects/:id/conflicts` | member+ | See the candidate contract below |
| `GET /api/projects/:id/conflicts` | viewer+ | Filters `?status=`, includes evidence |
| `POST /api/conflicts/:id/review` | member+ | `open → reviewed`, `409` otherwise |
| `POST /api/conflicts/:id/resolve` | member+ | `{ outcome: 'resolved'\|'dismissed', note }`, `{open,reviewed} → outcome`, `409` otherwise |

**Conflict candidate contract** — what Person 3's module should POST to
`/api/projects/:id/conflicts`:
```json
{
  "title": "Conflicting deployment dates",
  "description": "Doc A says March 1, Doc B says March 15",
  "severity": "critical",
  "fingerprint": "optional-stable-id-you-computed",
  "evidence": [
    { "sourceType": "document", "sourceRecordId": "...", "excerpt": "Deploy on March 1" },
    { "sourceType": "document", "sourceRecordId": "...", "excerpt": "Deploy on March 15" }
  ]
}
```
- `evidence` needs **at least 2** items.
- If `fingerprint` is omitted, one is computed deterministically from
  `{title, sorted evidence excerpts}` — an exact resubmission dedupes
  (returns the existing conflict, `200`, `deduped: true`, no new evidence
  created) rather than erroring or duplicating.
- `severity: 'critical'` emits `CRITICAL_CONFLICT_DETECTED` to the project
  owner; other severities are stored silently (no notification).
- An open `high`/`critical` conflict blocks `critical_conflicts_reviewed`
  until it's reviewed or resolved.

### Cron

| Method & path | Access | Notes |
|---|---|---|
| `GET /api/cron/overdue` | `Authorization: Bearer CRON_SECRET` (constant-time compared) | Finds open tasks past `deadline` and `SUBMITTED` handoffs past `ACK_SLA_HOURS`; claims each atomically (conditional update) so overlapping runs can't double-alert; reminders repeat at most once per 24h. Returns `{ processed: { overdueTasks, overdueHandoffs } }`. |

### Notifications (Person 4's module)

Owned and implemented by Person 4 (`src/notifications/`): `GET
/api/notifications`, `GET /api/notifications/unread-count`, `PATCH
/api/notifications/:id/read`, `PATCH /api/notifications/read-all`. Not
documented further here — see that module directly.

## Notification event contract (for Person 4)

`emitNotificationEvent(event)` (`src/notifications/emitEvent.js`) is the
single entrypoint the rest of this backend uses to raise a notification.
It validates against this 8-type contract (`notificationEventSchema` in
`src/contracts/schemas.js`), then dispatches to all registered handlers
via `Promise.allSettled` — one handler failing never breaks another or the
caller.

```ts
{
  type: 'HANDOFF_SUBMITTED' | 'HANDOFF_ACKNOWLEDGED' | 'HANDOFF_NEEDS_CLARIFICATION' |
        'HANDOFF_CLARIFICATION_ANSWERED' | 'HANDOFF_ACK_OVERDUE' | 'TASK_OVERDUE' |
        'CRITICAL_CONFLICT_DETECTED' | 'CONFLICT_RESOLVED',
  projectId?: string | null,   // 24-char hex ObjectId, or null for system-level events
  recipientUserId: string,     // 24-char hex ObjectId
  payload?: Record<string, any>,
  dedupeKey?: string,          // used as the delivery system's idempotency key where applicable
}
```

**In-app delivery coverage:** the default handler adapts into Person 4's
in-app delivery system (`src/notifications/service.js`), which supports all 8
event types across handoffs, tasks, and conflicts.
For all 8 supported types, `event.payload` includes:

| Type | Required `payload` fields |
|---|---|
| `HANDOFF_SUBMITTED` | `entityId`, `outgoingUserId`, `handoffTitle?` |
| `HANDOFF_ACKNOWLEDGED` | `entityId`, `acceptedByUserId` (or `acknowledgedByUserId`), `notes?` |
| `HANDOFF_NEEDS_CLARIFICATION` | `entityId`, `requestedByUserId`, `clarificationNote`, `unresolvedItems?` |
| `HANDOFF_CLARIFICATION_ANSWERED` | `entityId`, `answeredByUserId`, `clarificationNote?` |
| `HANDOFF_ACK_OVERDUE` | `entityId`, `hoursOverdue?`, `handoffTitle?` |
| `TASK_OVERDUE` | `entityId`, `taskTitle?`, `dueDate?` |
| `CRITICAL_CONFLICT_DETECTED` | `entityId`, `conflictType`, `description`, `severity?`, `competingSources?` |
| `CONFLICT_RESOLVED` | `entityId`, `resolvedByUserId?`, `resolutionNotes?` |

## Source record contract (for Person 1)

Ingested items (commits, PRs, docs, tickets, ...) go in the `SourceRecord`
model, upserted by `(projectId, provider, externalId)` — re-ingestion of
the same external item must never create a duplicate:

```ts
{
  projectId: ObjectId,
  provider: string,      // e.g. 'github' — 'manual' is reserved for decisions/notes created via this backend's own /notes routes
  externalId: string,    // stable id from the source system; the upsert key together with (projectId, provider)
  type?: string,         // e.g. 'pull_request', 'commit', 'issue'
  title?: string,
  url?: string,
  content?: string,      // full text/body — returned by GET /api/projects/:id/source-records, but stripped out of GET /api/projects/:id/context
  metadata?: object,     // free-form
  isDemo?: boolean,      // required true for any seeded/demo data
}
```

Handoff items can reference a `SourceRecord` via `sourceRecordId` (e.g. to
cite a decision); the backend rejects any reference to a record in a
different project.

## Document contract (for Person 1)

The `Document` model (`src/models/Document.js`) reserves the schema for
uploaded files; this module does not implement upload or extraction.
Populate these fields when a file is uploaded and processed:

| Field | Type | Notes |
|---|---|---|
| `filename` | String | Original filename as uploaded. |
| `mimeType` | String | Detected content type. |
| `size` | Number | File size in bytes. |
| `sha256` | String | Content hash, for dedupe/integrity checks. **Not yet in the schema** — add it alongside the upload implementation. |
| `uploadedBy` | ObjectId (User) | Already required by the schema. |
| `extractionStatus` | String | e.g. `pending`/`done`/`failed`. **Not yet in the schema.** |
| `extractionError` | String | Populated when `extractionStatus` is `failed`. **Not yet in the schema.** |
| `extractedText` | String | Already in the schema with `select: false` — never returned by default queries. |
| `storageRef` | `{ provider: 'vercel-blob'\|'s3'\|'none', key, url }` | Already in the schema, defaults to `provider: 'none'`. Vercel's filesystem is ephemeral, so the actual bytes must live in one of these external stores. |

`storageRef.key`/`.url` are never included in `GET
/api/projects/:id/context` (document entries there are
title/filename/mimeType/size/uploadedBy/createdAt only); non-members get a
`404` before any document data is returned.

## Known limitations

- **Login rate limiting is in-memory and per-instance.** On serverless,
  each cold start resets the counter and concurrent instances don't share
  state — it blunts naive abuse but isn't a real distributed rate limit.
- **Cron runs at most daily on Vercel's Hobby plan.** `ACK_SLA_HOURS` and
  the 24h reminder cooldown are both independent of how often the cron
  actually fires; on Hobby, "overdue" detection has up to ~24h of slack
  beyond the configured SLA.
- **Transactions require a replica set.** Against a standalone MongoDB (no
  replica set), `withTx()` falls back to a non-atomic execution path for
  handoff acknowledgement, logging a one-time warning. Always use a real
  replica set (any MongoDB Atlas cluster) in anything beyond quick local
  testing.
- **All 8 notification event types are delivered in-app** —
  `HANDOFF_SUBMITTED`, `HANDOFF_ACKNOWLEDGED`, `HANDOFF_NEEDS_CLARIFICATION`,
  `HANDOFF_CLARIFICATION_ANSWERED`, `HANDOFF_ACK_OVERDUE`, `TASK_OVERDUE`,
  `CRITICAL_CONFLICT_DETECTED`, and `CONFLICT_RESOLVED` are validated, audited,
  and delivered as real in-app notifications.
- **OAuth token exchange is implemented but not live-tested** — no Google/
  GitHub OAuth app credentials are configured in this environment, so only
  the routing, state-verification, and tamper-rejection logic has been
  exercised; the actual provider token exchange has not.
- **Hash-chain tamper detection has one inherent blind spot:** rewriting
  only the single most recent event in a project's audit chain (nothing
  downstream yet references its hash) is undetectable by the chain alone —
  this is a fundamental limit of hash chains without an external anchor,
  not a bug.
