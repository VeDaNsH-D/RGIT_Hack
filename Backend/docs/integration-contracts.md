# Standardized External Integration Contracts

## Overview

This document specifies the common integration contracts, error taxonomy, and synchronization results implemented across all external providers (**Notion**, **Jira**, and **Slack**) in Relay's data ingestion layer.

All connectors conform to the shared `BaseConnector` contract, produce canonical `SourceRecord` / `SourceRecordCandidate` entities, and return uniform `SyncResult` envelopes without exposing provider-specific quirks or secrets to downstream systems.

---

## 1. Common Connector Interface (`BaseConnector`)

Every provider adapter inherits from `BaseConnector` (`src/integrations/common/connector.js`):

```javascript
import { BaseConnector, isConnector } from './src/integrations/common/connector.js';

class MyConnector extends BaseConnector {
  get provider() { /* 'notion' | 'jira' | 'slack' */ }
  static validateConfig(config) { /* { valid: boolean, errors: string[] } */ }
  validateConfig(config) { /* { valid: boolean, errors: string[] } */ }
  async verifyConnection() { /* { ok: boolean, error?: string, details?: object } */ }
  async sync(options) { /* returns SyncResult */ }
}
```

### Core Methods & Properties

| Member | Type | Purpose |
|---|---|---|
| `provider` | `string` (getter) | Lowercase provider identifier (`'notion'`, `'jira'`, `'slack'`). |
| `validateConfig(config)` | Method (static & instance) | Validates presence of credentials and configuration before initialization or sync. |
| `verifyConnection()` | Async method | Contacts provider API to confirm credential validity and authorization without leaking sensitive headers on failure. |
| `sync(options)` | Async method | Fetches authorized resources and returns a standardized `SyncResult`. |

---

## 2. Standardized Sync Results (`SyncResult`)

Sync operations return an immutable, standardized envelope created via `createSyncResult` (`src/integrations/common/results.js`):

```typescript
interface SyncResult {
  provider: 'notion' | 'jira' | 'slack';
  status: 'success' | 'partial' | 'empty' | 'failed';
  records: ReadonlyArray<SourceRecordCandidate | SourceRecord>;
  recordsProcessed: number;
  errors: ReadonlyArray<{
    code: string;
    message: string;
    provider: string;
    statusCode?: number;
    isTransient?: boolean;
  }>;
  cursor: string | number | null;
  hasMore: boolean;
  metadata: Readonly<Record<string, unknown>>;
  syncedAt: string; // ISO 8601 UTC timestamp
}
```

### Sync Status Rules

- **`success`**: All requested records fetched without any errors.
- **`empty`**: Zero records returned and no errors occurred (e.g. empty channel, empty database).
- **`partial`**: One or more resources/pages failed, but at least one record was successfully ingested. **Partial failures are never represented as complete success.**
- **`failed`**: Sync completely failed (fatal auth error, network down) and 0 records were ingested.

---

## 3. Standardized Error Taxonomy (`IntegrationError`)

All integration exceptions inherit from `IntegrationError` (`src/integrations/common/errors.js`):

```
IntegrationError (base)
 ├── IntegrationAuthenticationError (401 / UNAUTHORIZED)
 ├── IntegrationPermissionError     (403 / FORBIDDEN)
 ├── IntegrationRateLimitError      (429 / RATE_LIMITED, isTransient=true, retryAfter)
 ├── IntegrationNotFoundError       (404 / NOT_FOUND)
 ├── IntegrationNetworkError        (503 / NETWORK_ERROR, isTransient=true)
 ├── IntegrationResponseError       (502 / INVALID_PROVIDER_RESPONSE)
 ├── IntegrationValidationError      (400 / VALIDATION_ERROR)
 └── IntegrationUnsupportedError    (501 / UNSUPPORTED_OPERATION)
```

### Secret Sanitization
All error messages and log outputs pass through `sanitizeErrorMessage()`:
- `Bearer <token>` replaced with `Bearer [REDACTED]`
- `Basic <token>` replaced with `Basic [REDACTED]`
- Slack tokens (`xoxb-...`, `xoxp-...`) replaced with `xox[REDACTED]`
- Notion tokens (`ntn_...`, `secret_...`) replaced with `[REDACTED]`
- Jira tokens (`ATATT...`) replaced with `ATATT[REDACTED]`
- Query parameter secrets (`?token=...`, `&api_key=...`) replaced with `[REDACTED]`

---

## 4. Normalized Records and Provenance

Connectors normalize external provider entities into canonical `SourceRecordCandidate` schemas (`src/modules/ingestion/contracts/sourceRecord.js`):

| Provider | Ingested Entity | Canonical `externalId` | `recordType` | Provenance Source URL |
|---|---|---|---|---|
| **Notion** | Page / Database row | Notion UUID (`8-4-4-4-12`) | `document` | `https://notion.so/...` |
| **Jira** | Issue / Task | Issue Key (e.g. `PROJ-101`) | `issue` | `https://<host>/browse/<key>` |
| **Slack** | Message / Thread Reply | `<channelId>:<ts>` | `message` | `https://<domain>.slack.com/archives/<c>/p<ts>` |

Provenance and timestamps (`createdAt`, `updatedAt`, `fetchedAt`) are strictly preserved as valid JavaScript `Date` instances. No identifiers or timestamps are fabricated.

---

## 5. Configuration and Credentials

Credentials must never be committed to source control and are loaded via environment variables or explicitly passed in constructor options:

| Provider | Environment Variables | Permissions / Scopes Needed |
|---|---|---|
| **Notion** | `NOTION_API_KEY` or `NOTION_TOKEN` | Internal Integration with page read capability. Pages must be explicitly shared with the integration. |
| **Jira** | `JIRA_HOST` (or `JIRA_BASE_URL`), `JIRA_API_TOKEN` (or `JIRA_TOKEN`), `JIRA_EMAIL` | Atlassian API Token with `read:jira-work` scope. |
| **Slack** | `SLACK_BOT_TOKEN` (or `SLACK_TOKEN`), `SLACK_WORKSPACE_DOMAIN` | Bot User Token with `channels:history`, `channels:read`, `groups:history`, `chat:write`. Bot must be a member of private channels. |

---

## 6. Pagination & Rate Limiting Guidelines

1. **Notion**: Cursor-based pagination (`start_cursor` / `next_cursor`). Follows 3 req/sec rate guidance. 429 responses map to `IntegrationRateLimitError` with bounded retry.
2. **Jira**: Offset-based pagination (`startAt` / `maxResults`). Respects Jira Cloud REST API limits.
3. **Slack**: Cursor-based pagination (`cursor` / `response_metadata.next_cursor`). Respects Tier 3 / Tier 4 Web API rate limits.
