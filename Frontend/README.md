# Over2u frontend

React 19, Vite, and React Router landing page, signup, and sign-in UI.

## Run locally

Run `npm ci`, then `npm run dev` in this directory. Start the existing backend on port 8000 (`PORT=8000` in `Backend/.env`). Vite proxies `/api` to that backend for development and preview. For a different local port, set `VITE_API_PROXY_TARGET` in `Frontend/.env`. For a separately hosted backend, set `VITE_API_BASE_URL` to its API root (including `/api`). Production hosting must route `/api` to the backend or configure this variable at build time.

## Authentication integration

The home page is `/`. Registration lives at `/signup`, and sign-in at `/signin`. `/register` and `/auth` redirect to `/signup`; `/login` redirects to `/signin`. Legacy `/#signup` and `/#signin` links redirect to their corresponding page routes. Unknown paths display a 404 page with a home link. Internal navigation uses React Router and supports browser back/forward. Landing-page section links scroll to their target after navigation.

Production hosting must serve `index.html` for frontend paths such as `/signup` and `/signin` so direct links and refreshes work. Keep `/api` requests routed to the backend. Vite's development and preview servers handle the frontend fallback automatically.

The API layer in `src/api/auth.js` uses the existing `POST /api/auth/register` and `POST /api/auth/login` endpoints. The signup username maps to the backend's `name` field; the backend does not enforce unique usernames. Password constraints match its 8–200 character registration schema.

Successful authentication opens `/dashboard`, or the protected page that prompted sign-in. The auth provider keeps the session in memory and session storage, verifies it with `GET /api/auth/me` after refresh, and clears it on sign-out or a 401 response. Authenticated requests include the bearer token. Session storage lasts for the browser tab; unavailable storage falls back to memory.

## Signed-in workspace

- `/dashboard`: live project, task, and handoff counts, project shortcuts, open tasks, and incoming handoffs.
- `/projects` and `/projects/:projectId`: create and edit projects, view project context, and add registered teammates as members or viewers.
- `/tasks`: search and filter tasks, create tasks, edit title/priority/assignee/deadline, and mark work complete or reopen it.
- `/handoffs` and `/handoffs/:handoffId`: create drafts, document status and typed notes, add supporting links, check readiness, submit, acknowledge ownership, request/respond to clarification, and cancel an open outgoing handoff.

Workspace routes require authentication. Viewer roles do not expose task mutations; project ownership controls member management and handoff creation. The backend rechecks authorization and handoff readiness. Project context and handoff lists drive workspace data, with visible errors and empty states. There is no seeded dashboard data in the frontend.

Terms and privacy controls display an explicit unpublished-policy notice until real legal pages are supplied.

## Google sign-in

Both auth pages include Google sign-in. Configure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `Backend/.env`, then restart the backend. For local development, Google’s Web application OAuth client must authorize `http://localhost:8000/api/auth/oauth/google/callback` as a redirect URI. Keep `API_BASE_URL=http://localhost:8000` and `FRONTEND_URL=http://localhost:5173`. Use matching public HTTPS URLs when deploying.

The frontend checks `/api/auth/oauth/providers` to enable the button only when Google is configured. The backend signs provider state and binds it to a short-lived HttpOnly browser cookie, exchanges the code, requires a verified email, and returns to `/auth/callback`. The session token is delivered in the URL fragment, removed before rendering, and verified with `/api/auth/me` before session storage and dashboard navigation. Cancelled consent and callback failures return readable errors. GitHub UI is not enabled yet.

## Checks

`npm run build`, `npm run lint`, and `npm test`. The frontend tests use mocked API responses to check authenticated requests, expired sessions, partial load failures, protected rendering, page destinations, empty states, and handoff readiness controls.

`npm run test:signup` verifies the actual frontend authentication client against the backend with disposable MongoDB: registration, hashed password storage, session verification, workspace access, duplicate emails, and login. The test harness never uses your development database. MongoDB is downloaded on first use.

`npm run test:oauth` runs Google OAuth integration tests using disposable MongoDB and simulated Google token/profile responses. It covers redirects, browser-bound state, callback session verification, token removal, existing-account linking, cancellation, expired state, unverified email, provider failures, and disabled accounts. These tests do not log into a real Google account; a live consent flow requires the configured Google client and a browser login.

## Gmail and Outlook project conversations

`/emails` supports connecting a user's Gmail and Outlook mailbox, browsing/searching conversations, previewing them, importing up to 10 selected conversations into a project, and reviewing AI-derived workflow proposals. Imported conversations are stored as `SourceRecord`s and logged in the project audit chain. Re-importing a conversation from the same mailbox reuses its record. Only selected conversations are sent to the configured AI context service; browsing other email does not import it. Authorized project contributors can see imported email content, so selection is the sharing step.

Google mailbox consent is separate from Google sign-in. Enable Gmail API, request `gmail.readonly`, and add `http://localhost:8000/api/email/oauth/gmail/callback` to the existing Google Web application client's authorized redirect URIs. Google may require test users, verification, or administrator consent depending on the app's publishing state and organization.

For Outlook, register a Microsoft Entra Web application, configure `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and `MICROSOFT_TENANT_ID` (`common` for work/school and personal accounts), and add `http://localhost:8000/api/email/oauth/outlook/callback`. Delegated scopes are `User.Read`, `Mail.Read`, and `offline_access`. Tenant policies can require admin consent. Update both callback URLs to public HTTPS URLs in production.

Tokens stay on the backend, encrypted with AES-256-GCM using `EMAIL_TOKEN_ENCRYPTION_KEY` or, when unset, the JWT signing secret. Changing that encryption secret requires reconnecting existing mailboxes. Refresh tokens are used when access expires. Disconnecting deletes the app's stored mailbox credentials and prevents future reads; imported project evidence is retained, and provider-side consent can be revoked separately in the provider account.

Analyze selected imported records with the existing AI service (`AI_SERVICE_URL`, default `http://127.0.0.1:8001`). Proposed tasks and refinements are persisted in `EmailReview`; they do not automatically modify tasks. Reviewers can edit proposed fields, choose a new task or an existing project task, apply a change, or dismiss it. Approval records source IDs in task provenance and the audit log. Applying an already reviewed proposal is idempotent. Existing task refinements use AI-identified information gaps; proposed deadline/status changes must be explicitly confirmed in the review form.

Run `npm run test:email` for disposable-database integration checks with simulated Gmail, Microsoft Graph, and AI responses. Real mailbox consent and live AI responses require provider setup and a running AI service.
# Notion project connection

On **Connections → Knowledge & documentation → Notion**, a project owner selects
a project and pastes a Notion page URL or ID. Share the page with the integration
whose token is configured as `NOTION_API_KEY` on the backend first.

Connect page imports the page text and nested blocks into project source records.
Sync again updates the same source record. The imported content appears in the
connection card and is available to the existing project context generation flow.
Disconnect removes the connection while retaining imported project knowledge.
This uses the server's configured internal integration; it is not per-user Notion OAuth.


## Teammate invitations

Project owners use **Add teammate → Send invitation**. The recipient receives a
7-day invitation link, signs in or creates an account using the invited email,
then accepts in the website. Password and Google sign-in preserve the invitation.
Membership is created only upon acceptance. Owners can see and cancel pending
invitations. Tokens are stored hashed; email delivery failures are displayed.

Configure Nodemailer SMTP in `Backend/.env` (Gmail example):

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-address@gmail.com
SMTP_PASS=your-16-character-app-password
INVITE_FROM_EMAIL="Over2u <your-address@gmail.com>"
```

Enable Google 2-Step Verification and generate an App Password for the sender.
Use that App Password, without spaces, rather than the normal account password.
Restart the backend after editing `.env`, then run `npm run verify:email` from
`Backend` to check SMTP authentication without sending mail. Other SMTP providers
can use their supplied host, credentials, and port (587 with `SMTP_SECURE=false`
uses STARTTLS). Keep `FRONTEND_URL` set to the URL recipients can actually open;
localhost links work only on the machine hosting the frontend.

Run `npm run test:invitations` from `Frontend` for tests against a disposable
MongoDB and mocked Nodemailer delivery.

## In-app notifications

The workspace top bar includes a notification bell with an unread badge, a
paginated activity dropdown, individual read state, and Mark all read. Opening a
notification marks it read and opens the related project or handoff. Notifications
refresh every 15 seconds while the tab is visible and on window focus.

Project activity is sent to other current project members; your own actions do
not notify you. Accepted invitations notify the project owner. Tasks, notes,
handoffs, conflicts, email workflow changes, document uploads, and Notion syncs
produce notifications through the project audit events. Existing targeted
handoff notifications remain supported. Notifications are stored in MongoDB,
and read operations are scoped to the signed-in recipient. No extra credentials
are required for in-app notifications.

## MCP project access

Use the URL shown in **Connections → AI & MCP** to sign in and authorize selected
projects from a remote MCP client. Revocable access keys are also available.
The backend serves Streamable HTTP MCP at `http://localhost:8000/mcp`; the local
bridge is `Backend/scripts/mcp-stdio.js`. See [MCP_SETUP.md](../Backend/MCP_SETUP.md)
for the complete Codex/Claude Desktop configuration, private `.mcp.env` setup,
tool list, HTTPS deployment, hosted OAuth sign-in and access-key alternatives.
