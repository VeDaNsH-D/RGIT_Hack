# Jira Integration Setup & Reference

This document outlines the architecture, authentication configuration, required permissions, pagination, and testing instructions for the Jira data connector.

---

## 1. Overview

The Jira connector enables ingesting authorized Jira projects and issues into the common normalized `SourceRecord` and `SourceRecordCandidate` schemas for downstream continuity tracking, AI context extraction, and handoff synthesis.

Key features:
- **Zero third-party SDK dependencies**: Implemented using Node's native `fetch` against the official Jira REST API (`https://<domain>.atlassian.net/rest/api/3` or version `2`).
- **Flexible Authentication**: Supports both Jira Cloud Basic Auth (`email` + `apiToken`) and Bearer/OAuth/PAT tokens (`apiToken`).
- **Rich-Text & ADF Extraction**: Safely parses Atlassian Document Format (ADF) block trees (headings, paragraphs, bullet/ordered lists, code blocks, blockquotes, mentions, marks) into clean, standard Markdown.
- **Accurate Provenance**: Preserves original Jira issue keys (`PROJ-101`), numeric IDs, canonical browse URLs (`https://<domain>/browse/PROJ-101`), project associations, assignees, reporters, and created/updated timestamps.
- **Honest Deadlines**: Accurately maps `duedate` when provided; strictly never fabricates or hallucinates missing deadlines.
- **Resilient Retry & Backoff**: Integrates with `withRetry` for transient HTTP errors (`429 Rate Limit`, `5xx`), honoring Jira's `Retry-After` headers.
- **Fail-Fast Error Handling**: Maps permanent errors (`401 Unauthorized`, `403 Forbidden`, `404 Not Found`) into typed exceptions without indefinite retry loops.
- **Controlled Pagination**: Implements offset-based pagination (`startAt`, `maxResults`, `total`) preventing infinite loops and excessive resource ingestion.

---

## 2. Environment Configuration

Set the following environment variables in your `.env` file or deployment environment:

| Variable Name | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `JIRA_HOST` | Yes | Jira Cloud instance domain | `https://my-company.atlassian.net` |
| `JIRA_API_TOKEN` | Yes | Atlassian API token or Personal Access Token | `ATATT3xFfGF0...` |
| `JIRA_EMAIL` | Optional* | Atlassian account email (*required for Jira Cloud Basic Auth) | `developer@example.com` |
| `JIRA_PROJECT_KEY` | Optional | Default project key to query or filter | `RELAY` |

> [!IMPORTANT]
> Never commit real API tokens or `.env` files into source control. Always store integration secrets securely.

---

## 3. Jira Permissions & Token Generation

1. **Generate an API Token**:
   - Log into your Atlassian account.
   - Navigate to **[Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens)**.
   - Click **Create API token**, label it (e.g. `Relay Jira Integration`), and copy the generated token.
2. **Project Permissions**:
   - Ensure the authenticated account has at least **Browse Projects** (`BROWSE_PROJECTS`) permission in Jira for the target projects.
   - The connector only queries projects and issues authorized for the connected account.

---

## 4. Architecture & Module Boundaries

The Jira integration is located under:
- `src/modules/ingestion/providers/jira/` (Core ingestion provider):
  - `jiraClient.js`: Authenticated HTTP transport client with Basic/Bearer auth, rate limit parsing, and error mapping.
  - `jiraExtractor.js`: ADF node parser and rich-text converter.
  - `jiraNormalizer.js`: Pure normalization functions mapping Jira issues into canonical records.
  - `jiraConnector.js`: High-level connector orchestration (`fetchIssues`, `fetchIssue`, `getProjects`).
  - `jiraErrors.js`: Domain error hierarchy (`JiraAuthenticationError`, `JiraPermissionError`, `JiraNotFoundError`, `JiraRateLimitError`).
- `src/integrations/jira/` (Integration facade):
  - Re-exports matching the existing `src/integrations/notion/` contract.

---

## 5. Local Testing

All automated tests use mocked Jira REST API responses and do not require live credentials:

```bash
# Run Jira integration test suite
node --test tests/integrations/jira.test.js

# Run all project tests
npm test
```
