import IntegrationLogo from './IntegrationLogo'
import { useEffect, useState } from 'react'
import { request } from '../api/client'
import { useWorkspace } from './WorkspaceContext'

export default function NotionConnection() {
  const { projects, reload } = useWorkspace()
  const owners = projects.filter(project => project.myRole === 'owner' && !project.loadError)
  const [projectId, setProjectId] = useState(owners[0]?.id || '')
  const [pageId, setPageId] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!projectId) return
    const controller = new AbortController()
    request(`/projects/${projectId}/notion`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setData(value); setError('') } }).catch(failure => { if (!controller.signal.aborted) setError(failure.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [projectId])
  async function update(operation) {
    setBusy(true); setError(''); setNotice('')
    try {
      const message = await operation()
      setData(await request(`/projects/${projectId}/notion`))
      await reload()
      setNotice(message)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const sync = id => update(async () => {
    const result = await request(`/projects/${projectId}/notion`, { method: 'POST', body: { pageId: id }, signal: AbortSignal.timeout(90000) })
    setPageId('')
    return `“${result.title}” synced to your project. Its content is available for project context and handoffs.`
  })
  return <article className="ws-connection-card">
    <div className="ws-project-card-top"><span className="ws-project-symbol"><IntegrationLogo name="notion"/></span><span className="ws-badge ws-badge-pending">{data?.connections.length ? 'Connected' : 'Available'}</span></div>
    <h3>Notion</h3><p>Import shared Notion pages into your project’s knowledge and handoff context.</p>
    {!owners.length ? <p className="ws-muted">A project owner can connect Notion pages.</p> : <>
      <label className="email-project-select">Project<select disabled={busy} value={projectId} onChange={event => { setProjectId(event.target.value); setData(null); setLoading(true); setError(''); setNotice('') }}>{owners.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {loading || !data && !error ? <p role="status">Checking Notion connection…</p> : data?.configured === false ? <p className="ws-notice">Notion isn’t configured on this server yet.</p> : <form className="email-search-row" onSubmit={event => { event.preventDefault(); sync(pageId) }}><label className="ws-search"><input aria-label="Notion page URL or ID" placeholder="Paste a Notion page URL or ID" maxLength={2000} value={pageId} onChange={event => setPageId(event.target.value)} disabled={busy} required/></label><button className="ws-button ws-button-primary" disabled={busy || !data?.configured || !pageId.trim()}>{busy ? 'Saving…' : 'Connect page'}</button></form>}
      <p className="ws-muted">In Notion, open the page’s ••• menu → Connections and add your server’s integration. Public sharing alone does not grant API access. Sync imports the page’s latest content; it does not change tasks automatically.</p>
      {data?.connections.map(connection => <div key={connection.id} className="email-log-record"><strong>{connection.title || 'Notion page'}</strong><p className="ws-muted">Last synced: {connection.syncedAt ? new Date(connection.syncedAt).toLocaleString() : 'Not yet'}</p><div className="email-proposal-actions"><button className="ws-button" disabled={busy} onClick={() => sync(connection.pageId)}>Sync again</button><button className="ws-text-button" disabled={busy} onClick={() => update(async () => { await request(`/projects/${projectId}/notion/${connection.id}`, { method: 'DELETE' }); return 'Disconnected. Imported project knowledge is retained.' })}>Disconnect</button></div></div>)}
      {data?.pages.map(page => <details key={page.id} className="email-log-record"><summary>{page.title}</summary><pre>{page.content || 'This page has no readable text.'}</pre>{page.url && /^https:\/\/([\w-]+\.)?notion\.(so|site)\//.test(page.url) && <a href={page.url} target="_blank" rel="noreferrer">Open in Notion ↗</a>}</details>)}
    </>}
    {error && <div className="ws-error" role="alert"><p>{error}</p><button className="ws-button" disabled={busy} onClick={() => pageId.trim() ? sync(pageId) : update(async () => 'Connection refreshed.')}>Retry</button></div>}
    {notice && <p className="ws-notice" role="status">{notice}</p>}
  </article>
}
