import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { createServer } from 'vite'

let server, api, sessions, AuthContext, WorkspaceContext, pages, HandoffDetailPage, WorkspaceLayout
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
  server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' })
  api = await server.ssrLoadModule('/src/api/client.js')
  sessions = await server.ssrLoadModule('/src/auth/session.js')
  ;({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.js'))
  ;({ WorkspaceContext } = await server.ssrLoadModule('/src/workspace/WorkspaceContext.js'))
  pages = await server.ssrLoadModule('/src/workspace/WorkspacePages.jsx')
  ;({ default: HandoffDetailPage } = await server.ssrLoadModule('/src/workspace/HandoffDetailPage.jsx'))
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
