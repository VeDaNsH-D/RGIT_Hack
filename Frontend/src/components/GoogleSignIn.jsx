import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { request } from '../api/client'
import { beginGoogleSignIn } from '../auth/oauth'

export default function GoogleSignIn({ disabled }) {
  const location = useLocation()
  const [available, setAvailable] = useState(null)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    request('/auth/oauth/providers', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setAvailable(Boolean(data.providers?.google)) })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false) })
    return () => controller.abort()
  }, [])
  return <div className="google-signin-block">
    <button className="google-signin-button" type="button" disabled={disabled || available !== true || leaving} onClick={() => { setLeaving(true); beginGoogleSignIn(location.state?.from) }}>
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285f4" d="M22 12.2c0-.7-.1-1.4-.2-2.2H12v4.2h5.6a4.9 4.9 0 0 1-2.1 3.1v2.6h3.4c2-1.8 3.1-4.4 3.1-7.7Z"/><path fill="#34a853" d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-.9.6-2.1 1-3.5 1-2.7 0-4.9-1.8-5.7-4.1H2.8v2.7A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.3 13.8a6 6 0 0 1 0-3.6V7.5H2.8a10 10 0 0 0 0 9l3.5-2.7Z"/><path fill="#ea4335" d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.8 9.8 0 0 0 12 2a10 10 0 0 0-9.2 5.5l3.5 2.7A6 6 0 0 1 12 6.1Z"/></svg>
      {leaving ? 'Opening Google…' : 'Continue with Google'}
    </button>
    {available === false && <p className="google-signin-unavailable">Google sign-in is currently unavailable. You can use your email below.</p>}
    <div className="auth-divider"><span/>or continue with email<span/></div>
  </div>
}
