# Over2u deployed integrations

Frontend: https://rgit-hack.vercel.app
Node backend: https://rgit-hack.onrender.com
Python AI service: https://rgit-hack-aiml.onrender.com

The AI service does not host /api/connections or /mcp.
Local .env edits do not change Render or Vercel environment settings.
Deploy the code changes and set the following values in the hosts' dashboards.

## Render: Node backend Environment

```dotenv
NODE_ENV=production
API_BASE_URL=https://rgit-hack.onrender.com
FRONTEND_URL=https://rgit-hack.vercel.app
CLIENT_URL=https://rgit-hack.vercel.app
CORS_ORIGINS=https://rgit-hack.vercel.app
AI_SERVICE_URL=https://rgit-hack-aiml.onrender.com
GOOGLE_CALLBACK_URL=https://rgit-hack.onrender.com/api/auth/oauth/google/callback
JIRA_REDIRECT_URI=https://rgit-hack.onrender.com/api/connections/jira/callback
SLACK_REDIRECT_URI=https://rgit-hack.onrender.com/api/connections/slack/callback
NOTION_REDIRECT_URI=https://rgit-hack.onrender.com/api/connections/notion/callback
```

Keep MONGODB_URI, JWT_SECRET, CRON_SECRET, SMTP credentials, and provider secrets configured in Render. Use the port supplied by Render. Keep JWT_SECRET and EMAIL_TOKEN_ENCRYPTION_KEY (if configured) stable: stored OAuth tokens depend on these encryption settings. Configure TRUST_PROXY_HOPS only for the actual proxy topology.

## Vercel: frontend Environment Variables

```dotenv
VITE_API_BASE_URL=https://rgit-hack.onrender.com/api
```

Apply to Production and redeploy: Vite embeds this value at build time.
The existing Frontend/vercel.json supports OAuth page and other SPA deep links.

## Provider settings that must be updated manually

| Provider | Environment credentials | Exact registered redirect URL |
| --- | --- | --- |
| Notion public OAuth connection | NOTION_CLIENT_ID, NOTION_CLIENT_SECRET | https://rgit-hack.onrender.com/api/connections/notion/callback |
| Jira OAuth 2.0 (3LO) app | JIRA_CLIENT_ID, JIRA_CLIENT_SECRET | https://rgit-hack.onrender.com/api/connections/jira/callback |
| Slack App OAuth & Permissions | SLACK_CLIENT_ID, SLACK_CLIENT_SECRET | https://rgit-hack.onrender.com/api/connections/slack/callback |
| Google website sign-in | GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET | https://rgit-hack.onrender.com/api/auth/oauth/google/callback |
| Gmail mailbox connection (same Google client) | GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET | https://rgit-hack.onrender.com/api/email/oauth/gmail/callback |

Notion: create a public OAuth connection; an internal token is not a client secret. Enable the read capabilities required for imported pages. Users choose which pages to share during authorization. Enter credentials only in Render / local Backend/.env, never Frontend/.env. The website's Notion card supports OAuth and an advanced token fallback. Project page imports prefer the signed-in owner's connected Notion account.

Jira: register the callback under Authorization for the Atlassian developer app. Configure the scopes used by JIRA_SCOPES (default read:jira-work read:jira-user offline_access) and enable distribution for intended users.

Slack: register the callback under OAuth & Permissions. Match SLACK_SCOPES (default channels:read, channels:history, groups:read, groups:history). Reauthorize when changing scopes. Invite the installed bot to channels it needs to read, particularly private channels.

Google: add both callback URLs to Authorized redirect URIs; add https://rgit-hack.vercel.app as an authorized JavaScript origin where required. Keep Gmail API enabled and test users configured while the Google consent app is in Testing.

## MCP OAuth

Add https://rgit-hack.onrender.com/mcp as a remote connector in Claude or another OAuth-capable MCP client. Leave manual OAuth Client ID / Secret empty for clients supporting dynamic registration. Connect, sign in to Over2u, choose projects and permissions, and allow access. This is Over2u's authorization server and does not require a separate Google/Notion/Jira OAuth client. Revoke grants in Connections → AI & MCP.

The .mcp.env file is used only by the access-key stdio bridge, not remote browser OAuth.

## Verify after deployment

1. https://rgit-hack.onrender.com/api/health returns status ok.
2. https://rgit-hack.onrender.com/api/mcp/info advertises the deployed /mcp URL.
3. https://rgit-hack.onrender.com/.well-known/oauth-authorization-server advertises deployed authorization/token/registration URLs.
4. Sign in at the deployed frontend and connect each provider in Connections.
5. Select a project and import a page / link a Jira project / link a Slack channel. Verify actual imported records rather than connection status alone.
6. Connect the MCP remote client, list projects, and load context. Test read-only access before enabling writes.

Provider dashboards:
- Notion: https://www.notion.so/profile/integrations
- Atlassian: https://developer.atlassian.com/console/myapps/
- Slack: https://api.slack.com/apps
- Google: https://console.cloud.google.com/apis/credentials

Reference: https://developers.notion.com/guides/get-started/authorization
