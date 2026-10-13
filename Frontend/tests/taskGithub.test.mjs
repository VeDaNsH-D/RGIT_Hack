import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { createServer } from 'vite'

let server, helpers, modal, list
before(async () => {
  globalThis.window = new EventTarget()
  server = await createServer({ envDir: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' })
  helpers = await server.ssrLoadModule('/src/workspace/taskGithub.js')
  modal = await server.ssrLoadModule('/src/workspace/WorkspaceModal.jsx')
  list = await server.ssrLoadModule('/src/workspace/TaskList.jsx')
})
after(async () => { await server?.close() })

const strip = (html) => html.replaceAll('<!-- -->', '')
const repo = (id, name, extra = {}) => ({ id, owner: 'acme', name, fullName: `acme/${name}`, htmlUrl: `https://github.com/acme/${name}`, isPrivate: false, available: true, ...extra })
const field = (props) => strip(renderToString(React.createElement(MemoryRouter, null, React.createElement(modal.RepositoryField, { projectId: 'p1', filter: '', onFilter() {}, onChange() {}, onRetry() {}, canConnect: true, disabled: false, value: '', ...props }))))

test('preselects only a single available repository; several need an explicit choice', () => {
  assert.equal(helpers.defaultRepositoryChoice([repo(1, 'a')]), '1')
  assert.equal(helpers.defaultRepositoryChoice([repo(1, 'a', { available: false })]), '')
  assert.equal(helpers.defaultRepositoryChoice([repo(1, 'a'), repo(2, 'b')]), '')
  assert.equal(helpers.defaultRepositoryChoice([]), '')
})

test('submission is gated on a valid repository choice', () => {
  const two = [repo(1, 'a'), repo(2, 'b', { available: false })]
  const ready = (choice, status = 'ready', repositories = two) => helpers.repositoryFieldReady({ status, repositories, choice })
  assert.equal(ready('', 'loading'), false)
  assert.equal(ready(''), false)
  assert.equal(ready('2'), false) // unavailable repository is never submitted
  assert.equal(ready('999'), false) // stale selection that is no longer in the list
  assert.equal(ready('1'), true)
  assert.equal(ready(helpers.NO_ISSUE), true)
  assert.equal(ready('', 'ready', []), true) // no repositories: local task
  assert.equal(ready('', 'error', []), false)
  assert.equal(ready(helpers.NO_ISSUE, 'error', []), true)
})

test('payload sends the stable repository id, null for opt-out, nothing when there are no repositories', () => {
  const repositories = [repo(11, 'a'), repo(12, 'a')] // same name, different ids
  assert.deepEqual(helpers.githubRepositoryPayload({ status: 'ready', repositories, choice: '12' }), { githubRepositoryId: 12 })
  assert.deepEqual(helpers.githubRepositoryPayload({ status: 'ready', repositories, choice: helpers.NO_ISSUE }), { githubRepositoryId: null })
  assert.deepEqual(helpers.githubRepositoryPayload({ status: 'ready', repositories: [], choice: '' }), {})
  assert.deepEqual(helpers.githubRepositoryPayload({ status: 'error', repositories: [], choice: '' }), {})
})

test('filters repositories by owner/name', () => {
  assert.deepEqual(helpers.filterRepositories([repo(1, 'web'), repo(2, 'api')], ' API ').map(r => r.id), [2])
})

test('repository field renders loading, error, empty, single and multiple states', () => {
  assert.match(field({ view: { status: 'loading', repositories: [] } }), /Loading GitHub repositories/)
  const err = field({ view: { status: 'error', repositories: [], error: 'boom' } })
  assert.match(err, /Couldn’t load/); assert.match(err, />Retry</); assert.match(err, /Continue without a GitHub issue/)
  const empty = field({ view: { status: 'ready', repositories: [] } })
  assert.match(empty, /No GitHub repository is connected/); assert.match(empty, /Connect a repository/)
  assert.doesNotMatch(field({ view: { status: 'ready', repositories: [] }, canConnect: false }), /Connect a repository/)
  const one = field({ view: { status: 'ready', repositories: [repo(1, 'a')] }, value: '1' })
  assert.match(one, /GitHub repository/); assert.match(one, /acme\/a · Public/); assert.match(one, /View acme\/a on GitHub/)
  const many = field({ view: { status: 'ready', repositories: [repo(1, 'a', { isPrivate: true }), repo(2, 'b', { available: false })] } })
  assert.match(many, /Select a repository/); assert.match(many, /Private/); assert.match(many, /unavailable/)
  assert.doesNotMatch(many, /Filter repositories/)
  const lots = field({ view: { status: 'ready', repositories: Array.from({ length: 6 }, (_, i) => repo(i + 1, `r${i}`)) } })
  assert.match(lots, /Filter repositories/)
})

test('task list shows the required GitHub states', () => {
  const show = (github, writable = true) => strip(renderToString(React.createElement(list.GithubStatus, { task: { github }, writable, busy: false, onRetry() {} })))
  const repository = { id: 1, fullName: 'acme/a' }
  const synced = show({ status: 'synced', issueNumber: 42, issueUrl: 'https://github.com/acme/a/issues/42', repository })
  assert.match(synced, /GitHub Issue #42/); assert.match(synced, /View issue/); assert.match(synced, /href="https:\/\/github.com\/acme\/a\/issues\/42"/); assert.match(synced, /acme\/a/)
  assert.match(show({ status: 'pending', repository }), /Creating GitHub issue\.\.\./)
  const failed = show({ status: 'failed', repository, retryable: true, error: { message: 'x' } })
  assert.match(failed, /Task created, but GitHub issue creation failed\./); assert.match(failed, />Retry</)
  assert.doesNotMatch(show({ status: 'failed', repository, retryable: true }, false), /Retry/)
  assert.match(show({ status: 'not_connected' }), /Task created in Over2u\. No GitHub repository is connected\./)
  assert.doesNotMatch(show({ status: 'synced', issueNumber: 1, issueUrl: 'javascript:alert(1)', repository }), /javascript:/) // unsafe links are never rendered
})
