# Slack Integration Setup & Reference

This document outlines the architecture, configuration requirements, required OAuth scopes, channel selection, and testing instructions for the Slack data connector.

---

## 1. Overview

The Slack connector enables ingesting authorized Slack channels, messages, and thread replies into the common normalized `SourceRecord` and `SourceRecordCandidate` schemas for downstream continuity tracking, AI context extraction, and handoff synthesis.

Key features:
- **Zero third-party SDK dependencies**: Implemented using Node's native `fetch` against the official Slack Web API (`https://slack.com/api`).
- **Channel Selection & Boundary Enforcement**: Restricts ingestion to explicitly configured channels rather than indiscriminately scraping workspace content.
- **Thread Reply Extraction**: Supports retrieving parent messages and nested thread replies (`conversations.replies`) without duplicating parent entries.
- **Cursor-based Pagination**: Handles Slack's cursor pagination (`response_metadata.next_cursor`) with configurable page limits (`maxPages`, `perPage`).
- **Rich Text & Entity Unescaping**: Unescapes Slack entity mentions (`<@U123>`, `<#C123|name>`), formatted links (`<url|label>`), and Block Kit content into standard Markdown.
- **Accurate Provenance**: Preserves original workspace team ID, channel ID, message `ts`, thread `thread_ts`, author user ID, and web archive permalinks.
- **Resilient Retry & Backoff**: Integrates with `withRetry` for transient HTTP/payload errors (`ratelimited`, `429 Rate Limit`, `5xx`), honoring Slack's `Retry-After` headers.
- **Fail-Fast Error Handling**: Maps permanent errors (`not_authed`, `invalid_auth`, `missing_scope`, `not_in_channel`, `channel_not_found`) into typed exceptions without indefinite retry loops.
- **Content Safety**: Strictly treats message text as untrusted data for analysis; never executes instructions contained in messages.

---

## 2. Environment Configuration

Set the following environment variables in your `.env` file or hosting environment:

| Variable Name | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `SLACK_BOT_TOKEN` | Yes | Slack Bot User OAuth Token (`xoxb-...`) | `xoxb-1234567890-...` |
| `SLACK_DEFAULT_CHANNEL_ID` | Optional | Default channel ID to ingest from | `C0123456789` |
| `SLACK_WORKSPACE_DOMAIN` | Optional | Slack workspace subdomain for permalinks | `myteam` or `myteam.slack.com` |

> [!IMPORTANT]
> Never commit real bot tokens or `.env` files into source control. Always store integration secrets securely.

---

## 3. Required Slack OAuth Scopes

When creating a Slack App in the [Slack API Dashboard](https://api.slack.com/apps), add the following **Bot Token Scopes** under **OAuth & Permissions**:

1. `channels:history` – View messages and threads in public channels the bot has been added to.
2. `channels:read` – View basic info about public channels.
3. `groups:history` – View messages and threads in private channels the bot has been added to.
4. `groups:read` – View basic info about private channels.

> [!NOTE]
> The bot must be invited to private channels (`/invite @BotName`) to read their history.

---

## 4. Architecture & Module Boundaries

The Slack integration is located under:
- `src/modules/ingestion/providers/slack/` (Core ingestion provider):
  - `slackClient.js`: Authenticated HTTP transport client with Bearer auth, cursor pagination, and error mapping.
  - `slackExtractor.js`: mrkdwn parser, Block Kit converter, and permalink builder.
  - `slackNormalizer.js`: Pure normalization functions mapping Slack messages to `SourceRecordCandidate` and `SourceRecord`.
  - `slackConnector.js`: High-level connector orchestrating channel validation, message history, and thread replies.
  - `slackErrors.js`: Domain error hierarchy (`SlackAuthenticationError`, `SlackPermissionError`, `SlackRateLimitError`, `SlackNotFoundError`).
- `src/integrations/slack/` (Integration facade):
  - Re-exports matching the existing `src/integrations/jira/` and `src/integrations/notion/` contract.

---

## 5. Local Testing

All automated tests use mocked Slack Web API responses and do not require live credentials:

```bash
# Run Slack integration test suite
node --test tests/integrations/slack.test.js

# Run all project tests
npm test
```
