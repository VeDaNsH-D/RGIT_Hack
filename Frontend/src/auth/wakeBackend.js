// Wakes a sleeping (Render free-tier) backend by polling its health endpoint with bounded backoff.
// Resolves when the backend answers 2xx; rejects with an Error whose `kind` is:
//   'timeout' (never became reachable in time), 'server' (reachable but failing), 'aborted'.
export const WAKE_DEFAULTS = {
  totalMs: 90_000, // Render cold starts typically take 30-60s.
  attemptMs: 10_000,
  delaysMs: [1_000, 2_000, 3_000, 5_000], // last value repeats
  maxAttempts: 15,
}
// Statuses a sleeping/starting Render service (or the Vercel proxy in front of it) returns.
const STARTING_STATUSES = new Set([408, 425, 429, 502, 503, 504])

function wakeError(kind, message, status) {
  return Object.assign(new Error(message), { kind, status })
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(wakeError('aborted', 'Aborted'))
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(wakeError('aborted', 'Aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function wakeBackend(base, { signal, onAttempt, fetchImpl = globalThis.fetch, sleepImpl = sleep, now = Date.now, ...overrides } = {}) {
  const opts = { ...WAKE_DEFAULTS, ...overrides }
  const url = `${base.replace(/\/$/, '')}/health`
  const deadline = now() + opts.totalMs
  let lastStatus = null
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (signal?.aborted) throw wakeError('aborted', 'Aborted')
    onAttempt?.(attempt)
    const remaining = deadline - now()
    const attemptSignal = AbortSignal.timeout(Math.max(1, Math.min(opts.attemptMs, remaining)))
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, attemptSignal]) : attemptSignal,
      })
      if (response.ok) return { attempts: attempt }
      lastStatus = response.status
      // A reachable server that is failing for a non-startup reason will not fix itself by waiting.
      if (!STARTING_STATUSES.has(response.status)) {
        throw wakeError('server', `The server responded with an error (HTTP ${response.status}).`, response.status)
      }
    } catch (error) {
      if (error.kind) throw error
      if (signal?.aborted) throw wakeError('aborted', 'Aborted')
      // Network error or per-attempt timeout: expected while the service boots. Keep trying.
    }
    const delay = opts.delaysMs[Math.min(attempt - 1, opts.delaysMs.length - 1)]
    if (attempt === opts.maxAttempts || now() + delay >= deadline) break
    await sleepImpl(delay, signal)
  }
  throw wakeError('timeout', 'The server is taking longer than expected to start.', lastStatus)
}
