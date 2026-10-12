# Work on Over2u projects through MCP

The backend exposes a stateless Streamable HTTP MCP server at
`http://localhost:8000/mcp`. A local stdio bridge lets Claude Desktop and other
local MCP clients use the same server. The server reads live project context,
imported source text, tasks, notes, handoffs and notifications. Write-enabled
keys can create/update tasks, save notes/decisions and create draft handoffs.

## Hosted setup: connect from any computer

Deploy the backend as a long-running Node service with HTTPS, and deploy the
frontend with an SPA fallback so `/mcp/authorize` and `/auth/callback` load the
React app. Frontend/vercel.json includes this rewrite for Vercel; configure the
equivalent fallback for other static hosts. This server keeps clients, consent requests, grants and tokens in
MongoDB; replicas do not need sticky sessions. Keep the same JWT_SECRET across
replicas and restarts (it also protects registered OAuth client secrets).

Backend production environment (replace these example domains):

```dotenv
NODE_ENV=production
API_BASE_URL=https://api.your-domain.com
FRONTEND_URL=https://app.your-domain.com
CLIENT_URL=https://app.your-domain.com
CORS_ORIGINS=https://app.your-domain.com
# Set only to the actual number of trusted reverse-proxy hops:
TRUST_PROXY_HOPS=1
```

Use your host's PORT and existing MONGODB_URI, JWT_SECRET and CRON_SECRET.
API_BASE_URL is the backend origin, without `/api`. Your reverse proxy must
preserve the public Host header and forward `/mcp`, `/authorize`, `/token`,
`/register`, `/revoke`, `/.well-known/*` and the existing `/api/*` routes to the
backend. The MCP endpoint uses JSON responses and does not need an SSE stream.
Configure TRUST_PROXY_HOPS to your actual proxy topology; use 0 when there is no
proxy. The Node service must accept loopback requests on its listening port.

Frontend build environment:

```dotenv
VITE_API_BASE_URL=https://api.your-domain.com/api
```

Build the frontend after setting this value. If using Google website sign-in,
update GOOGLE_CALLBACK_URL and the Google Cloud authorized redirect URI to
`https://api.your-domain.com/api/auth/oauth/google/callback` (and update the
mailbox callback registration if that feature is used).

Once deployed, each user:

1. Adds `https://api.your-domain.com/mcp` as a remote MCP server in their AI client.
2. Follows the client’s OAuth sign-in prompt to your deployed website.
3. Signs in or creates an Over2u account.
4. Selects projects and read-only or read-and-write access, then chooses Allow.
5. Returns to the AI client and asks it to load project context.

No local repository, Node installation, copied access key or provider API key is
needed for a client that supports remote MCP OAuth. In Codex, for example:

```toml
[mcp_servers.over2u]
url = "https://api.your-domain.com/mcp"
default_tools_approval_mode = "writes"
```

Then use `codex mcp login over2u` or the client’s OAuth connection action.
[Official Codex setup](https://developers.openai.com/codex/mcp).
For other AI clients, use their remote MCP/connector configuration and the same
URL. Availability of custom remote MCP connectors depends on the client and
account settings; an AI application without MCP support cannot use this server.

Connections → AI & MCP shows the deployed endpoint automatically. It also lists
OAuth grants so users can revoke them. OAuth uses PKCE, two-minute single-use
codes, one-hour access tokens, rotating refresh tokens, and 30-day connection
grants. User confirmation always shows the client name and return address; read
access is the default, even if the client requests write access. No new Google
or other provider OAuth credentials are needed for MCP's own authorization
server. Existing website Google sign-in remains a separate configuration.

## Local development and access-key alternative

## 1. Start the app and create your access key

Run the backend normally (`npm run dev` in Backend), then start the frontend.
Sign in to the website and open **Connections → AI & MCP**. Choose a name,
select the projects to expose, select read-only or read-and-write access, and
create a key. Copy it immediately; it is shown once. Each person creates their
own key under their own account. No shared administrator token is needed.

Keys expire in 7, 30 or 90 days and can be revoked in Connections. Only a hash is
stored on the backend. Losing membership or changing to a viewer role removes
access immediately through the existing API permissions. A write key never
gives owner permissions to a member. Do not put this key in a prompt or commit it.

## 2. Configure the private local bridge file

At the repository root, copy `.mcp.env.example` to `.mcp.env` and fill in:

```dotenv
OVER2U_MCP_URL=http://localhost:8000/mcp
OVER2U_MCP_TOKEN=PASTE_THE_KEY_FROM_CONNECTIONS
```

`.mcp.env` is ignored by Git. The bridge reads only this file, not Backend/.env.
It never loads your MongoDB, Gmail SMTP, Notion or Google client secrets.
Environment variables can override the file. You can use a different file by
setting `OVER2U_MCP_ENV_FILE` to its absolute path in the client configuration.

## 3. Connect Codex (local bridge, simplest setup)

Add this to your existing `~/.codex/config.toml`, preserving other settings:

```toml
[mcp_servers.over2u]
command = "node"
args = ["/Volumes/Edit/RGIT_Hack/Backend/scripts/mcp-stdio.js"]
startup_timeout_sec = 20
tool_timeout_sec = 60
default_tools_approval_mode = "writes"
```

Restart/reload Codex to pick up the server. This command works for the current
checkout; use the actual absolute script path if you move the repository. If
Node is not found, replace `node` with the path from `command -v node`.

Codex also supports direct HTTP. Set `OVER2U_MCP_TOKEN` in the environment of the
process launching Codex, then use this configuration **instead of** the bridge:

```toml
[mcp_servers.over2u]
url = "http://localhost:8000/mcp"
bearer_token_env_var = "OVER2U_MCP_TOKEN"
default_tools_approval_mode = "writes"
```

Direct HTTP does not automatically read `.mcp.env`. Use the bridge if managing
the launch environment of the IDE/app is inconvenient.

[Official Codex MCP configuration](https://developers.openai.com/codex/mcp).

## 4. Connect Claude Desktop

Open Claude Desktop's **Settings → Developer → Edit Config** and merge this
entry into `mcpServers` in its JSON configuration:

```json
{
  "mcpServers": {
    "over2u": {
      "command": "node",
      "args": ["/Volumes/Edit/RGIT_Hack/Backend/scripts/mcp-stdio.js"]
    }
  }
}
```

Fully quit and reopen Claude Desktop. If it cannot find Node, use the absolute
path from `command -v node`. Keep tool confirmations enabled in the client.
On macOS the configuration normally lives at
`~/Library/Application Support/Claude/claude_desktop_config.json`.

[Official local MCP connection guide](https://modelcontextprotocol.io/quickstart/user).

## 5. Use live context

Try:

> List my Over2u projects. Load the launch project's current context, read the
> relevant imported emails and Notion records, and summarize blockers and next steps.

With write access:

> Propose tasks for the unfinished work. Ask me to confirm before creating them.

Tools:

| Read tools | Write tools (write-enabled keys only) |
| --- | --- |
| list_projects | create_task |
| get_project_context | update_task |
| get_project_work_tree | |
| list_tasks | add_project_note |
| list_project_notes | create_handoff (draft only) |
| list_source_records | |
| get_source_record | |
| list_handoffs | |
| get_notifications | |

The server also exposes a `project_brief` prompt and a
`over2u://projects/{projectId}/context` resource template. Notes, email, Notion
and document content are treated as source data, not trusted instructions.
Existing website writes create the same audit entries and teammate notifications.
MCP writes additionally log which access key/tool performed the operation.

Write tools require `confirmed=true`, but that flag is not proof of human
approval: configure your client's confirmation behavior. A read-only key is the
server-enforced way to prevent all writes. Sending invitations, submitting or
accepting handoffs, changing ownership, arbitrary HTTP requests and raw database
queries are deliberately not exposed as MCP tools in this version.

## Hosted use and compatibility

Deploy the backend behind HTTPS and set `API_BASE_URL` to its public origin,
for example `https://api.your-domain.com`. The MCP address is then
`https://api.your-domain.com/mcp`. Host validation permits that configured host;
use your frontend's origins in `CORS_ORIGINS`. Keep normal user keys and MongoDB
configured as for the website. The internal MCP calls use the same server's
loopback port, so the HTTP listener must accept loopback connections.

For remote teams, replace the local URL with the deployed HTTPS MCP address.
The bridge rejects unencrypted HTTP endpoints outside localhost. Other clients
can use Streamable HTTP with `Authorization: Bearer <MCP key>`, or launch the
stdio bridge. The server supports browser OAuth as described above, plus personal access keys
for clients with bearer headers or a local stdio bridge. No new provider client
IDs or API secrets are needed for MCP authorization.

## Troubleshooting and verification

- Connection refused: start the backend, check port 8000 and the MCP URL.
- 401: create a fresh key or check that it has not expired or been revoked.
- Scope error: the project is not selected for the key or membership was removed.
- Write tools missing: the key is read-only; create a write key if needed.
- 403 on a write: your project role does not allow that action.
- 403 host/origin: configure API_BASE_URL/CORS_ORIGINS for the deployment.
- No source text: import the email/Notion/document content into the project first.
- Changes absent in an already open website tab: refresh the project page.

`npm run test:mcp` in Backend tests the real SDK HTTP and stdio clients against
an isolated local MongoDB. It tests project scope, reads, writes, confirmation,
role changes, revocation and expiration without changing your application data.
