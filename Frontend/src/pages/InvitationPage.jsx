import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { request } from '../api/client'
import '../workspace/workspace.css'

export default function InvitationPage() {
  const { session, checking, signOut } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const token = location.hash.slice(1)
  const [invitation, setInvitation] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const destination = location.pathname + location.hash
  useEffect(() => {
    if (checking || !session) return
    const controller = new AbortController()
    request('/invitations/preview', { method: 'POST', body: { token }, signal: controller.signal }).then(data => { if (!controller.signal.aborted) { setInvitation(data); setError('') } }).catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
    return () => controller.abort()
  }, [session, checking, token, attempt])
  async function accept() {
    setBusy(true); setError('')
    try {
      const data = await request('/invitations/accept', { method: 'POST', body: { token } })
      if (data.onboardingId) {
        navigate(`/projects/${data.projectId}/onboarding`, { replace: true })
      } else {
        navigate(`/projects/${data.projectId}`, { replace: true })
      }
    } catch (failure) { setError(failure.message); setBusy(false) }
  }
  if (checking) return <div className="ws-loading ws-full-screen" role="status">Checking your session…</div>
  if (!session) return <Navigate to="/signin" replace state={{ from: destination }}/>
  return <main className="ws-app" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}><section className="ws-panel" style={{ width: '100%', maxWidth: 540 }}>
    <Link to="/" className="ws-brand">↗ Over2u</Link><span className="ws-eyebrow" style={{ display: 'block', marginTop: 30 }}>YOU’RE INVITED</span>
    <h1>{invitation ? `Join ${invitation.project.name}` : 'Your project invitation'}</h1>
    {invitation ? <><p>You’ve been invited as a <strong>{invitation.role}</strong>. Accept to join the team and access the project.</p><p className="ws-muted">Signed in as {session.user.email}</p><button className="ws-button ws-button-primary" disabled={busy} onClick={accept}>{busy ? 'Joining…' : invitation.status === 'accepted' ? 'Open project' : 'Accept invitation'}</button></> : !error && <p role="status">Checking your invitation…</p>}
    {error && <div className="ws-error" role="alert"><p>{error}</p><button className="ws-button" disabled={busy} onClick={() => { setError(''); setAttempt(value => value + 1) }}>Retry</button></div>}
    <p style={{ marginTop: 24 }}><button className="ws-text-button" disabled={busy} onClick={() => { signOut(); navigate('/signin', { replace: true, state: { from: destination } }) }}>Use a different account</button></p>
  </section></main>
}
