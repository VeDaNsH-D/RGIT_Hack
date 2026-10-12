import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { createServer } from 'vite'

let treeLayout, WorkTreeCanvas, McpAuthorizePage, NotificationBell, notificationLinks, InvitationPage, oauth, ConnectionsPage, ConnectionsView, server, api, sessions, AuthContext, WorkspaceContext, pages, HandoffDetailPage, WorkspaceLayout, DeveloperHandoffView, analysisHelpers, ReportBody, AiProjectContextView, workflow, AiDraftPanel, RepositoryActivityView, ConnectedRepositoriesView, GitHubRepositoryPicker, ProjectDocumentsView, documentHelpers, documentsApi, ConnectedJiraProjectsView, isJiraKey
const storage = new Map()
const originalWindow = globalThis.window
const originalStorage = globalThis.sessionStorage
const originalFetch = globalThis.fetch
const user = { id: 'user-owner', name: 'Alex Parker', email: 'alex@example.test' }
const project = {
  id: 'project-one', name: 'Website launch', description: 'Bring the launch together.', ownerId: user.id, myRole: 'owner',
  context: { members: [{ userId: user.id, name: user.name, email: user.email, role: 'owner' }, { userId: 'user-next', name: 'Sam Lee', email: 'sam@example.test', role: 'member' }] },
  tasks: [{ id: 'task-one', projectId: 'project-one', title: 'Review launch copy', status: 'open', priority: 'high', assignee: user.id, deadline: null }],
  handoffs: [{ id: 'handoff-one', projectId: 'project-one', state: 'DRAFT', fromUserId: user.id, toUserId: 'user-next', isOpen: true, currentStatus: 'Ready for review', items: [], supportingLinks: [], noPendingActionsConfirmed: false, version: 0 }],
}
const auth = { session: { token: 'test-token', user }, checking: false, error: '', signOut() {}, acceptSession() {} }
const workspace = { projects: [project], tasks: project.tasks, handoffs: project.handoffs, loading: false, error: '', async reload() {} }

before(async () => {
  globalThis.window = new EventTarget()
  window.location = { search: '' }
  globalThis.sessionStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  server = await createServer({ envDir: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' })
  api = await server.ssrLoadModule('/src/api/client.js')
  sessions = await server.ssrLoadModule('/src/auth/session.js')
  ;({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.js'))
  ;({ WorkspaceContext } = await server.ssrLoadModule('/src/workspace/WorkspaceContext.js'))
  pages = await server.ssrLoadModule('/src/workspace/WorkspacePages.jsx')
  ;({ default: HandoffDetailPage } = await server.ssrLoadModule('/src/workspace/HandoffDetailPage.jsx'))
  ;({ default: ConnectionsPage, ConnectionsView } = await server.ssrLoadModule('/src/workspace/ConnectionsPage.jsx'))
  ;({ default: InvitationPage } = await server.ssrLoadModule('/src/pages/InvitationPage.jsx'))
  ;({ WorkTreeCanvas } = await server.ssrLoadModule('/src/workspace/ProjectWorkTree.jsx'))
  treeLayout = await server.ssrLoadModule('/src/workspace/workTreeLayout.js')
  ;({ default: McpAuthorizePage } = await server.ssrLoadModule('/src/workspace/McpAuthorizePage.jsx'))
  ;({ default: NotificationBell } = await server.ssrLoadModule('/src/workspace/NotificationBell.jsx'))
  notificationLinks = await server.ssrLoadModule('/src/workspace/notificationLinks.js')
  oauth = await server.ssrLoadModule('/src/auth/oauth.js')
  ;({ ConnectedRepositoriesView } = await server.ssrLoadModule('/src/workspace/ConnectedRepositories.jsx'))
  ;({ RepositoryActivityView } = await server.ssrLoadModule('/src/workspace/RepositoryActivity.jsx'))
  ;({ AiProjectContextView } = await server.ssrLoadModule('/src/workspace/AiProjectContext.jsx'))
  workflow = await server.ssrLoadModule('/src/workspace/aiHandoffWorkflow.js')
  ;({ DeveloperHandoffView } = await server.ssrLoadModule('/src/workspace/DeveloperHandoff.jsx'))
  analysisHelpers = await server.ssrLoadModule('/src/workspace/analysisHelpers.js')
  ;({ HandoffReportBody: ReportBody } = await server.ssrLoadModule('/src/workspace/HandoffReportPreview.jsx'))
  ;({ ProjectDocumentsView } = await server.ssrLoadModule('/src/workspace/ProjectDocuments.jsx'))
  ;({ ConnectedJiraProjectsView } = await server.ssrLoadModule('/src/workspace/ConnectedJiraProjects.jsx'))
  ;({ isJiraKey } = await server.ssrLoadModule('/src/workspace/jiraHelpers.js'))
  documentHelpers = await server.ssrLoadModule('/src/workspace/documentHelpers.js')
  documentsApi = await server.ssrLoadModule('/src/api/documents.js')
  ;({ AiDraftPanel } = await server.ssrLoadModule('/src/workspace/AiDraftPanel.jsx'))
  ;({ GitHubRepositoryPicker } = await server.ssrLoadModule('/src/workspace/ProjectIntegrations.jsx'))
  ;({ default: WorkspaceLayout } = await server.ssrLoadModule('/src/workspace/WorkspaceLayout.jsx'))
})
after(async () => {
  await server?.close()
  globalThis.window = originalWindow
  globalThis.sessionStorage = originalStorage
  globalThis.fetch = originalFetch
})
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
function render(Component, path, pattern = path, workspaceValue = workspace) {
  return renderToString(React.createElement(MemoryRouter, { initialEntries: [path] },
    React.createElement(AuthContext.Provider, { value: auth },
      React.createElement(WorkspaceContext.Provider, { value: workspaceValue },
        React.createElement(Routes, null, React.createElement(Route, { path: pattern, element: React.createElement(Component) }))))))
}

test('requests send the session bearer token and JSON mutation body', async () => {
  sessions.storeSession(auth.session)
  let captured
  globalThis.fetch = async (url, options) => { captured = { url, options }; return response({ task: project.tasks[0] }) }
  await api.request('/tasks/task-one', { method: 'PATCH', body: { status: 'completed' } })
  assert.equal(captured.url, '/api/tasks/task-one')
  assert.equal(captured.options.headers.Authorization, 'Bearer test-token')
  assert.deepEqual(JSON.parse(captured.options.body), { status: 'completed' })
})
test('expired sessions notify the auth provider; server errors remain visible', async () => {
  let expired = false
  const listener = () => { expired = true }
  window.addEventListener('relay:session-expired', listener)
  globalThis.fetch = async () => response({ message: 'Session expired' }, 401)
  await assert.rejects(api.request('/projects'), /Session expired/)
  assert.equal(expired, true)
  window.removeEventListener('relay:session-expired', listener)
})
test('workspace loads project members, all context tasks, and handoffs', async () => {
  globalThis.fetch = async url => {
    if (url === '/api/projects') return response({ projects: [{ id: project.id, name: project.name, myRole: 'owner' }] })
    if (url.endsWith('/context')) return response({ ...project.context, tasks: project.tasks })
    if (url.endsWith('/handoffs')) return response({ handoffs: project.handoffs })
    throw new Error('Unexpected endpoint')
  }
  const data = await api.loadWorkspace()
  assert.equal(data.projects[0].tasks[0].projectId, project.id)
  assert.equal(data.projects[0].handoffs[0].id, 'handoff-one')
  assert.equal(data.projects[0].context.members.length, 2)
})
test('a project load failure is exposed, rather than fabricated as successful empty data', async () => {
  globalThis.fetch = async url => url === '/api/projects' ? response({ projects: [{ id: project.id }] }) : response({ message: 'Project unavailable' }, 503)
  const data = await api.loadWorkspace()
  assert.equal(data.projects[0].loadError, 'Project unavailable')
})
test('dashboard, project list, tasks, and handoffs render live data and route links', () => {
  const dashboard = render(pages.DashboardPage, '/dashboard')
  assert.match(dashboard, /Welcome back, Alex/)
  assert.match(dashboard, /href="\/projects\/project-one"/)
  assert.match(render(pages.ProjectsPage, '/projects'), /Website launch/)
  assert.match(render(pages.TasksPage, '/tasks'), /Review launch copy/)
  assert.match(render(pages.HandoffsPage, '/handoffs'), /href="\/handoffs\/handoff-one"/)
  const detail = render(pages.ProjectDetailPage, '/projects/project-one', '/projects/:projectId')
  assert.match(detail, /Sam Lee/)
  assert.match(detail, /Add teammate/)
})
test('handoff details identify outgoing and incoming owners and require readiness', () => {
  const html = render(HandoffDetailPage, '/handoffs/handoff-one', '/handoffs/:handoffId')
  assert.match(html, /Alex Parker/)
  assert.match(html, /Sam Lee/)
  assert.match(html, /Check readiness/)
  assert.match(html, /disabled=""[^>]*>Send handoff/)
})
test('new accounts get an empty workspace with a create-project action', () => {
  const html = render(pages.DashboardPage, '/dashboard', '/dashboard', { ...workspace, projects: [], tasks: [], handoffs: [] })
  assert.match(html, /Create your first project/)
  assert.match(html, /Good work starts with a project/)
  assert.doesNotMatch(html, /Website launch/)
})
test('protected routes do not render workspace content to signed-out users', () => {
  const html = renderToString(React.createElement(MemoryRouter, { initialEntries: ['/dashboard'] }, React.createElement(AuthContext.Provider, { value: { ...auth, session: null } }, React.createElement(WorkspaceLayout))))
  assert.doesNotMatch(html, /Your workspace/)
})
test('viewers see task context without task creation or edit controls', () => {
  const viewerProject = { ...project, myRole: 'viewer', ownerId: 'other-owner' }
  const html = render(pages.TasksPage, '/tasks', '/tasks', { ...workspace, projects: [viewerProject] })
  assert.match(html, /Review launch copy/)
  assert.doesNotMatch(html, /New task/)
  assert.doesNotMatch(html, /aria-label="Edit Review launch copy"/)
  assert.match(html, /type="checkbox"[^>]*disabled=""/)
})
test('network errors retain their underlying cause and validation errors are readable', async () => {
  const offline = new Error('Network offline')
  globalThis.fetch = async () => { throw offline }
  await assert.rejects(api.request('/projects'), error => error.cause === offline)
  globalThis.fetch = async () => response({ error: 'validation_error', message: JSON.stringify([{ message: 'Project name is required' }]) }, 400)
  await assert.rejects(api.request('/projects'), /Project name is required/)
})

const view = github => renderToString(React.createElement(MemoryRouter, null, React.createElement(WorkspaceContext.Provider, { value: workspace }, React.createElement(ConnectionsView, { github: { loading: false, starting: false, error: '', message: '', onConnect() {}, ...github } }))))
test('connections page includes project Notion controls and MCP access key setup', () => {
  const html = view({ status: { configured: true, connected: false, accounts: [] } })
  for (const name of ['GitHub', 'Slack', 'Email', 'Notion', 'Jira']) assert.match(html, new RegExp(`>${name}<`))
  assert.match(html, /AI &amp; MCP/)
  assert.match(html, /Create access key/)
  assert.match(html, /Read only/)
  assert.equal((html.match(/Coming soon/g) || []).length, 3)
  assert.equal((html.match(/Connect GitHub/g) || []).length, 1)
  assert.doesNotMatch(html, /Connect (Slack|Email|Notion|Jira)/)
})
test('connections page shows a loading state before status arrives', () => {
  const html = render(ConnectionsPage, '/connections')
  assert.match(html, /Checking your connections/)
  assert.doesNotMatch(html, /Connect GitHub/)
})
test('connections view shows failures, and connected only when the backend confirms it', () => {
  assert.match(view({ status: null, error: 'Couldn’t connect to your workspace.' }), /role="alert"[^>]*>Couldn’t connect/)
  assert.doesNotMatch(view({ status: null, error: 'x' }), /Connected/)
  assert.match(view({ status: { configured: true, connected: false, accounts: [] }, message: 'GitHub installation was cancelled. Nothing was connected.' }), /cancelled/)
  const connected = view({ status: { configured: true, connected: true, accounts: [{ id: 'a', login: 'acme', connectedAt: '2026-01-02T00:00:00Z' }] } })
  assert.match(connected, />Connected</)
  assert.match(connected, /Connected to acme/)
  assert.doesNotMatch(connected, /Connect GitHub/)
  assert.match(view({ status: { configured: false, connected: false, accounts: [] } }), /disabled=""[^>]*>Connect GitHub/)
})

test('invitation destinations survive Google sign-in and reject external redirects', () => {
  const destination = '/invite#' + 'a'.repeat(64)
  let target
  const previous = window.location.assign
  window.location.assign = url => { target = url }
  try {
    oauth.beginGoogleSignIn(destination)
    assert.match(target, /auth\/oauth\/google$/)
    assert.equal(oauth.takeOAuthDestination(), destination)
    assert.equal(oauth.safeDestination('https://outside.example'), '/dashboard')
    assert.equal(oauth.safeDestination('//outside.example/invite'), '/dashboard')
  } finally { window.location.assign = previous }
})
test('signed-in recipients get an invitation review page', () => {
  const html = render(InvitationPage, '/invite#' + 'a'.repeat(64), '/invite')
  assert.match(html, /Your project invitation/)
  assert.match(html, /Checking your invitation/)
  assert.match(html, /Use a different account/)
})

test('notification bell is accessible and destinations stay within workspace routes', () => {
  const html = render(NotificationBell, '/dashboard')
  assert.match(html, /aria-label="Notifications"/)
  assert.match(html, /aria-expanded="false"/)
  const id = 'a'.repeat(24)
  assert.equal(notificationLinks.notificationDestination({ type: 'PROJECT_ACTIVITY', projectId: id }), '/projects/' + id)
  assert.equal(notificationLinks.notificationDestination({ type: 'HANDOFF_SUBMITTED', projectId: id, entityId: 'b'.repeat(24) }), '/handoffs/' + 'b'.repeat(24))
  assert.equal(notificationLinks.notificationDestination({ projectId: 'https://outside.example' }), '/dashboard')
})

test('hosted MCP consent renders and sign-in preserves its authorization request', () => {
  const destination = '/mcp/authorize?request=' + 'a'.repeat(64)
  assert.equal(oauth.safeDestination(destination), destination)
  const html = render(McpAuthorizePage, destination, '/mcp/authorize')
  assert.match(html, /Connect your projects/)
  assert.match(html, /Loading connection request/)
  assert.match(html, /Manage AI connections/)
})
const picker = props => renderToString(React.createElement(GitHubRepositoryPicker, { repos: [], query: '', selected: null, onQuery() {}, onSelect() {}, onRetry() {}, onConnect() {}, ...props }))
const sample = [{ id: 1, fullName: 'acme/relay', isPrivate: false }, { id: 2, fullName: 'acme/secret-api', isPrivate: true }]
test('repository picker: loading, error with retry, and not-connected states', () => {
  assert.match(picker({ state: 'loading' }), /Loading repositories/)
  const failed = picker({ state: 'error', error: 'GitHub could not be reached.' })
  assert.match(failed, /role="alert"[^>]*>GitHub could not be reached/); assert.match(failed, /Try again/)
  const none = picker({ state: 'not_connected' })
  assert.match(none, /Connect GitHub/); assert.doesNotMatch(none, /Search repositories/)
})
test('repository picker: lists repositories with visibility, empty states, and selection', () => {
  const ready = picker({ state: 'ready', repos: sample })
  assert.match(ready, /acme\/relay/); assert.match(ready, /Public/); assert.match(ready, /Private/)
  assert.match(picker({ state: 'ready' }), /No repositories are shared/)
  assert.match(picker({ state: 'ready', query: 'zzz' }), /No repositories match that search/)
  const chosen = picker({ state: 'ready', repos: sample, selected: sample[1] })
  assert.match(chosen, /Clear/); assert.doesNotMatch(chosen, /Search repositories/)
})
test('project creation stays optional: the modal source only sends integrations when a repo is chosen', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/workspace/WorkspaceModal.jsx', import.meta.url), 'utf8')
  assert.match(source, /integrations\.github \? \{ integrations/)
})
test('edit-project dialog offers a guarded delete', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/workspace/WorkspaceModal.jsx', import.meta.url), 'utf8')
  assert.match(source, /method: 'DELETE'/)
  assert.match(source, /confirmText\.trim\(\) !== project\?\.name/)
})
const repoView = props => renderToString(React.createElement(MemoryRouter, null, React.createElement(ConnectedRepositoriesView, { state: 'ready', connections: [], canManage: true, onAdd() {}, onRetry() {}, ...props })))
const conn = (id, name, isPrivate, sync = null) => ({ id, sync, repository: { id: Number(id), owner: 'acme', name, fullName: `acme/${name}`, htmlUrl: `https://github.com/acme/${name}`, isPrivate } })
test('connected repositories: loading, error with retry, and empty states', () => {
  assert.match(repoView({ state: 'loading' }), /Loading repositories/)
  const failed = repoView({ state: 'error', error: 'Project not found' })
  assert.match(failed, /role="alert"[^>]*>Project not found/); assert.match(failed, /Try again/)
  const empty = repoView({})
  assert.match(empty, /No repositories connected yet/); assert.match(empty, /Add repository/)
  assert.doesNotMatch(repoView({ canManage: false }), /Add repository/)
})
test('connected repositories: shows persisted repositories without inventing sync data', () => {
  const html = repoView({ connections: [conn('1', 'relay', false), conn('2', 'secret-api', true)] })
  assert.match(html, /acme\/relay/); assert.match(html, /acme\/secret-api/)
  assert.match(html, /Public/); assert.match(html, /Private/)
  assert.match(html, /Not synced yet/)
  assert.doesNotMatch(html, /Last synced|Sync status/)
  assert.match(html, /href="https:\/\/github.com\/acme\/relay"/)
  assert.match(html, /\+ Add repository/)
  assert.match(html, /Counts|counts appear after the first successful sync/)
  assert.doesNotMatch(html, /open issues/)
})
test('connected repositories: disconnect asks for confirmation first', () => {
  const html = repoView({ connections: [conn('1', 'relay', false)], removing: '1' })
  assert.match(html, /Disconnect this repository\?/)
  assert.doesNotMatch(repoView({ connections: [conn('1', 'relay', false)] }), /Disconnect this repository/)
})

const synced = (over = {}) => ({ ...conn('1', 'relay', false), sync: { status: 'completed', lastSuccessAt: '2026-01-02T10:00:00Z', errors: [], ...over.sync }, stats: { state: 'ready', openIssues: 3, openPullRequests: 0, latestCommitAt: '2026-01-02T00:00:00Z', ...over.stats } })
test('repository cards: real counts (including a genuine zero), sync status, and a working Sync now control', () => {
  const html = repoView({ connections: [synced()], canSync: true })
  assert.match(html, />Synced</); assert.match(html, /<strong>3<\/strong> open issues/); assert.match(html, /<strong>0<\/strong> open pull requests/)
  assert.match(html, /Last synced/); assert.match(html, />Sync now</)
  assert.doesNotMatch(repoView({ connections: [synced()], canSync: false }), /Sync now/)
  assert.match(repoView({ connections: [synced()], canSync: true, syncingIds: ['1'] }), /Syncing…/)
})
test('repository cards: failed, partial, truncated and stale states are shown honestly', () => {
  const failed = repoView({ connections: [synced({ sync: { status: 'failed', errors: [{ message: 'GitHub rate limit reached. Try again later.' }] }, stats: { state: 'stale' } })] })
  assert.match(failed, />Sync failed</); assert.match(failed, /rate limit reached/); assert.match(failed, /From the last successful sync/)
  assert.match(repoView({ connections: [synced({ sync: { status: 'partial', errors: [{ message: 'Some GitHub data could not be synchronized.' }] } })] }), />Partially synced</)
  assert.match(repoView({ connections: [synced({ stats: { truncated: true } })] }), /At least 3/)
  const never = repoView({ connections: [{ ...conn('1', 'relay', false), sync: { status: 'failed', errors: [] }, stats: { state: 'failed', openIssues: null } }] })
  assert.doesNotMatch(never, /open issues/)
})
const activity = (props = {}) => renderToString(React.createElement(RepositoryActivityView, { tab: 'issues', onTab() {}, state: 'ready', data: { items: [], total: 0, page: 1, hasMore: false }, onRetry() {}, onPage() {}, ...props }))
test('repository activity: loading, error, empty, and paginated list with GitHub links', () => {
  assert.match(activity({ state: 'loading' }), /Loading activity/)
  assert.match(activity({ state: 'error', error: 'Project not found' }), /role="alert"[^>]*>Project not found/)
  assert.match(activity({}), /Nothing here yet/)
  const item = { id: 'a', kind: 'issue', number: 8, title: 'CORS failures', url: 'https://github.com/acme/relay/issues/8', repository: 'acme/relay', author: 'alice', updatedAt: '2026-01-02T00:00:00Z', labels: ['bug'], assignees: ['bob'] }
  const html = activity({ data: { items: [item], total: 41, page: 1, hasMore: true } })
  assert.match(html, /href="https:\/\/github.com\/acme\/relay\/issues\/8"/); assert.match(html, /CORS failures/); assert.match(html, /bob/)
  assert.match(html, /41 total/); assert.match(html, /disabled=""[^>]*>Previous/)
})
test('AI draft panel: empty, drafting, grounded draft with limitations and sources', () => {
  const panel = props => renderToString(React.createElement(AiDraftPanel, { draft: null, busy: false, disabled: false, onGenerate() {}, onApply() {}, ...props }))
  assert.match(panel({}), /Draft with AI/)
  assert.match(panel({ busy: true }), /Drafting…/)
  const draft = { generatedAt: '2026-01-02T00:00:00Z', basedOn: { github: 4, notes: 0, tasks: 1 }, currentStatus: 'Retry work is in review.', limitations: ['acme/relay has not been synchronized successfully; its activity is missing.'],
    items: [{ type: 'blocker', kind: 'sourced', text: 'CORS failures [Source: acme/relay issue #8]' }, { type: 'pending', kind: 'inference', text: 'Suggested: Fix CORS' }], sources: [{ id: 'a', label: 'acme/relay issue #8', url: 'https://github.com/acme/relay/issues/8' }] }
  const html = panel({ draft })
  assert.match(html, /Data limitations/); assert.match(html, /Supported by sources/); assert.match(html, /Inference/)
  assert.match(html, /<button[^>]*class="ws-source-button"[^>]*>acme\/relay issue #8<\/button>/); assert.match(html, /Apply to this handoff/)
  assert.match(html, /from 4 GitHub records, 0 notes and 1 tasks/)
})

const ctxView = props => renderToString(React.createElement(MemoryRouter, null, React.createElement(AiProjectContextView, { summary: { repositories: 1, sync: 'Up to date', openIssues: 3, openPullRequests: 0, lastActivity: '2026-01-02T00:00:00Z' }, mode: 'ready', existing: null, recipients: [{ userId: 'u2', name: 'Sam Lee', email: 'sam@example.test' }], recipientId: '', onRecipient() {}, busy: null, error: null, onGenerate() {}, ...props })))
test('AI Project Context: real stats, recipient choice, and a Generate AI Handoff action', () => {
  const html = ctxView({})
  assert.match(html, /AI Project Context/); assert.match(html, /Turn repository activity and project knowledge into actionable handoffs\./)
  assert.match(html, /Connected repositories/); assert.match(html, /<strong>3<\/strong>/); assert.match(html, /<strong>0<\/strong>/); assert.match(html, /Up to date/)
  assert.match(html, /Sam Lee/); assert.match(html, /disabled=""[^>]*>Generate AI Handoff/) // needs a recipient first
  assert.doesNotMatch(ctxView({ recipientId: 'u2' }), /disabled=""[^>]*>Generate AI Handoff/)
})
test('AI Project Context: unavailable data is never shown as zero', () => {
  const html = ctxView({ summary: { repositories: 0, sync: 'No repository connected', openIssues: null, openPullRequests: null, lastActivity: null } })
  assert.match(html, /Open issues<\/span><strong>Unavailable/); assert.match(html, /Open pull requests<\/span><strong>Unavailable/); assert.match(html, /Last activity<\/span><strong>Unavailable/)
})
test('AI Project Context: generating, error with retry, reuse of an open handoff, and role states', () => {
  assert.match(ctxView({ busy: 'drafting', recipientId: 'u2' }), /Generating draft…/)
  assert.match(ctxView({ busy: 'creating', recipientId: 'u2' }), /Creating handoff…/)
  const failed = ctxView({ existing: { id: 'h1' }, error: { kind: 'unavailable', message: 'The AI service is unavailable right now.' } })
  assert.match(failed, /role="alert"[^>]*>The AI service is unavailable/); assert.match(failed, /Retry draft/); assert.match(failed, /no duplicate is created/); assert.doesNotMatch(failed, /Hand over to/)
  assert.match(ctxView({ mode: 'draft_ready', existing: { id: 'h1' } }), /href="\/handoffs\/h1"/)
  assert.match(ctxView({ mode: 'in_progress', existing: { id: 'h1' } }), /already in progress/)
  assert.doesNotMatch(ctxView({ mode: 'not_owner' }), /Generate AI Handoff/)
  assert.match(ctxView({ mode: 'no_teammates' }), /Add a teammate/)
})
test('AI handoff workflow: creates once, drafts through the existing endpoint, and reuses on retry', async () => {
  const calls = []
  const createHandoff = async to => { calls.push(['create', to]); return { handoff: { id: 'h1' } } }
  let fail = true
  const draft = async id => { calls.push(['draft', id]); if (fail) throw Object.assign(new Error('x'), { status: 503, data: { error: 'AI_SERVICE_CONNECTION_ERROR' } }); return { handoff: { id, aiDraft: { currentStatus: 's', items: [] } } } }
  let created
  await assert.rejects(workflow.generateAiHandoff({ existing: null, recipientId: 'u2', createHandoff, draft, onHandoff: id => { created = id } }))
  assert.equal(created, 'h1')
  fail = false
  const result = await workflow.generateAiHandoff({ existing: { id: created }, recipientId: 'u2', createHandoff, draft })
  assert.deepEqual(calls, [['create', 'u2'], ['draft', 'h1'], ['draft', 'h1']]) // one creation, two draft attempts
  assert.equal(result.handoff.aiDraft.currentStatus, 's')
  calls.length = 0
  await workflow.generateAiHandoff({ existing: { id: 'open-1' }, recipientId: '', createHandoff, draft })
  assert.deepEqual(calls, [['draft', 'open-1']]) // an existing open handoff is never duplicated
})
test('AI handoff workflow: errors map to no-data, unsynced, unavailable, and generic states', () => {
  const e = (status, error, message = 'm') => Object.assign(new Error(message), { status, data: { error } })
  assert.equal(workflow.describeDraftError(e(422, 'insufficient_context')).kind, 'no_data')
  assert.equal(workflow.describeDraftError(e(409, 'not_synced')).kind, 'unsynced')
  assert.equal(workflow.describeDraftError(e(504, 'AI_SERVICE_TIMEOUT')).kind, 'unavailable')
  assert.equal(workflow.describeDraftError(e(503, 'AI_SERVICE_HTTP_ERROR')).kind, 'unavailable')
  assert.equal(workflow.describeDraftError(e(409, 'conflict')).kind, 'conflict')
  assert.equal(workflow.describeDraftError(e(400, 'validation_error', 'Pick someone')).message, 'Pick someone')
})
test('AI context summary only totals counts when every repository has real data', () => {
  const ok = (i, p, status = 'completed') => ({ sync: { status, lastSuccessAt: '2026-01-02T00:00:00Z' }, stats: { state: 'ready', openIssues: i, openPullRequests: p, latestCommitAt: '2026-01-03T00:00:00Z' } })
  const both = workflow.summarizeContext([ok(2, 1), ok(3, 0)])
  assert.deepEqual([both.repositories, both.openIssues, both.openPullRequests, both.sync, both.lastActivity], [2, 5, 1, 'Up to date', '2026-01-03T00:00:00Z'])
  const mixed = workflow.summarizeContext([ok(2, 1), { sync: { status: 'pending' }, stats: { state: 'not_synced', openIssues: null } }])
  assert.equal(mixed.openIssues, null); assert.equal(mixed.sync, 'Not synced yet')
  assert.equal(workflow.summarizeContext([]).repositories, 0)
  assert.match(workflow.summarizeContext([ok(1, 1, 'failed')]).sync, /failed/)
})

const snap = (over = {}) => ({ commitSha: 'abcdef1234567', branch: 'main', status: 'completed', mode: 'full', analyzedAt: '2026-01-02T10:00:00Z', coverage: { analyzed: 118, eligible: 120, percent: 98, tooLarge: 0, overBudget: 0, secretSkipped: 0, fetchFailed: 0, binarySkipped: 0, treeTruncated: false }, changes: null, ...over })
const repoItem = (analysis = {}) => ({ connectionId: 'c1', repository: { fullName: 'acme/relay' }, analysis: { status: 'completed', snapshot: snap(), freshness: { state: 'current', reasons: [] }, error: null, ...analysis } })
const devView = (props = {}) => renderToString(React.createElement(DeveloperHandoffView, { state: 'ready', repositories: [repoItem()], analyzingIds: [], canAct: true, lastReport: null, busy: null, error: '', notice: '', onAnalyze() {}, onGenerate() {}, onPreview() {}, onDownload() {}, onRetry() {}, ...props }))
test('developer handoff: loading, error with retry, and no-repository states', () => {
  assert.match(devView({ state: 'loading' }), /Loading repository analysis/)
  const failed = devView({ state: 'error', error: 'Project not found' })
  assert.match(failed, /role="alert"[^>]*>Project not found/); assert.match(failed, /Try again/)
  const none = devView({ repositories: [] })
  assert.match(none, /Connect a GitHub repository/); assert.doesNotMatch(none, /Generate Handoff/)
})
test('developer handoff: shows the analyzed commit, coverage, freshness and actions', () => {
  const html = devView({})
  assert.match(html, /Analysis complete/); assert.match(html, /Commit abcdef1 on main/); assert.match(html, /118 of 120 eligible files \(98%\)/)
  assert.match(html, /Up to date/); assert.match(html, />Refresh analysis</); assert.match(html, />Generate Handoff</)
  assert.doesNotMatch(html, /Preview Handoff|Download PDF/) // nothing generated yet
})
test('developer handoff: never reports Complete for partial or failed analysis, and explains why', () => {
  const partial = devView({ repositories: [repoItem({ status: 'partial', snapshot: snap({ status: 'partial', coverage: { analyzed: 3, eligible: 9, percent: 33, tooLarge: 1, overBudget: 4, secretSkipped: 1, fetchFailed: 0, binarySkipped: 0, treeTruncated: true } }) })] })
  assert.match(partial, /Partial analysis/); assert.doesNotMatch(partial, /Analysis complete/)
  assert.match(partial, /1 file\(s\) were too large/); assert.match(partial, /4 file\(s\) were left out/); assert.match(partial, /credentials/); assert.match(partial, /truncated the file listing/); assert.match(partial, /knowledge base is incomplete/)
  const failed = devView({ repositories: [repoItem({ status: 'failed', error: { message: 'Relay does not have permission to read this repository’s contents. Grant the GitHub App “Contents: read” access.' } })] })
  assert.match(failed, /Analysis failed/); assert.match(failed, /Contents: read/); assert.match(failed, /previous analysis is still available/)
  const none = devView({ repositories: [repoItem({ status: 'not_analyzed', snapshot: null, freshness: null })] })
  assert.match(none, /Not analyzed/); assert.match(none, />Analyze repository</); assert.match(none, /disabled=""[^>]*>Generate Handoff/); assert.match(none, /Analyze a repository first/)
})
test('developer handoff: stale knowledge, analyzing and generating states', () => {
  const stale = devView({ repositories: [repoItem({ freshness: { state: 'stale', reasons: ['A newer commit (fffffff) exists.'] } })] })
  assert.match(stale, />Stale</); assert.match(stale, /newer commit \(fffffff\)/); assert.match(stale, /Refresh the analysis for the most accurate handoff/)
  assert.match(devView({ analyzingIds: ['c1'] }), /Analyzing…/)
  assert.match(devView({ analyzingIds: ['c1'] }), /disabled=""[^>]*>Generate Handoff/)
  assert.match(devView({ busy: 'generating' }), /Generating handoff…/)
  assert.match(devView({ error: 'The AI service is unavailable right now.' }), /role="alert"[^>]*>The AI service is unavailable/)
})
test('developer handoff: preview and PDF actions appear once a report exists; viewers cannot act', () => {
  const html = devView({ lastReport: { id: 'r1', generatedAt: '2026-01-02T10:00:00Z' } })
  assert.match(html, />Preview Handoff</); assert.match(html, />Download PDF</); assert.match(html, /Last handoff generated/)
  const viewer = devView({ canAct: false, lastReport: { id: 'r1', generatedAt: '2026-01-02T10:00:00Z' } })
  assert.doesNotMatch(viewer, /Generate Handoff|Refresh analysis|Analyze repository/); assert.match(viewer, /Download PDF/)
})
test('analysis helpers describe coverage and changes from real numbers only', () => {
  assert.deepEqual(analysisHelpers.coverageNotes({ tooLarge: 0, overBudget: 0, secretSkipped: 0, fetchFailed: 0, binarySkipped: 0, treeTruncated: false }), [])
  assert.equal(analysisHelpers.coverageNotes(null).length, 0)
  assert.equal(analysisHelpers.changeSummary({ added: ['a'], modified: ['b', 'c'], deleted: [], renamed: [{}] }), '1 added, 2 modified, 1 renamed')
  assert.equal(analysisHelpers.changeSummary({ added: [], modified: [], deleted: [], renamed: [] }), 'No file changes')
})
test('report preview shows sections, evidence links, kinds, repository identity and limitations', () => {
  const report = { projectName: 'Relay', generatedAt: '2026-01-02T10:00:00Z', limitations: ['acme/relay: 1 file(s) exceeded the size limit.'], repositories: [{ fullName: 'acme/relay', commitSha: 'a'.repeat(40), branch: 'main', status: 'partial', freshness: 'stale', coverage: { percent: 91 } }],
    sections: [{ key: 'architecture', title: 'Repository architecture', items: [{ text: 'Express server in src/server.js', kind: 'fact', evidence: [{ id: 'f', label: 'acme/relay/src/server.js@aaaaaaa', url: 'https://github.com/acme/relay/blob/aaa/src/server.js' }] }, { text: 'Deploy target unknown', kind: 'unknown', evidence: [] }] }, { key: 'links', title: 'Relevant source links', items: [{ text: 'acme/relay', kind: 'fact', evidence: [{ id: 'u', label: 'acme/relay', url: 'https://github.com/acme/relay' }] }] }] }
  const html = renderToString(React.createElement(ReportBody, { report }))
  assert.match(html, /Repository architecture/); assert.match(html, /commit aaaaaaa · main · analysis partial \(91% of eligible files\) · knowledge stale/)
  assert.match(html, /Source-backed/); assert.match(html, />Unknown</); assert.match(html, /<button[^>]*class="ws-source-button"[^>]*>acme\/relay\/src\/server\.js@aaaaaaa<\/button>/); assert.match(html, /Limitations/)
  assert.match(html, /Relevant source links/)
})

test('AI errors distinguish unreadable output, token limits, and missing keys from an unavailable service', () => {
  const e = (status, error, message) => Object.assign(new Error(message), { status, data: { error } })
  assert.equal(workflow.describeDraftError(e(502, 'AI_SERVICE_HTTP_ERROR', 'AI service rejected request (502): Malformed model output: x')).kind, 'failed')
  assert.equal(workflow.describeDraftError(e(502, 'AI_SERVICE_HTTP_ERROR', 'AI service rejected request (502): Error code: 413 - Request too large ... tokens per minute')).kind, 'too_large')
  assert.match(workflow.describeDraftError(e(503, 'AI_SERVICE_HTTP_ERROR', 'GROQ_API_KEY is not configured')).message, /GROQ_API_KEY/)
  assert.equal(workflow.describeDraftError(e(502, 'AI_SERVICE_CONNECTION_ERROR', 'Failed to connect')).kind, 'unavailable')
})

test('working tree lays out real events by branch and renders read-only activity cards', () => {
  const nodes = [
    { id: 'one', category: 'team', label: 'Teammate joined', actor: 'Sam', occurredAt: '2026-01-01T12:00:00Z', kind: 'action', status: 'completed' },
    { id: 'two', category: 'development', label: 'Code pushed', description: 'team/repo', occurredAt: '2026-01-02T12:00:00Z', kind: 'trigger', status: 'completed' },
    { id: 'three', category: 'team', label: 'Invitation sent', actor: 'Alex', occurredAt: '2026-01-03T12:00:00Z', kind: 'action', status: 'completed' },
  ]
  const graph = treeLayout.layoutWorkTree({ name: 'Launch', createdAt: '2026-01-01' }, nodes, [{ id: 'team', label: 'Team', color: '#c99cf5' }, { id: 'development', label: 'Development', color: '#ffc06b' }])
  assert.equal(graph.nodes.filter(node => node.kind !== 'lane').length, 3)
  assert.equal(graph.edges.length, 5)
  assert.ok(graph.nodes.find(node => node.id === 'three').y > graph.nodes.find(node => node.id === 'one').y)
  for (const edge of graph.edges) assert.doesNotMatch(treeLayout.treeEdgePath(edge), /NaN|undefined/)
  const html = renderToString(React.createElement(WorkTreeCanvas, { graph, selected: 'two', onSelect() {} }))
  assert.match(html, /Teammate joined/); assert.match(html, /Code pushed/); assert.match(html, /aria-pressed="true"/)
  assert.doesNotMatch(html, /draggable=|Add node|Execute workflow/)
})

const doc = (over = {}) => ({ id: 'd1', title: 'Requirements', filename: 'requirements.pdf', mimeType: 'application/pdf', size: 52_000, uploadedBy: 'user-owner', createdAt: '2026-01-02T10:00:00Z', status: 'indexed', error: null, chunkCount: 7, pageCount: 4, canRetry: false, noExtractableText: false, ...over })
const docsView = props => renderToString(React.createElement(ProjectDocumentsView, { state: 'ready', documents: [], canUpload: true, canManageDocument: () => true, onPick() {}, onDrop() {}, onDragState() {}, onRetryLoad() {}, ...props }))

test('project documents: empty state, upload button, drag-and-drop zone and loading state', () => {
  const html = docsView()
  assert.match(html, /Project documents/); assert.match(html, /Upload document/); assert.match(html, /Drag a PDF, DOCX or TXT/); assert.match(html, /No documents yet/)
  assert.match(html, /accept="\.pdf,\.docx,\.txt"/)
  assert.match(docsView({ state: 'loading' }), /Loading documents/)
  const viewer = docsView({ canUpload: false })
  assert.doesNotMatch(viewer, /Upload document/); assert.doesNotMatch(viewer, /Drag a PDF/)
})

test('project documents: rows show name, format, size, pages, upload date, status and section count', () => {
  const html = docsView({ documents: [doc()] })
  assert.match(html, /Requirements/); assert.match(html, /PDF/); assert.match(html, /51 KB/); assert.match(html, /4 pages/); assert.match(html, /Uploaded 2 Jan/)
  assert.match(html, /Indexed/); assert.match(html, /7 sections available to handoffs/)
  assert.match(html, />Preview</); assert.match(html, />Download</); assert.match(html, />Replace</); assert.match(html, />Delete</)
})

test('project documents: failed and processing documents show the error, retry and no false success', () => {
  const failed = docsView({ documents: [doc({ status: 'failed', canRetry: true, chunkCount: 0, error: { code: 'CHUNK_INDEXING_FAILED', message: 'The document could not be indexed.' } })] })
  assert.match(failed, /Failed/); assert.match(failed, /The document could not be indexed\./); assert.match(failed, /Retry processing/); assert.doesNotMatch(failed, /available to handoffs/)
  assert.match(docsView({ documents: [doc({ status: 'processing', chunkCount: 0 })] }), /Processing…/)
  assert.match(docsView({ documents: [doc({ chunkCount: 0, noExtractableText: true })] }), /No extractable text was found/)
  assert.doesNotMatch(docsView({ documents: [doc({ status: 'failed', canRetry: true })], canManageDocument: () => false }), /Retry processing|>Delete</)
})

test('project documents: delete asks for confirmation and explains what is kept', () => {
  const html = docsView({ documents: [doc()], confirmingId: 'd1' })
  assert.match(html, /Confirm delete/); assert.match(html, /Reports already generated are kept/); assert.match(html, /Delete document/)
})

test('document validation mirrors the server rules with clear messages', () => {
  const { validateDocumentFile, formatBytes } = documentHelpers
  assert.match(validateDocumentFile({ name: 'a.exe', size: 10 }), /Unsupported format/)
  assert.match(validateDocumentFile({ name: 'a.txt', size: 0 }), /empty/)
  assert.match(validateDocumentFile({ name: 'a.pdf', size: 11 * 1024 * 1024 }), /larger than 10\.0 MB/)
  assert.equal(validateDocumentFile({ name: 'Notes.DOCX', size: 5 }), '')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(documentsApi.DOCUMENT_ACCEPT, '.pdf,.docx,.txt')
})

test('handoff report shows document sources next to GitHub sources, typed, with a private (non-link) document reference', () => {
  const report = { projectId: 'p1', projectName: 'Relay', generatedAt: '2026-01-02T10:00:00Z', limitations: [], repositories: [],
    sections: [{ key: 'blockers_risks', title: 'Blockers and risks', items: [{ text: 'Conflict: preflight support is required but issue 8 is open.', kind: 'inference', evidence: [
      { id: 'doc:1:0', type: 'document', label: 'Document "Spec" > CORS, p. 2', url: null, document: { documentId: 'd1', chunkId: 'd1:0', filename: 'spec.pdf', heading: 'CORS', pageStart: 2 } },
      { id: 'i8', type: 'issue', label: 'acme/relay issue #8', url: 'https://github.com/acme/relay/issues/8' },
      { id: 'f', type: 'repository_file', label: 'acme/relay/src/server.js@aaaaaaa', url: 'https://github.com/acme/relay/blob/aaa/src/server.js' }] }] }] }
  const html = renderToString(React.createElement(ReportBody, { report, onOpenDocument() {} }))
  assert.match(html, /Uploaded document/); assert.match(html, /GitHub issue/); assert.match(html, /Repository file/)
  assert.match(html, /<button[^>]*>Document &quot;Spec&quot; &gt; CORS, p\. 2<\/button>/); assert.match(html, /ref d1:0/)
  assert.match(html, /<button[^>]*class="ws-source-button"[^>]*>acme\/relay issue #8<\/button>/)
  assert.doesNotMatch(html, /href="[^"]*documents/)
})


const jiraView = props => renderToString(React.createElement(MemoryRouter, null, React.createElement(ConnectedJiraProjectsView, { state: 'ready', links: [], canManage: true, canSync: true, jiraConnected: true, keyInput: '', onKeyInput() {}, onLink() {}, onSync() {}, onAskRemove() {}, onCancel() {}, onRemove() {}, ...props })))

test('jira projects: empty state with a key form, or a connect prompt when the account is not connected', () => {
  assert.match(jiraView(), /No Jira project linked yet/); assert.match(jiraView(), /Link Jira project/)
  const disconnected = jiraView({ jiraConnected: false })
  assert.match(disconnected, /Connect Jira/); assert.doesNotMatch(disconnected, /Link Jira project/)
  assert.doesNotMatch(jiraView({ canManage: false }), /Link Jira project/)
  assert.equal(isJiraKey('PAY'), true); assert.equal(isJiraKey('pay'), false); assert.equal(isJiraKey('P'), false)
  assert.match(jiraView({ keyInput: 'x-1' }), /such as PROJ/)
})

test('jira projects: linked rows show status, counts, errors and the unlink confirmation', () => {
  const ok = { id: 'j1', projectKey: 'PAY', siteName: 'Acme', sync: { status: 'completed', lastSuccessAt: '2026-10-10T10:00:00Z', syncedIssueCount: 12 } }
  const html = jiraView({ links: [ok] })
  assert.match(html, /Jira project PAY/); assert.match(html, />Synced</); assert.match(html, /12 issues available to handoffs/); assert.match(html, /Sync now/); assert.match(html, />Unlink</)
  const failed = jiraView({ links: [{ ...ok, sync: { status: 'failed', error: 'Jira rejected the credentials.' } }] })
  assert.match(failed, /Sync failed/); assert.match(failed, /Jira rejected the credentials/); assert.doesNotMatch(failed, /issues available/)
  assert.match(jiraView({ links: [ok], confirmingId: 'j1' }), /removed from this project and future handoffs/)
  assert.doesNotMatch(jiraView({ links: [ok], canManage: false, canSync: false }), /Unlink|Sync now/)
})

test('handoff report distinguishes Jira and Slack sources', () => {
  const report = { projectId: 'p1', projectName: 'Relay', generatedAt: '2026-01-02T10:00:00Z', limitations: [], repositories: [], sections: [{ key: 'tracked_work_and_discussion', title: 'Tracked work and team discussion (Jira, Slack)', items: [{ text: 'PAY-12 is in progress.', kind: 'fact', evidence: [
    { id: 'j', type: 'jira_issue', label: 'Jira PAY-12', url: 'https://acme.atlassian.net/browse/PAY-12' }, { id: 's', type: 'slack_message', label: 'Slack #payments 2026-10-01', url: null }] }] }] }
  const html = renderToString(React.createElement(ReportBody, { report }))
  assert.match(html, /Jira issue/); assert.match(html, /Slack message/); assert.match(html, /<button[^>]*class="ws-source-button"[^>]*>Jira PAY-12<\/button>/)
})


test('Notion offers browser authorization when OAuth is configured', () => {
  const html = render(() => React.createElement(ConnectionsView, {
    notion: { status: { connected: false, configured: true }, form: { apiKey: '', databaseId: '' }, setForm() {}, onInstall() {} },
  }), '/connections')
  assert.match(html, /Authorize with Notion/)
  assert.match(html, /Use an integration token instead/)
})


test('project chat renders cited evidence as text and exposes accessible question controls', async () => {
  const { ProjectChatView } = await server.ssrLoadModule('/src/workspace/ProjectChat.jsx')
  const html = renderToString(React.createElement(ProjectChatView, { question: '', onQuestion() {}, turns: [{ id: 'c1', question: 'Retry policy?', answer: 'Retry three times [S1].', citations: [{ id: 'S1', title: 'Team decision', provider: 'slack', text: '<script>unsafe()</script>', url: 'https://example.test/source' }] }] }))
  assert.match(html, /Retry three times/)
  assert.match(html, /Team decision/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /Ask a question about this project/)
  const statusHtml = renderToString(React.createElement(ProjectChatView, { question: '', onQuestion() {}, knowledgeStatus: ['team/repo: partial analysis, commit abc1234.', '2 files too large.'] }))
  assert.match(statusHtml, /Available project evidence/)
  assert.match(statusHtml, /abc1234/)
  assert.match(statusHtml, /2 files too large/)
})


test('partial analysis explains what Refresh will and will not retry', () => {
  const repo = retryable => ({ connectionId: 'c1', repository: { fullName: 'acme/relay' }, analysis: { status: 'partial', retryable, freshness: { state: 'current' }, snapshot: { commitSha: 'a'.repeat(40), branch: 'main', status: 'partial', mode: 'incremental', analyzedAt: '2026-01-02T10:00:00Z', coverage: { analyzed: 66, eligible: 75, percent: 88, tooLarge: 9, limits: {} }, changes: { added: [], modified: [], deleted: [], renamed: [] } } } })
  const render = r => renderToString(React.createElement(DeveloperHandoffView, { state: 'ready', repositories: [r], canAct: true }))
  assert.match(render(repo(0)), /Refresh re-checks only changed files; files over the size limit, binary files and files containing credentials are not retried/)
  assert.match(render(repo(3)), /3 file\(s\) can be retried; Refresh will fetch only those and anything that changed/)
})


const briefReport = () => ({
  projectId: 'p1', projectName: 'SNS PROJECT', generatedAt: '2026-10-12T20:06:00Z', complexity: 'small', summary: 'A Python AM/FM demo.',
  repositories: [{ fullName: 'acme/am-fm', branch: 'main', commitSha: '8607ab2afcfc0be132913f9cb2c7e81dc45d7ce6', status: 'partial', coverage: { analyzed: 66, eligible: 75, percent: 88 }, freshness: 'current' }],
  verification: { coverage: [{ repository: 'acme/am-fm', gaps: ['9 file(s) over the size limit'] }] },
  brief: {
    summary: 'A Python AM/FM demo.',
    currentState: [{ text: 'main.py defines am_modulate and am_demodulate.', kind: 'fact', refs: [1] }],
    status: [{ label: 'Tracked work', text: '0 open PR(s). An empty tracker describes the trackers only.' }, { label: 'Verification', text: 'No test files found, none executed by Relay; completion not established.' }],
    doFirst: [{ type: 'recommendation', n: 1, text: 'Parameterize the cutoff in am_demodulate', priority: 'P2', basis: 'suggested', why: 'It is hard-coded.', doneWhen: 'am_demodulate accepts a cutoff argument', prerequisites: ['numpy installed'], files: ['main.py'], symbols: ['am_demodulate'], refs: [1], kind: 'inference' }],
    findings: { counts: { conflicts: 1 }, text: '1 documentation conflict, 1 confirmed blocker. Each is explained once under Known Risks, Unknowns, and Verification Status.' },
  },
  sections: [
    { key: 'walkthrough', title: 'Architecture and Technical Walkthrough', origin: 'ai', items: [
      { text: 'Scipy filters the envelope.', type: 'overview', kind: 'inference', refs: [1] },
      { text: 'Modulate and recover', type: 'subsystem', kind: 'fact', purpose: 'Shows AM on a carrier.', entry: 'main.py', flow: 'main.py calls am_modulate then am_demodulate.', steps: ['am_modulate scales the carrier.', 'am_demodulate recovers the envelope.'],
        functions: [{ name: 'am_modulate', file: 'main.py', line: 12, role: 'Scales the carrier by the message.' }], calls: [{ from: 'update', to: 'am_modulate', line: 40 }], inputs: ['fm slider'], outputs: ['plots'], dependencies: ['numpy'], limits: ['FM is not implemented.'], files: ['main.py'], symbols: ['am_modulate'], refs: [1] }] },
    { key: 'first_30', title: 'Your First 30 Minutes', origin: 'ai', intro: 'A suggested order for a new owner, not a measured estimate of how long each step takes.', items: [{ type: 'step', text: 'Trace the primary workflow', detail: 'Follow the first path from main.py.', reads: [{ file: 'main.py', why: 'defines am_modulate' }], kind: 'inference', refs: [1] }] },
    { key: 'documented_vs_implemented', title: 'Documentation vs code', group: 'Known Risks, Unknowns, and Verification Status', origin: 'ai', items: [{ type: 'comparison', status: 'conflicts', text: 'Tokens expire in 15 minutes: code differs', kind: 'fact', refs: [2], resolvedLabel: 'Do first #1' }] },
    { key: 'blockers_risks', title: 'Blockers and risks', group: 'Known Risks, Unknowns, and Verification Status', origin: 'ai', items: [{ text: 'Retry queue PR is blocked.', kind: 'fact', label: 'confirmed', refs: [1] }, { text: 'Hard-coded cutoff may distort other signals.', kind: 'inference', label: 'inferred risk', refs: [1] }] },
    { key: 'unknowns', title: 'Unknowns', group: 'Known Risks, Unknowns, and Verification Status', origin: 'ai', items: [{ text: 'No run instructions exist.', kind: 'unknown', refs: [] }] },
    { key: 'verification', title: 'Verification status', group: 'Known Risks, Unknowns, and Verification Status', origin: 'deterministic', items: [{ type: 'status', label: 'Tests', text: 'No test files or scripts found; none were executed' }, { type: 'status', label: 'Completion', text: 'Completion is not established: no tests were executed.' }] },
    { key: 'open_items', title: 'Open pull requests and issues', group: 'Open Work and Recent Changes', origin: 'deterministic', items: [{ text: 'PR #3: Add retry queue', kind: 'fact', inline: true, refs: [], evidence: [{ id: 'pr3', type: 'pull_request', label: 'acme/am-fm PR #3', url: 'https://github.com/acme/am-fm/pull/3' }] }] },
  ],
  sourceIndex: [
    { n: 1, id: 'file:1:main.py', type: 'repository_file', label: 'acme/am-fm/main.py@8607ab2', url: 'https://github.com/acme/am-fm/blob/8607ab2/main.py' },
    { n: 2, id: 'doc:d1:0', type: 'document', label: 'Document "PRD" > Auth, p. 2', url: null, document: { documentId: 'd1', chunkId: 'd1:0', filename: 'prd.pdf' } },
  ],
  limitations: ['Automated validation corrected the AI output before it was stored: 2 completion/execution claim(s) no evidence supports.'],
})

test('engineering handoff preview: summary, verified state, actions, walkthrough, onboarding, risks and verification in order', () => {
  const report = briefReport()
  const html = renderToString(React.createElement(ReportBody, { report, onOpenDocument() {} }))
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/\s+/g, ' ')
  const order = ['Executive summary', 'Current verified state', 'Do first', 'Architecture and Technical Walkthrough', 'Your First 30 Minutes', 'class="ws-group">Known Risks, Unknowns, and Verification Status', 'Documentation vs code', 'Verification status', 'Open Work and Recent Changes', 'Sources', 'Limitations and data quality']
  let last = -1
  for (const heading of order) { const at = html.indexOf(heading); assert.ok(at > last, `${heading} follows the previous heading`); last = at }
  assert.equal(html.split('class="ws-group"').length - 1, 2, 'one heading per group')
  for (const t of ['Verified fact', 'Inference', 'Unknown', 'Conflict', 'Confirmed', 'Inferred risk', 'P2 suggested']) assert.ok(text.includes(t), t)
  assert.match(text, /Why: It is hard-coded\./); assert.match(text, /Done when: am_demodulate accepts a cutoff argument/); assert.match(text, /Needs first: numpy installed/)
  assert.match(text, /Purpose: Shows AM on a carrier\./); assert.match(text, /Entry point: main\.py/); assert.match(text, /Execution flow: am_modulate scales the carrier/)
  assert.match(text, /am_modulate \(main\.py:12\) Scales the carrier by the message\./); assert.match(text, /update -> am_modulate \(L40\)/); assert.match(text, /Limitations: FM is not implemented\./)
  assert.match(text, /not a measured estimate/); assert.match(text, /main\.py defines am_modulate/)
  assert.match(text, /Tracked work 0 open PR\(s\)/); assert.match(text, /Needs attention: 1 documentation conflict/); assert.match(text, /Addressed by: Do first #1/)
  assert.match(text, /Tests No test files or scripts found; none were executed/); assert.match(text, /Completion Completion is not established/); assert.match(text, /not analyzed: 9 file\(s\) over the size limit/)
  assert.match(html, /<sup class="ws-refs">\[<span><a href="#src-1">1<\/a><\/span>\]<\/sup>/); assert.match(html, /<li id="src-2" value="2">/)
  assert.match(html, /<a href="https:\/\/github.com\/acme\/am-fm\/pull\/3"[^>]*>PR #3: Add retry queue<\/a>/, 'deterministic items link inline')
  assert.match(html, /<button[^>]*>Document &quot;PRD&quot; &gt; Auth, p\. 2<\/button>/); assert.match(html, /ref d1:0/); assert.doesNotMatch(html, /href="[^"]*prd\.pdf/)
  assert.match(html, /href="https:\/\/github.com\/acme\/am-fm\/blob\/8607ab2\/main\.py"/)
})

test('engineering handoff preview shows every statement of the stored report exactly once (single source of truth with the PDF)', () => {
  const report = briefReport()
  const text = renderToString(React.createElement(ReportBody, { report })).replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ')
  const items = [...report.brief.currentState, ...report.brief.doFirst, ...report.sections.flatMap(s => s.items)]
  for (const item of items) { const shown = item.text || item.detail; assert.equal(text.split(shown).length - 1, 1, `appears once: ${shown}`) }
})

test('reports stored before the walkthrough layout still render their attention list and verification block', () => {
  const old = briefReport()
  old.brief = { ...old.brief, findings: undefined, status: undefined, attention: [{ text: 'No run instructions exist.', kind: 'unknown', refs: [] }] }
  old.sections = old.sections.filter(s => s.key === 'open_items')
  old.verification = { ...old.verification, tests: { discovered: { fileCount: 0, scripts: [], frameworks: [] }, executed: { detail: 'No test results are available.' } }, runtime: { detail: 'Not verified.' }, requirements: { detail: 'None provided.' }, workTracking: { detail: 'Nothing open.' }, completion: { detail: 'Completion is not established.' } }
  const text = renderToString(React.createElement(ReportBody, { report: old })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.match(text, /Needs attention/); assert.match(text, /No run instructions exist\./); assert.match(text, /Verification status/); assert.match(text, /Tests executed No test results are available\./)
})

test('reports created before the engineering layout still render with the earlier layout', () => {
  const legacy = { projectName: 'Old', generatedAt: '2026-01-02T10:00:00Z', limitations: [], repositories: [], sections: [{ key: 'architecture', title: 'Repository architecture', items: [{ text: 'Old style claim', kind: 'fact', evidence: [] }] }] }
  const html = renderToString(React.createElement(ReportBody, { report: legacy }))
  assert.match(html, /Repository architecture/); assert.match(html, /Old style claim/); assert.doesNotMatch(html, /Verification status/)
})
