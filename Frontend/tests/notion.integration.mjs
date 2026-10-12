import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { startMongo, stopMongo } from '../../Backend/tests/mongo-integration/harness.js'
let server, origin, token, outsider, projectId, SourceRecord
let rejectNotion = false
const originalFetch = globalThis.fetch
const call = (path, method = 'GET', body, auth = token) => originalFetch(`${origin}/api${path}`, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
const pageId = '12345678-1234-1234-1234-123456789abc'
before(async () => {
  process.env.NOTION_API_KEY = 'test-notion-token'
  await startMongo()
  const { User } = await import('../../Backend/src/models/User.js')
  const { signAuthToken } = await import('../../Backend/src/middleware/auth.js')
  ;({ SourceRecord } = await import('../../Backend/src/models/SourceRecord.js'))
  token = signAuthToken(await User.create({ name: 'Owner', email: 'notion-owner@example.test' }))
  outsider = signAuthToken(await User.create({ name: 'Other', email: 'notion-other@example.test' }))
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.notion.com/')) {
      if (rejectNotion) return new Response(JSON.stringify({ code: 'object_not_found', message: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      const value = String(url).includes('/blocks/') ? { results: [{ id: 'block', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Launch decisions and project knowledge.' }] }, has_children: false }], has_more: false } : { id: pageId, object: 'page', url: `https://notion.so/${pageId}`, created_time: '2026-01-01T00:00:00Z', last_edited_time: '2026-01-02T00:00:00Z', properties: { title: { type: 'title', title: [{ plain_text: 'Launch notes' }] } } }
      return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
    }
    return originalFetch(url, options)
  }
  const { app } = await import('../../Backend/src/app.js')
  server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)) })
  origin = `http://127.0.0.1:${server.address().port}`
  const result = await call('/projects', 'POST', { name: 'Notion project', description: 'Import knowledge' })
  projectId = (await result.json()).project.id
})
after(async () => { globalThis.fetch = originalFetch; await new Promise(resolve => server?.close(resolve)); await stopMongo() })
test('imports and resyncs page content without duplicates; safe status and disconnect', async () => {
  const path = `/projects/${projectId}/notion`
  let response = await call(path, 'POST', { pageId: `https://notion.so/${pageId}` })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  response = await call(path, 'POST', { pageId })
  assert.equal(response.status, 200)
  assert.equal(await SourceRecord.countDocuments({ projectId, provider: 'notion' }), 1)
  const data = await (await call(path)).json()
  assert.equal(data.connections.length, 1)
  assert.match(data.pages[0].content, /Launch decisions/)
  assert.doesNotMatch(JSON.stringify(data), /test-notion-token/)
  assert.equal((await call(`${path}/${data.connections[0].id}`, 'DELETE')).status, 200)
  assert.equal(await SourceRecord.countDocuments({ projectId, provider: 'notion' }), 1)
})
test('rejects non-members and malformed page identifiers', async () => {
  const path = `/projects/${projectId}/notion`
  assert.equal((await call(path, 'GET', undefined, outsider)).status, 404)
  assert.equal((await call(path, 'POST', { pageId }, outsider)).status, 404)
  assert.equal((await call(path, 'POST', { pageId: 'bad-id' })).status, 400)
})

test('reports page sharing failures without saving a connection', async () => {
  rejectNotion = true
  try {
    const response = await call(`/projects/${projectId}/notion`, 'POST', { pageId })
    assert.equal(response.status, 400)
    assert.match((await response.json()).message, /Connections/)
    const data = await (await call(`/projects/${projectId}/notion`)).json()
    assert.equal(data.connections.length, 0)
  } finally { rejectNotion = false }
})
