# Notion Integration Setup & Reference

This document outlines the architecture, setup requirements, required permissions, and testing instructions for the Notion data connector.

---

## 1. Overview

The Notion connector enables ingesting authorized pages, child block hierarchies, and databases into the common normalized `SourceRecord` schema for downstream continuity tracking, AI context extraction, and handoff synthesis.

Key features:
- **Zero third-party SDK dependencies**: Implemented using Node's native `fetch` against the official Notion REST API (`https://api.notion.com/v1`, version `2022-06-28`).
- **Resilient Retry & Backoff**: Integrates with exponential backoff retries for transient HTTP errors (`429 Rate Limit`, `5xx`), honoring Notion's `Retry-After` headers.
- **Fail-Fast Permanent Errors**: Distinguishes permanent permission errors (`401 Unauthorized`, `403 Forbidden`, `404 Object Not Found / Unshared Page`) and avoids indefinite retry loops.
- **Deep Hierarchical Extraction**: Recursively traverses nested Notion block trees (headings, paragraphs, to-dos, toggles, quotes, callouts, tables, code blocks, bookmarks) with cursor pagination and recursion depth caps.
- **Provenance & Source References**: Preserves original Notion UUIDs (`externalId`, `sourceId`), source URLs, authors, and observed edit timestamps.
- **Strict Normalized Mapping**: Transforms Notion pages into validated `SourceRecord` objects adhering to `validateSourceRecord()`.

---

## 2. Environment Configuration

Set the following environment variable in your `.env` file or hosting environment:

| Variable Name | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `NOTION_API_KEY` | Yes | Internal Integration secret token | `secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxx` |

> [!IMPORTANT]
> Never commit real secret tokens or `.env` files into source control. Always store integration tokens securely.

---

## 3. Notion Integration Setup & Permissions

To connect a workspace:

1. **Create an Internal Integration**:
   - Go to [Notion Developers: My Integrations](https://www.notion.so/my-integrations).
   - Click **+ New integration**.
   - Set the associated Notion workspace.
2. **Configure Integration Capabilities**:
   - Under **Capabilities**:
     - `Read content`: **Enabled** (Required to fetch pages and block hierarchies).
     - `Read user information without email addresses` or `with email addresses`: **Enabled** (Used to map page authors).
3. **Share Pages with the Integration**:
   - Notion's security model requires workspace members to explicitly grant access to specific pages or databases.
   - In Notion, open any target page or database -> click `•••` (More options) -> click **Connect to** -> select your integration.
   - Any child pages nested beneath a shared page automatically inherit read access.
   - Note: Attempting to access an unshared page will return an HTTP 404 or 403, which the connector safely classifies as `NotionPermissionError`.

---

## 4. Architecture & Module Boundaries

The Notion integration is located under [`src/integrations/notion/`](file:///Backend/src/integrations/notion/):

- [`client.js`](file:///Backend/src/integrations/notion/client.js): Authenticated HTTP client with transient retry handling, rate limiting, and error classifications (`NotionAuthenticationError`, `NotionPermissionError`, `NotionRateLimitError`, `NotionClientError`).
- [`extractor.js`](file:///Backend/src/integrations/notion/extractor.js): Pure block and rich-text parsing functions. Converts Notion blocks (headings, code, lists, to-dos, quotes, toggles, callouts) into markdown representation. Recursively traverses nested child blocks (`extractBlockHierarchy`).
- [`normalizer.js`](file:///Backend/src/integrations/notion/normalizer.js): Maps Notion page objects and database rows into the canonical `SourceRecord` schema (`normalizeNotionPage`, `normalizeDatabaseRow`, `parseNotionId`).
- [`connector.js`](file:///Backend/src/integrations/notion/connector.js): High-level integration facade (`NotionConnector`) providing `fetchPage`, `fetchDatabase`, and `syncAuthorizedWorkspace`.
- [`index.js`](file:///Backend/src/integrations/notion/index.js): Public barrel export for the module.

---

## 5. Local Testing

The entire Notion test suite uses offline mocked HTTP responses and does not require active network connections or real Notion credentials.

Run only the Notion integration tests:
```bash
npm test -- tests/integrations/notion.test.js
```
Or directly using Node test runner:
```bash
node --test tests/integrations/notion.test.js
```

Run all project tests (notification service, persistence, APIs, reliability, and integrations):
```bash
npm test
```

### Covered Test Cases:
1. Successful page retrieval and markdown transformation.
2. Supported database retrieval and property extraction (`status`, `select`, `date`, `tags`, etc.).
3. Block and database pagination across multiple cursor pages without truncation.
4. Nested block hierarchy extraction with indented formatting.
5. Graceful handling of empty pages and unsupported block types.
6. Validation against the normalized `SourceRecord` contract.
7. Original source ID, URL, and provenance preservation.
8. Missing credentials and authentication failures (`NotionAuthenticationError`).
9. Unshared page and permission failures (`NotionPermissionError`).
10. Rate limiting (HTTP 429) backoff retries and exhausted retry exceptions (`NotionRateLimitError`).
11. Malformed non-JSON responses and 5xx server errors.
12. Workspace discovery of all explicitly shared pages.
