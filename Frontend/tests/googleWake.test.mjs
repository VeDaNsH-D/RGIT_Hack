import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { createServer } from 'vite'

let vite, wakeBackend, GoogleSignIn
before(async () => {
  vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' })
  ;({ wakeBackend } = await vite.ssrLoadModule('/src/auth/wakeBackend.js'))
  ;({ default: GoogleSignIn } = await vite.ssrLoadModule('/src/components/GoogleSignIn.jsx'))
})
after(() => vite?.close())

const res = status => ({ ok: status >= 200 && status < 300, status })
// Scripted fetch: each entry is a status number or an Error to throw.
function script(steps) {
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]
    if (step instanceof Error) throw step
    return res(step)
  }
  return { fetchImpl, calls }
}
const delays = []
const opts = fetchImpl => ({ fetchImpl, sleepImpl: async ms => { delays.push(ms) } })

test('awake backend: one health request, no waiting', async () => {
  delays.length = 0
  const { fetchImpl, calls } = script([200])
  const result = await wakeBackend('https://x.test/api', opts(fetchImpl))
  assert.equal(result.attempts, 1)
  assert.deepEqual(calls, ['https://x.test/api/health'])
  assert.equal(delays.length, 0)
})
test('sleeping backend wakes on first request after a 503 gateway response', async () => {
  const { fetchImpl, calls } = script([503, 200])
  assert.equal((await wakeBackend('/api/', opts(fetchImpl))).attempts, 2)
  assert.equal(calls[0], '/api/health')
})
test('backend needs several attempts, with growing backoff', async () => {
  delays.length = 0
  const { fetchImpl } = script([new TypeError('fetch failed'), 502, 504, new TypeError('fetch failed'), 200])
  assert.equal((await wakeBackend('/api', opts(fetchImpl))).attempts, 5)
  assert.deepEqual(delays, [1000, 2000, 3000, 5000])
})
test('backend never comes up: bounded attempts, kind=timeout', async () => {
  delays.length = 0
  const { fetchImpl, calls } = script([503])
  await assert.rejects(wakeBackend('/api', opts(fetchImpl)), e => e.kind === 'timeout')
  assert.equal(calls.length, 15)
  assert.ok(delays.every(d => d <= 5000))
})
test('total deadline stops retries early', async () => {
  let t = 0
  const { fetchImpl, calls } = script([503])
  await assert.rejects(wakeBackend('/api', { fetchImpl, now: () => t, sleepImpl: async ms => { t += ms }, totalMs: 6000 }), e => e.kind === 'timeout')
  assert.ok(calls.length < 15)
})
test('genuine server error (500) fails fast without retrying', async () => {
  const { fetchImpl, calls } = script([500])
  await assert.rejects(wakeBackend('/api', opts(fetchImpl)), e => e.kind === 'server' && e.status === 500)
  assert.equal(calls.length, 1)
})
test('404 (wrong base URL) fails fast', async () => {
  const { fetchImpl, calls } = script([404])
  await assert.rejects(wakeBackend('/api', opts(fetchImpl)), e => e.kind === 'server' && e.status === 404)
  assert.equal(calls.length, 1)
})
test('abort (component unmount) stops polling', async () => {
  const controller = new AbortController()
  const { fetchImpl, calls } = script([503])
  const p = wakeBackend('/api', { fetchImpl, signal: controller.signal, sleepImpl: async () => { controller.abort() } })
  await assert.rejects(p, e => e.kind === 'aborted')
  assert.equal(calls.length, 1)
})
test('hung request is cut off by the per-attempt timeout', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  const started = Date.now()
  await assert.rejects(wakeBackend('/api', { fetchImpl, sleepImpl: async () => {}, attemptMs: 20, maxAttempts: 2 }), e => e.kind === 'timeout')
  assert.ok(Date.now() - started < 2000)
})
test('Google button renders enabled before any request and keeps email divider', () => {
  const html = renderToString(React.createElement(MemoryRouter, null, React.createElement(GoogleSignIn, {})))
  assert.match(html, /Continue with Google/)
  assert.doesNotMatch(html, /disabled/)
  assert.doesNotMatch(html, /currently unavailable/)
  assert.match(html, /or continue with email/)
})
