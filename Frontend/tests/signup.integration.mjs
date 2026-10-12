import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { startMongo, stopMongo } from '../../Backend/tests/mongo-integration/harness.js'

let vite, httpServer, authenticate, api, sessions, User, origin
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const originalStorage = globalThis.sessionStorage
const storage = new Map()
const credentials = { username: 'Signup integration test', email: 'signup@example.test', password: 'test-only-password-123' }
let session

before(async () => {
  await startMongo()
  const { app } = await import('../../Backend/src/app.js')
  ;({ User } = await import('../../Backend/src/models/User.js'))
  httpServer = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  origin = `http://127.0.0.1:${httpServer.address().port}`
  globalThis.window = new EventTarget()
  globalThis.sessionStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  globalThis.fetch = (url, options) => originalFetch(url.startsWith('/api') ? `${origin}${url}` : url, options)
  vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' })
  ;({ authenticate } = await vite.ssrLoadModule('/src/api/auth.js'))
  api = await vite.ssrLoadModule('/src/api/client.js')
  sessions = await vite.ssrLoadModule('/src/auth/session.js')
})

after(async () => {
  await vite?.close()
  if (httpServer) await new Promise(resolve => httpServer.close(resolve))
  await stopMongo()
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  globalThis.sessionStorage = originalStorage
})

test('frontend signup creates a real account and returns a session', async () => {
  session = await authenticate('register', credentials)
  assert.equal(session.user.name, credentials.username)
  assert.equal(session.user.email, credentials.email)
  assert.ok(session.token)
  const saved = await User.findById(session.user.id).select('+passwordHash')
  assert.ok(saved)
  assert.notEqual(saved.passwordHash, credentials.password)
})
test('the returned session can load the authenticated workspace', async () => {
  sessions.storeSession(session)
  const { user } = await api.request('/auth/me')
  assert.equal(user.id, session.user.id)
  const { projects } = await api.request('/projects')
  assert.deepEqual(projects, [])
})
test('duplicate signup displays the email-specific validation error', async () => {
  await assert.rejects(authenticate('register', credentials), error => error.field === 'email' && /already exists/.test(error.message))
})
test('the created account can sign in through the same frontend API', async () => {
  const result = await authenticate('login', credentials)
  assert.equal(result.user.id, session.user.id)
  assert.ok(result.token)
})
test('incorrect credentials return a readable error', async () => {
  await assert.rejects(authenticate('login', { ...credentials, password: 'wrong-password-123' }), /email or password is incorrect/)
})
