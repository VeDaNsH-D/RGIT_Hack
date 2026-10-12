import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { clearOAuthReturn, getOAuthReturn, takeOAuthDestination, verifyOAuthReturn } from '../auth/oauth'

const errors = {
  access_denied: 'Google sign-in was cancelled. You can try again or sign in with email.',
  invalid_state: 'Your sign-in request expired or belongs to another browser. Please start again.',
  unverified_email: 'Google didn’t return a verified email address. Try another account.',
  account_disabled: 'This account is disabled. Please contact your workspace owner.',
  oauth_failed: 'Couldn’t complete Google sign-in. Please try again.',
  validation_error: 'Your sign-in response was incomplete. Please start again.',
}
export default function OAuthCallbackPage() {
  const [payload] = useState(getOAuthReturn)
  const [error, setError] = useState(() => payload?.error ? errors[payload.error] || errors.oauth_failed : !payload?.token ? 'No sign-in session was returned. Please start again.' : '')
  const { acceptSession } = useAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (!payload?.token || payload.error) { clearOAuthReturn(); return }
    const controller = new AbortController()
    verifyOAuthReturn(payload.token, controller.signal).then(session => {
      if (controller.signal.aborted) return
      clearOAuthReturn()
      acceptSession(session)
      navigate(takeOAuthDestination(), { replace: true })
    }).catch(err => {
      if (controller.signal.aborted) return
      clearOAuthReturn()
      setError(err.message)
    })
    return () => controller.abort()
  }, [payload, acceptSession, navigate])
  return error ? <main className="ws-full-screen ws-error-panel"><h2>Let’s try that again.</h2><p role="alert">{error}</p><Link className="ws-button ws-button-primary" to="/signin">Back to sign in</Link></main> : <main className="ws-loading ws-full-screen" role="status"><span className="ws-spinner"/>Finishing your Google sign-in…</main>
}
