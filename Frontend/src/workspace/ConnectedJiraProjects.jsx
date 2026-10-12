import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getJiraStatus, getJiraProjects, getProjectJiraIssues, linkJiraProject, listProjectRepositories, syncJiraProject, unlinkJiraProject } from '../api/connections'
import { Icon } from './ui'
import { isJiraKey } from './jiraHelpers'

const dateTime = value => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const SYNC_LABELS = { pending: 'Not synced', syncing: 'Syncing…', completed: 'Synced', partial: 'Partially synced', failed: 'Sync failed' }
const SYNC_BADGES = { completed: 'ws-badge-completed', failed: 'ws-badge-critical', partial: 'ws-badge-pending', syncing: 'ws-badge-pending' }

function JiraRow({ link, canManage, canSync, syncing, confirming, busy, issues = [], onSync, onAskRemove, onCancel, onRemove }) {
  const [showIssues, setShowIssues] = useState(false)
  const status = syncing ? 'syncing' : link.sync?.status || 'pending'
  return <article className="ws-repo-card">
    <div className="ws-project-card-top"><span className="ws-project-symbol"><Icon name="jira"/></span><span className={`ws-badge ${SYNC_BADGES[status] || ''}`}>{SYNC_LABELS[status]}</span></div>
    <h3>{`Jira project ${link.projectKey}`}</h3>
    <div className="ws-repo-meta"><span className="ws-muted">{link.siteName || link.siteUrl || 'Jira'}</span><span className="ws-muted">{link.sync?.lastSuccessAt ? `Last synced ${dateTime(link.sync.lastSuccessAt)}` : 'Not synced yet'}</span></div>
    {link.sync?.syncedIssueCount != null && status !== 'failed' && (
      <div style={{ margin: '8px 0' }}>
        <p className="ws-muted" style={{ margin: 0 }}>
          {`${link.sync.syncedIssueCount} issues available to handoffs.`}
          {issues.length > 0 && (
            <button
              type="button"
              className="ws-text-button"
              style={{ marginLeft: '8px', fontSize: '12px', padding: 0 }}
              onClick={() => setShowIssues(prev => !prev)}
            >
              {showIssues ? 'Hide issues' : `View issues (${issues.length})`}
            </button>
          )}
        </p>
        {showIssues && issues.length > 0 && (
          <ul style={{ margin: '8px 0 0', padding: '0 0 0 16px', fontSize: '12px', color: 'var(--ws-ink)', display: 'grid', gap: '6px' }}>
            {issues.map(issue => (
              <li key={issue.id || issue.externalId}>
                <strong>{issue.externalId}:</strong>{' '}
                {issue.url ? (
                  <a href={issue.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ws-accent, #e06c3a)' }}>
                    {issue.title}
                  </a>
                ) : (
                  <span>{issue.title}</span>
                )}
                {issue.metadata?.status && (
                  <span className="ws-badge" style={{ marginLeft: '6px', fontSize: '10px', padding: '2px 6px' }}>
                    {issue.metadata.status}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    )}
    {['failed', 'partial'].includes(status) && link.sync?.error && <p className="ws-inline-error" role="alert">{link.sync.error}</p>}
    <div className="ws-repo-actions">
      <span className="ws-repo-links">{canManage && !confirming && <button type="button" className="ws-text-button ws-danger" onClick={onAskRemove} disabled={syncing}>Unlink</button>}</span>
      {canSync && <button type="button" className="ws-button" onClick={onSync} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync now'}</button>}
    </div>
    {confirming && <div className="ws-repo-confirm" role="group" aria-label="Confirm unlink"><p className="ws-muted">Unlink this Jira project? Its issues are removed from this project and future handoffs.</p><div><button type="button" className="ws-button" onClick={onCancel} disabled={busy}>Keep</button><button type="button" className="ws-button ws-button-danger" onClick={onRemove} disabled={busy}>{busy ? 'Unlinking…' : 'Unlink'}</button></div></div>}
  </article>
}

// Presentational so every state renders without network access.
export function ConnectedJiraProjectsView({ state, links = [], availableProjects = [], issues = [], error, canManage, canSync, jiraConnected, defaultKey = '', keyInput, onKeyInput, onLink, linking, syncingIds = [], confirmingId, busy, onSync, onAskRemove, onCancel, onRemove }) {
  const invalid = keyInput && !isJiraKey(keyInput)
  return <section className="ws-panel ws-repositories" aria-labelledby="connected-jira">
    <div className="ws-section-heading"><div><h2 id="connected-jira">Connected Jira projects</h2><p>Tracked work, priorities and owners. Linked projects are included in handoffs.</p></div></div>
    {error && <p className="ws-error" role="alert">{error}</p>}
    {state === 'loading' && <div className="ws-repo-grid" role="status" aria-label="Loading Jira projects"><div className="ws-skeleton"/></div>}
    {state === 'ready' && (links.length
      ? <div className="ws-repo-grid">{links.map(link => <JiraRow key={link.id} link={link} canManage={canManage} canSync={canSync} syncing={syncingIds.includes(link.id)} confirming={confirmingId === link.id} busy={busy} issues={issues} onSync={() => onSync(link)} onAskRemove={() => onAskRemove(link.id)} onCancel={onCancel} onRemove={() => onRemove(link)}/>)}</div>
      : <p className="ws-panel-empty">No Jira project linked yet.</p>)}
    {state === 'ready' && canManage && (jiraConnected
      ? <form className="ws-jira-link" onSubmit={event => { event.preventDefault(); if (isJiraKey(keyInput)) onLink() }}>
        {availableProjects.length > 0 && (
          <div style={{ display: 'grid', gap: '4px', marginBottom: '8px' }}>
            <label htmlFor="jira-project-select" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
              Select Jira project:
            </label>
            <select
              id="jira-project-select"
              value={availableProjects.some(p => p.key === keyInput) ? keyInput : ''}
              onChange={event => onKeyInput(event.target.value)}
              style={{
                border: '1px solid var(--ws-border)',
                borderRadius: '7px',
                padding: '6px 10px',
                fontSize: '12px',
                background: '#fff',
                color: 'var(--ws-ink)',
                outline: 'none',
              }}
            >
              <option value="" disabled>-- Choose a project --</option>
              {availableProjects.map(p => (
                <option key={p.id || p.key} value={p.key}>{p.name} ({p.key})</option>
              ))}
            </select>
          </div>
        )}
        <label htmlFor="jira-key">{links.length > 0 ? 'Link another Jira project key' : 'Jira project key'}</label>
        <input id="jira-key" value={keyInput} placeholder={defaultKey || (availableProjects[0]?.key) || 'PROJ'} maxLength={20} autoComplete="off" onChange={event => onKeyInput(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} aria-invalid={Boolean(invalid)}/>
        <button type="submit" className="ws-button ws-button-primary" disabled={linking || !isJiraKey(keyInput)}>{linking ? 'Linking…' : 'Link Jira project'}</button>
        {invalid && <small className="ws-inline-error">Use the key shown before issue numbers, such as PROJ.</small>}
      </form>
      : <p className="ws-notice" role="status">Your Jira account is not connected. <Link to="/connections">Connect Jira</Link> first, then link a project here.</p>)}
  </section>
}

export default function ConnectedJiraProjects({ projectId, canManage, canSync }) {
  const [links, setLinks] = useState(null)
  const [jira, setJira] = useState(null)
  const [availableProjects, setAvailableProjects] = useState([])
  const [issues, setIssues] = useState([])
  const [error, setError] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [linking, setLinking] = useState(false)
  const [syncingIds, setSyncingIds] = useState([])
  const [confirmingId, setConfirmingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      listProjectRepositories(projectId, controller.signal),
      canManage ? getJiraStatus(controller.signal).catch(() => null) : null,
      canManage ? getJiraProjects(controller.signal).catch(() => null) : null,
      getProjectJiraIssues(projectId, controller.signal).catch(() => null),
    ])
      .then(([data, status, projData, issuesData]) => {
        setLinks(data.integrations?.jira || [])
        setJira(status)
        if (issuesData?.sourceRecords) {
          setIssues(issuesData.sourceRecords)
        }
        if (projData?.projects?.length) {
          setAvailableProjects(projData.projects)
          setKeyInput(current => current || status?.projectKey || projData.projects[0].key)
        }
      })
      .catch(failure => {
        if (failure.name !== 'AbortError') {
          setError(failure.message || 'Could not load Jira projects.')
          setLinks(previous => previous || [])
        }
      })
    return () => controller.abort()
  }, [projectId, canManage, tick])

  const reload = () => setTick(count => count + 1)
  async function link() {
    setLinking(true); setError('')
    try {
      const { integration } = await linkJiraProject(projectId, keyInput)
      if (integration.jira.sync?.status === 'failed') setError(integration.jira.sync.error || 'The project was linked, but the first sync failed.')
      setKeyInput('')
      reload()
    } catch (failure) { setError(failure.message) } finally { setLinking(false) }
  }
  async function sync(item) {
    setSyncingIds(ids => [...ids, item.id]); setError('')
    try { await syncJiraProject(projectId, item.id) } catch (failure) { setError(failure.message) } finally { setSyncingIds(ids => ids.filter(id => id !== item.id)); reload() }
  }
  async function remove(item) {
    setBusy(true); setError('')
    try { await unlinkJiraProject(projectId, item.id); setConfirmingId(null) } catch (failure) { setError(failure.message) } finally { setBusy(false); reload() }
  }

  return <ConnectedJiraProjectsView state={links ? 'ready' : 'loading'} links={links || []} availableProjects={availableProjects} issues={issues} error={error} canManage={canManage} canSync={canSync} jiraConnected={Boolean(jira?.connected)} defaultKey={jira?.projectKey} keyInput={keyInput} onKeyInput={setKeyInput} onLink={link} linking={linking} syncingIds={syncingIds} confirmingId={confirmingId} busy={busy} onSync={sync} onAskRemove={setConfirmingId} onCancel={() => setConfirmingId(null)} onRemove={remove}/>
}
