import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { startMongo, stopMongo } from '../../Backend/tests/mongo-integration/harness.js'

let httpServer, origin, config, oauthProviders, User, verifyOAuthReturn, oauth, vite
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const originalStorage = globalThis.sessionStorage
const profile = { sub: 'google-test-subject', email: 'google@example.test', email_verified: true, name: 'Google Test User' }
let exchangeFails = false
let exchangeCalls = 0
const storage = new Map()
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

before(async () => {
  await startMongo()
  ;({ config } = await import('../../Backend/src/config.js'))
  config.frontendUrl = 'http://localhost:5173'
  config.oauth.google = { enabled: true, clientId: 'test-google-client', clientSecret: 'test-google-secret' }
  config.oauth.github = { enabled: false, clientId: '', clientSecret: '' }
  ;({ oauthProviders } = await import('../../Backend/src/auth/oauthProviders.js'))
  ;({ User } = await import('../../Backend/src/models/User.js'))
  const { app } = await import('../../Backend/src/app.js')
  httpServer = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
  origin = `http://127.0.0.1:${httpServer.address().port}`
  config.apiBaseUrl = origin
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      exchangeCalls++
      assert.equal(options.body.get('redirect_uri'), `${origin}/api/auth/oauth/google/callback`)
      return exchangeFails ? response({ error: 'invalid_grant' }, 400) : response({ access_token: 'test-provider-access-token' })
    }
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return response(profile)
    return originalFetch(String(url).startsWith('/api') ? `${origin}${url}` : url, options)
  }
  globalThis.window = new EventTarget()
  window.location = { href: 'http://localhost:5173/auth/callback' }
  window.history = { replaceState(_state, _title, path) { window.location.href = `http://localhost:5173${path}` } }
  globalThis.sessionStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' })
  oauth = await vite.ssrLoadModule('/src/auth/oauth.js')
  verifyOAuthReturn = oauth.verifyOAuthReturn
})
after(async () => {
  await vite?.close()
  if (httpServer) await new Promise(resolve => httpServer.close(resolve))
  await stopMongo()
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  globalThis.sessionStorage = originalStorage
})
async function begin() {
  const result = await originalFetch(`${origin}/api/auth/oauth/google`, { redirect: 'manual' })
  assert.equal(result.status, 302)
  const target = new URL(result.headers.get('location'))
  const cookie = result.headers.get('set-cookie').split(';')[0]
  assert.equal(target.hostname, 'accounts.google.com')
  assert.equal(target.searchParams.get('redirect_uri'), `${origin}/api/auth/oauth/google/callback`)
  assert.match(result.headers.get('set-cookie'), /HttpOnly/)
  return { state: target.searchParams.get('state'), cookie }
}
async function callback({ state, cookie, error }) {
  const query = new URLSearchParams({ state, ...(error ? { error } : { code: 'test-code' }) })
  return originalFetch(`${origin}/api/auth/oauth/google/callback?${query}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
}
function redirectError(result) { return new URL(result.headers.get('location')).searchParams.get('error') }

test('provider availability exposes Google only without leaking credentials', async () => {
  const result = await originalFetch(`${origin}/api/auth/oauth/providers`)
  assert.deepEqual(await result.json(), { providers: { google: true, github: false } })
})
test('Google callback creates an account and the frontend verifies the returned session', async () => {
  const start = await begin()
  const result = await callback(start)
  assert.equal(result.status, 302)
  const location = new URL(result.headers.get('location'))
  assert.equal(location.pathname, '/auth/callback')
  assert.equal(location.searchParams.has('token'), false)
  const token = new URLSearchParams(location.hash.slice(1)).get('token')
  assert.ok(token)
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer')
  const session = await verifyOAuthReturn(token)
  assert.equal(session.user.email, profile.email)
  assert.equal(session.user.name, profile.name)
  const saved = await User.findById(session.user.id)
  assert.equal(saved.googleId, profile.sub)
})
test('repeat sign-in uses the existing Google account', async () => {
  await callback(await begin())
  assert.equal(await User.countDocuments({ googleId: profile.sub }), 1)
})
test('callback strips its token before rendering and keeps a safe destination', () => {
  window.location.href = 'http://localhost:5173/auth/callback#token=test-token'
  oauth.captureOAuthReturn()
  assert.equal(window.location.href, 'http://localhost:5173/auth/callback')
  assert.equal(oauth.getOAuthReturn().token, 'test-token')
  assert.equal(oauth.safeDestination('https://attacker.example'), '/dashboard')
  assert.equal(oauth.safeDestination('//attacker.example'), '/dashboard')
  assert.equal(oauth.safeDestination('/projects/project-one'), '/projects/project-one')
  oauth.clearOAuthReturn()
})
test('callbacks from another browser are rejected before code exchange', async () => {
  const start = await begin()
  const count = exchangeCalls
  assert.equal(redirectError(await callback({ ...start, cookie: '' })), 'invalid_state')
  assert.equal(exchangeCalls, count)
})
test('invalid and expired state cannot authenticate', async () => {
  const start = await begin()
  assert.equal(redirectError(await callback({ ...start, state: 'invalid-state' })), 'invalid_state')
  const jwt = (await import('../../Backend/node_modules/jsonwebtoken/index.js')).default
  const nonce = start.cookie.split('=')[1]
  const expired = jwt.sign({ provider: 'google', nonce }, config.jwtSecret, { expiresIn: -1 })
  assert.equal(redirectError(await callback({ ...start, state: expired })), 'invalid_state')
})
test('cancelled Google consent returns a readable callback error', async () => {
  assert.equal(redirectError(await callback({ ...await begin(), error: 'access_denied' })), 'access_denied')
})
test('unverified Google email does not create an account', async () => {
  profile.sub = 'unverified-google-user'
  profile.email = 'unverified@example.test'
  profile.email_verified = false
  assert.equal(redirectError(await callback(await begin())), 'unverified_email')
  assert.equal(await User.countDocuments({ email: profile.email }), 0)
  profile.email_verified = true
})
test('provider failures return to the frontend without authenticating', async () => {
  exchangeFails = true
  assert.equal(redirectError(await callback(await begin())), 'oauth_failed')
  exchangeFails = false
})
test('Google tokens with a string false email verification value are not trusted', async () => {
  profile.email_verified = 'false'
  assert.equal((await oauthProviders.google.exchangeCode('test-code')).emailVerified, false)
  profile.email_verified = true
})
test('a verified email links an existing email account without duplication', async () => {
  const existing = await User.create({ email: 'linked@example.test', name: 'Email Account' })
  profile.email = existing.email
  profile.sub = 'linked-google-subject'
  const result = await callback(await begin())
  const token = new URLSearchParams(new URL(result.headers.get('location')).hash.slice(1)).get('token')
  const session = await verifyOAuthReturn(token)
  assert.equal(session.user.id, String(existing._id))
  assert.equal(await User.countDocuments({ email: existing.email }), 1)
})
test('disabled accounts cannot sign in through Google', async () => {
  await User.updateOne({ googleId: profile.sub }, { $set: { disabled: true } })
  assert.equal(redirectError(await callback(await begin())), 'account_disabled')
})
