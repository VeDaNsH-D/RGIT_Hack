import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { request } from '../api/client'
import { beginGoogleSignIn } from '../auth/oauth'
import { wakeBackend } from '../auth/wakeBackend'

const apiBase = () => (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
const WAKING = 'Waking up the server... This may take a moment.'

export default function GoogleSignIn({ disabled }) {
  const location = useLocation()
  // 'idle' | 'waking' | 'leaving' | 'failed' | 'unconfigured'
  const [phase, setPhase] = useState('idle')
  const [failure, setFailure] = useState('')
  const [slow, setSlow] = useState(false)
  const inFlight = useRef(false)
  const controllerRef = useRef(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; controllerRef.current?.abort() }
  }, [])
  async function start() {
    if (inFlight.current) return
    inFlight.current = true
    const controller = new AbortController()
    controllerRef.current = controller
    let navigating = false
    setPhase('waking'); setFailure(''); setSlow(false)
    try {
      // 1. Wake the backend. A sleeping server is not an unavailable one.
      await wakeBackend(apiBase(), { signal: controller.signal, onAttempt: attempt => { if (attempt > 2 && mounted.current) setSlow(true) } })
      // 2. A healthy server does not prove Google is configured; ask before redirecting.
      const data = await request('/auth/oauth/providers', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      if (!mounted.current) return
      if (!data.providers?.google) { setPhase('unconfigured'); return }
      navigating = true
      setPhase('leaving')
      beginGoogleSignIn(location.state?.from)
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return
      setPhase('failed')
      setFailure(error.kind === 'timeout'
        ? 'The server is taking longer than expected to start. Please try again in a moment.'
        : error.kind === 'server' || error.status
          ? `Google sign-in hit a server error${error.status ? ` (HTTP ${error.status})` : ''}. Please try again, or use your email below.`
          : 'Couldn’t reach the server. Check your connection and try again.')
    } finally {
      // Once the redirect to Google begins the page navigates away, so the guard stays set.
      if (!navigating) inFlight.current = false
    }
  }
  const busy = phase === 'waking' || phase === 'leaving'
  return <div className="google-signin-block">
    <button className="google-signin-button" type="button" disabled={disabled || busy} aria-busy={busy} onClick={start}>
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285f4" d="M22 12.2c0-.7-.1-1.4-.2-2.2H12v4.2h5.6a4.9 4.9 0 0 1-2.1 3.1v2.6h3.4c2-1.8 3.1-4.4 3.1-7.7Z"/><path fill="#34a853" d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-.9.6-2.1 1-3.5 1-2.7 0-4.9-1.8-5.7-4.1H2.8v2.7A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.3 13.8a6 6 0 0 1 0-3.6V7.5H2.8a10 10 0 0 0 0 9l3.5-2.7Z"/><path fill="#ea4335" d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.8 9.8 0 0 0 12 2a10 10 0 0 0-9.2 5.5l3.5 2.7A6 6 0 0 1 12 6.1Z"/></svg>
      {phase === 'leaving' ? 'Opening Google…' : phase === 'waking' ? <><span className="google-signin-spinner" aria-hidden="true"/>Waking up the server…</> : 'Continue with Google'}
    </button>
    <div aria-live="polite">
      {phase === 'waking' && <p className="google-signin-status" role="status">{WAKING}{slow && ' Still starting — hang tight.'}</p>}
      {phase === 'failed' && <p className="google-signin-unavailable" role="alert">{failure} <button type="button" className="google-signin-retry" onClick={start}>Retry</button></p>}
      {phase === 'unconfigured' && <p className="google-signin-unavailable">Google sign-in isn’t set up on this server. You can use your email below.</p>}
    </div>
    <div className="auth-divider"><span/>or continue with email<span/></div>
  </div>
}
