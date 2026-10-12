import { useEffect, useState } from 'react'
import { request } from '../api/client'
export default function ProjectInvitations({ projectId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    request(`/projects/${projectId}/invitations`, { signal: controller.signal }).then(setData).catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
    return () => controller.abort()
  }, [projectId])
  async function revoke(id) {
    setBusy(true); setError('')
    try { await request(`/projects/${projectId}/invitations/${id}`, { method: 'DELETE' }); setData(previous => ({ ...previous, invitations: previous.invitations.filter(invite => invite.id !== id) })) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return <>{data?.configured === false && <p className="ws-notice">Invitation email needs to be configured on the server.</p>}{data?.invitations.length > 0 && <div style={{ marginTop: 24 }}><h3>Pending invitations</h3>{data.invitations.map(invite => <div key={invite.id} className="ws-section-heading"><div><strong>{invite.email}</strong><p className="ws-muted">{invite.role} · Expires {new Date(invite.expiresAt).toLocaleDateString()}</p></div><button className="ws-text-button" disabled={busy} onClick={() => revoke(invite.id)}>Cancel invite</button></div>)}</div>}{error && <p className="ws-error" role="alert">{error}</p>}</>
}
