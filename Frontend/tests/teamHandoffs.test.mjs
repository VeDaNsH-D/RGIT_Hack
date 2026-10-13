import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { createServer } from 'vite'

let server, mods, AuthContext, WorkspaceContext, HandoffDetailPage
const storage = new Map()
const originalWindow = globalThis.window
const originalStorage = globalThis.sessionStorage

const alex = { id: 'u-alex', name: 'Alex Parker', email: 'alex@example.test' }
const priya = { id: 'u-priya', name: 'Priya Rao', email: 'priya@example.test' }
const members = [
  { userId: alex.id, name: alex.name, email: alex.email, role: 'owner' },
  { userId: priya.id, name: priya.name, email: priya.email, role: 'member' },
]
const handoff = (over = {}) => ({
  id: 'h1', projectId: 'p1', fromUserId: alex.id, toUserId: priya.id, state: 'SUBMITTED', isOpen: true,
  transferType: 'inter_team', fromTeamId: 't-backend', toTeamId: 't-ai', reason: 'Needs model expertise', instructions: 'Start with the inference notebook',
  currentStatus: 'Stable', items: [], supportingLinks: [], documentIds: [], clarifications: [], version: 3, submittedAt: '2026-10-12T10:00:00Z',
  contextSnapshot: { capturedAt: '2026-10-12T10:00:00Z', hash: 'abcdef1234567890', currentStatus: 'Stable', items: [{ type: 'pending', text: 'Tune the model' }], openTasks: [{ id: 'k1', title: 'Fix drift', priority: 'high', assignee: priya.id, deadline: null }], documents: [{ id: 'd1', title: 'Runbook' }], openConflicts: [{ id: 'c1', title: 'Deadline mismatch', severity: 'high' }], aiGenerated: { generatedAt: '2026-10-12T09:00:00Z' }, readiness: { score: 90, ready: true, missingFields: [] } },
  ...over,
})
const project = { id: 'p1', name: 'Relay', ownerId: alex.id, owningTeamId: 't-backend', myRole: 'owner', context: { members }, tasks: [], handoffs: [handoff()] }

function renderPage(Component, path, pattern, user, handoffs) {
  const workspace = { projects: [{ ...project, handoffs }], tasks: [], handoffs, loading: false, error: '', async reload() {} }
  const auth = { session: { token: 't', user }, checking: false, error: '', signOut() {}, acceptSession() {} }
  return clean(renderToString(React.createElement(MemoryRouter, { initialEntries: [path] },
    React.createElement(AuthContext.Provider, { value: auth }, React.createElement(WorkspaceContext.Provider, { value: workspace },
      React.createElement(Routes, null, React.createElement(Route, { path: pattern, element: React.createElement(Component) })))))))
}
// React inserts <!-- --> between adjacent text nodes; strip them so assertions read like the page.
const clean = html => html.replaceAll('<!-- -->', '')
const view = element => clean(renderToString(React.createElement(MemoryRouter, null, element)))

before(async () => {
  globalThis.window = new EventTarget()
  window.location = { search: '' }
  globalThis.sessionStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  server = await createServer({ envDir: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' })
  ;({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.js'))
  ;({ WorkspaceContext } = await server.ssrLoadModule('/src/workspace/WorkspaceContext.js'))
  ;({ default: HandoffDetailPage } = await server.ssrLoadModule('/src/workspace/HandoffDetailPage.jsx'))
  mods = {
    teams: await server.ssrLoadModule('/src/workspace/TeamsSection.jsx'),
    transfer: await server.ssrLoadModule('/src/workspace/HandoffTransfer.jsx'),
    dest: await server.ssrLoadModule('/src/workspace/HandoffDestination.jsx'),
  }
})
after(async () => {
  await server?.close()
  globalThis.window = originalWindow
  globalThis.sessionStorage = originalStorage
})

const team = (over = {}) => ({
  otherProjects: 0, projectCount: 1,
  id: 't-ai', name: 'AI/ML', description: 'Model work', leaderId: priya.id, leader: { userId: priya.id, name: priya.name }, isActive: true, ownsProject: false,
  members: [{ userId: priya.id, name: priya.name, email: priya.email, role: 'leader' }], activeCases: 0, incomingHandoffs: 2, outgoingHandoffs: 1, ...over,
})

test('team list shows leader, members and handoff counts, and filters by search and inactive', () => {
  const props = { state: { teams: [team(), team({ id: 't2', name: 'Legacy', isActive: false })], loading: false }, search: '', onSearch() {}, showInactive: false, onShowInactive() {}, canManage: true, creating: false, onCreate() {}, form: null, onOpen() {}, error: '', notice: '' }
  const html = view(React.createElement(mods.teams.TeamsList, props))
  assert.match(html, /AI\/ML/); assert.match(html, /Priya Rao/); assert.match(html, /Incoming/); assert.match(html, /\+ New team/)
  assert.doesNotMatch(html, /Legacy/)
  assert.match(view(React.createElement(mods.teams.TeamsList, { ...props, showInactive: true })), /Legacy/)
  assert.match(view(React.createElement(mods.teams.TeamsList, { ...props, search: 'zzz' })), /No teams match your search/)
  assert.doesNotMatch(view(React.createElement(mods.teams.TeamsList, { ...props, canManage: false })), /\+ New team/)
})

test('team details hide management actions from people who cannot manage the team', () => {
  const detail = { team: team({ members: [...team().members, { userId: alex.id, name: alex.name, email: alex.email, role: 'member' }] }), cases: [], handoffs: [] }
  const render = (canManage, canManageRoster) => view(React.createElement(mods.teams.TeamDetailView, { detail, projectMembers: members, canManage, canManageRoster, canUnlink: canManage, busy: false, error: '', notice: '', onBack() {}, onAction() {} }))
  const owner = render(true, true)
  assert.match(owner, /Make leader/); assert.match(owner, /Deactivate/); assert.match(owner, /Edit team/)
  const leader = render(false, true)
  assert.match(leader, /Remove/); assert.doesNotMatch(leader, /Make leader/); assert.doesNotMatch(leader, /Deactivate/)
  const plain = render(false, false)
  assert.doesNotMatch(plain, /Remove/); assert.doesNotMatch(plain, /Edit team/)
})

test('destination picker separates the receiving team from the named recipient and shows the transfer type', () => {
  const props = { project, teams: [{ id: 't-backend', name: 'Backend', leaderName: 'Alex Parker', memberCount: 2, projectCount: 1, projects: [{ id: 'p1', name: 'Relay' }], hiddenProjectCount: 0, linked: true }, { id: 't-ai', name: 'AI/ML', leaderName: 'Priya Rao', memberCount: 3, projectCount: 2, projects: [{ id: 'p2', name: 'Other app' }], hiddenProjectCount: 1, linked: false }], teamsLoading: false, teamQuery: '', onTeamQuery() {}, selectedTeam: { id: 't-ai', name: 'AI/ML' }, teamId: '', onTeam() {}, recipients: [], recipientsLoading: false, recipient: '', onRecipient() {}, reason: '', onReason() {}, instructions: '', onInstructions() {}, error: '', individualRecipients: [members[1]] }
  const individual = view(React.createElement(mods.dest.DestinationFieldsView, props))
  assert.match(individual, /Person to person/); assert.doesNotMatch(individual, /Reason for transfer/)
  const inter = view(React.createElement(mods.dest.DestinationFieldsView, { ...props, teamId: 't-ai', recipients: [{ userId: priya.id, name: priya.name, isLeader: true, openTasks: 3 }] }))
  assert.match(inter, /Inter-team transfer/); assert.match(inter, /Recipient in AI\/ML/); assert.match(inter, /Team leader/); assert.match(inter, /3 open tasks/); assert.match(inter, /Reason for transfer/)
  const intra = view(React.createElement(mods.dest.DestinationFieldsView, { ...props, teamId: 't-backend' }))
  assert.match(intra, /Intra-team transfer/)
  const empty = view(React.createElement(mods.dest.DestinationFieldsView, { ...props, teamId: 't-ai', recipients: [] }))
  assert.match(empty, /None of this team’s members are on this project/)
})

test('handoff preview shows both teams, the reason, context snapshot and a stale warning', () => {
  const html = view(React.createElement(React.Fragment, null,
    React.createElement(mods.transfer.TransferSummary, { handoff: handoff(), project, fromTeam: { name: 'Backend' }, toTeam: { name: 'AI/ML' } }),
    React.createElement(mods.transfer.ContextSnapshotPanel, { snapshot: handoff().contextSnapshot, stale: true, project })))
  for (const pattern of [/Inter-team transfer/, /Backend/, /AI\/ML/, /Needs model expertise/, /Start with the inference notebook/, /Ownership stays with Alex Parker/, /abcdef1234/, /Fix drift/, /Runbook/, /Deadline mismatch/, /Project data has changed/, /Entered by sender/, /AI-generated/, /90%/]) assert.match(html, pattern)
})

test('rejected handoffs surface the reason and do not claim ownership is pending', () => {
  const html = view(React.createElement(mods.transfer.TransferSummary, { handoff: handoff({ state: 'REJECTED', rejectionReason: 'Out of scope', rejectedAt: '2026-10-13T00:00:00Z' }), project, fromTeam: null, toTeam: null }))
  assert.match(html, /Out of scope/); assert.doesNotMatch(html, /Ownership stays with/)
})

test('incoming and outgoing lists show only the right handoffs and honour the status filter', () => {
  const handoffs = [handoff(), handoff({ id: 'h2', state: 'REJECTED', rejectionReason: 'No capacity', isOpen: false, fromUserId: priya.id, toUserId: alex.id })]
  const list = (userId, direction, stateFilter) => view(React.createElement(mods.transfer.HandoffInboxView, { handoffs, projects: [project], userId, direction, stateFilter }))
  assert.match(list(priya.id, 'incoming', 'all'), /href="\/handoffs\/h1"/)
  assert.doesNotMatch(list(priya.id, 'incoming', 'all'), /h2/)
  assert.match(list(priya.id, 'outgoing', 'rejected'), /No capacity/)
  assert.match(list(priya.id, 'outgoing', 'open'), /You haven’t sent any handoffs/)
  assert.match(list(alex.id, 'incoming', 'rejected'), /No capacity/)
  assert.match(list(alex.id, 'incoming', 'accepted'), /Nothing is waiting for you/)
})

test('ownership timeline renders team-to-team transfers with reasons, and loading and error states', () => {
  const data = { current: { owner: { name: 'Priya Rao' }, team: { name: 'AI/ML' } }, ownershipHistory: [{ handoffId: 'h1', changedAt: '2026-10-13T00:00:00Z', fromUser: { name: 'Alex Parker' }, toUser: { name: 'Priya Rao' }, fromTeam: { name: 'Backend' }, toTeam: { name: 'AI/ML' }, reason: 'Needs model expertise', initiatedBy: { name: 'Alex Parker' }, acceptedBy: { name: 'Priya Rao' } }] }
  const html = view(React.createElement(mods.transfer.OwnershipTimelineView, { data, loading: false, error: '' }))
  assert.match(html, /Backend \/ Alex Parker/); assert.match(html, /AI\/ML \/ Priya Rao/); assert.match(html, /Needs model expertise/); assert.match(html, /accepted by Priya Rao/)
  assert.match(view(React.createElement(mods.transfer.OwnershipTimelineView, { data: null, loading: true, error: '' })), /Loading ownership timeline/)
  assert.match(view(React.createElement(mods.transfer.OwnershipTimelineView, { data: null, loading: false, error: 'Nope' })), /Nope/)
  assert.match(view(React.createElement(mods.transfer.OwnershipTimelineView, { data: { current: { owner: { name: 'A' } }, ownershipHistory: [] }, loading: false, error: '' })), /hasn’t been transferred yet/)
})

test('the recipient sees accept, request changes and reject; the sender does not', () => {
  const asRecipient = renderPage(HandoffDetailPage, '/handoffs/h1', '/handoffs/:handoffId', priya, [handoff()])
  for (const pattern of [/Accept ownership/, /Request changes/, /Reject handoff/, /Inter-team transfer/, /Context submitted for review/]) assert.match(asRecipient, pattern)
  const asSender = renderPage(HandoffDetailPage, '/handoffs/h1', '/handoffs/:handoffId', alex, [handoff()])
  assert.doesNotMatch(asSender, /Accept ownership/); assert.doesNotMatch(asSender, /Reject handoff/); assert.match(asSender, /Cancel handoff/)
  const closed = renderPage(HandoffDetailPage, '/handoffs/h1', '/handoffs/:handoffId', priya, [handoff({ state: 'REJECTED', isOpen: false, rejectionReason: 'Out of scope' })])
  assert.doesNotMatch(closed, /Accept ownership/); assert.match(closed, /Out of scope/)
})

test('team picker shows every distinct team with its projects, marks ones not yet on this project, and is searchable', () => {
  const teams = [
    { id: 't0', name: 'Team 1', leaderName: 'Priya Rao', memberCount: 3, projectCount: 2, projects: [{ id: 'p1', name: 'Relay' }, { id: 'p2', name: 'Second app' }], hiddenProjectCount: 0, linked: true },
    { id: 't1', name: 'Platform', leaderName: 'Dana Lee', memberCount: 1, projectCount: 3, projects: [{ id: 'p3', name: 'Billing' }], hiddenProjectCount: 2, linked: false },
    { id: 't2', name: 'Lonely', leaderName: 'Sam', memberCount: 1, projectCount: 0, projects: [], hiddenProjectCount: 0, linked: false },
  ]
  const html = view(React.createElement(mods.dest.TeamPicker, { teams, loading: false, value: 't1', onChange() {}, currentTeamId: 't0', projectId: 'p1', query: '' }))
  for (const pattern of [/Team 1/, /Platform/, /No team/, /Current team/, /aria-label="Search teams"/, /Relay/, /Second app/, /Billing/, /\+2 more/, /Not on any project yet/, /Led by Priya Rao · 3 members · 2 projects/]) assert.match(html, pattern)
  assert.match(html, /aria-checked="true"[^>]*class="selected"[^>]*><strong>Platform/)
  assert.equal((html.match(/It will be added when you create the handoff/g) || []).length, 2) // Platform and Lonely are not on Relay
  assert.match(view(React.createElement(mods.dest.TeamPicker, { teams: [], loading: false, value: '', onChange() {}, query: 'zzz' })), /No teams match “zzz”/)
  assert.match(view(React.createElement(mods.dest.TeamPicker, { teams: [], loading: false, value: '', onChange() {} })), /You don’t have any teams yet/)
  assert.match(view(React.createElement(mods.dest.TeamPicker, { teams: [], loading: true, value: '', onChange() {} })), /Searching teams/)
})

test('creating a team shows the automatic name, and the shared-team badge appears on cards', () => {
  const form = view(React.createElement(mods.teams.CreateTeamForm, { projectMembers: members, defaultName: 'Team 3', busy: false, error: '', onSubmit() {}, onCancel() {} }))
  assert.match(form, /Team 3 \(auto-numbered\)/); assert.match(form, /becomes “Team 3”/)
  assert.doesNotMatch(form, /<input[^>]*required[^>]*placeholder="Team 3/)
  assert.match(view(React.createElement(mods.teams.TeamCard, { team: team({ otherProjects: 2 }), onOpen() {} })), /\+2 other projects/)
  assert.doesNotMatch(view(React.createElement(mods.teams.TeamCard, { team: team(), onOpen() {} })), /other project/)
})

test('the add-existing-team panel shows leader, size and project count, and marks teams already on the project', () => {
  const results = [{ id: 'a', name: 'AI/ML', leaderName: 'Priya Rao', memberCount: 4, projectCount: 3, projects: [{ id: 'p1', name: 'Relay' }], hiddenProjectCount: 2, linked: false }, { id: 'b', name: 'Platform', leaderName: 'Dana Lee', memberCount: 1, projectCount: 1, projects: [], hiddenProjectCount: 0, linked: true }]
  const html = view(React.createElement(mods.teams.LinkTeamPanelView, { search: '', onSearch() {}, results, loading: false, busyId: '', error: '', onLink() {}, onClose() {} }))
  for (const pattern of [/Led by Priya Rao · 4 members · 3 projects/, /Relay/, /\+2 more/, /Add to project/, /Already here/, /Led by Dana Lee · 1 member · 1 project/]) assert.match(html, pattern)
  assert.match(view(React.createElement(mods.teams.LinkTeamPanelView, { search: 'zzz', onSearch() {}, results: [], loading: false, busyId: '', error: '', onLink() {}, onClose() {} })), /No teams found/)
})

test('members who are not on this project show no contact details', () => {
  const detail = { team: team({ otherProjects: 1, members: [{ userId: priya.id, name: priya.name, email: priya.email, role: 'leader', onProject: true }, { userId: 'u-x', name: 'Remote Member', email: '', role: 'member', onProject: false }] }), cases: [], handoffs: [] }
  const html = view(React.createElement(mods.teams.TeamDetailView, { detail, projectMembers: members, canManage: false, canManageRoster: false, canUnlink: false, busy: false, error: '', notice: '', onBack() {}, onAction() {} }))
  assert.match(html, /Not on this project/); assert.match(html, /also works on 1 other project/); assert.match(html, /priya@example\.test/)
})

test('an empty project offers to form a team from its members, but only to owners', () => {
  const base = { state: { teams: [], loading: false }, search: '', onSearch() {}, showInactive: false, onShowInactive() {}, creating: false, onCreate() {}, form: null, onOpen() {}, error: '', notice: '', onFromMembers() {}, memberCount: 3 }
  assert.match(view(React.createElement(mods.teams.TeamsList, { ...base, canManage: true })), /form a team from this project’s 3 people/)
  const readonly = view(React.createElement(mods.teams.TeamsList, { ...base, canManage: false }))
  assert.doesNotMatch(readonly, /form a team/); assert.match(readonly, /No teams have been set up/)
})
