import { useEffect, useRef, useState } from 'react'
import { listProjectRepositories, syncGitHubRepository, unlinkGitHubRepository } from '../api/connections'
import { formatDate } from './utils'
import { Icon } from './ui'

// Sync data (status, last sync, issue/PR/commit counts) only renders when the backend provides it.
const dateTime = value => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const SYNC_LABELS = { pending: 'Not synced', syncing: 'Syncing…', completed: 'Synced', partial: 'Partially synced', failed: 'Sync failed' }
const SYNC_BADGES = { completed: 'ws-badge-completed', failed: 'ws-badge-critical', partial: 'ws-badge-pending', syncing: 'ws-badge-pending' }

function RepositoryStats({ stats, sync }) {
  if (!stats || ['not_synced', 'failed'].includes(stats.state)) return <p className="ws-muted">Issue and pull request counts appear after the first successful sync.</p>
  const more = stats.truncated ? 'At least ' : ''
  return <div className="ws-repo-stats">
    <span><strong>{`${more}${stats.openIssues}`}</strong> open issues</span>
    <span><strong>{`${more}${stats.openPullRequests}`}</strong> open pull requests</span>
    {stats.latestCommitAt && <span>{`Latest commit ${formatDate(stats.latestCommitAt)}`}</span>}
    {stats.state === 'stale' && <small className="ws-muted">{`From the last successful sync${sync?.lastSuccessAt ? ` (${dateTime(sync.lastSuccessAt)})` : ''}`}</small>}
  </div>
}

// Sync data (status, last sync, counts) is rendered only from what the backend reports.
function RepositoryCard({ connection, canManage, canSync, busy, syncing, confirming, onAskRemove, onCancelRemove, onRemove, onSync }) {
  const { repository: repo, sync, stats } = connection
  const status = syncing ? 'syncing' : sync?.status || 'pending'
  return <article className="ws-repo-card">
    <div className="ws-project-card-top"><span className="ws-project-symbol"><Icon name="github"/></span><span className={`ws-badge ${SYNC_BADGES[status] || ''}`}>{SYNC_LABELS[status]}</span></div>
    <h3>{`${repo.owner}/${repo.name}`}</h3>
    <div className="ws-repo-meta"><span className={`ws-badge ${repo.isPrivate ? 'ws-badge-pending' : ''}`}>{repo.isPrivate ? 'Private' : 'Public'}</span><span className="ws-muted">{sync?.lastSuccessAt ? `Last synced ${dateTime(sync.lastSuccessAt)}` : 'Not synced yet'}</span></div>
    <RepositoryStats stats={stats} sync={sync}/>
    {['failed', 'partial'].includes(status) && sync?.errors?.length > 0 && <p className="ws-inline-error" role="alert">{sync.errors[0].message}</p>}
    <div className="ws-repo-actions">
      <span className="ws-repo-links">
        {repo.htmlUrl?.startsWith('https://github.com/') && <a className="ws-text-button" href={repo.htmlUrl} target="_blank" rel="noopener noreferrer">{'View on GitHub ↗'}</a>}
        {canManage && !confirming && <button type="button" className="ws-text-button ws-danger" onClick={onAskRemove} disabled={syncing}>Disconnect</button>}
      </span>
      {canSync && <button type="button" className="ws-button" onClick={onSync} disabled={syncing || status === 'syncing'}>{status === 'syncing' ? 'Syncing…' : 'Sync now'}</button>}
    </div>
    {confirming && <div className="ws-repo-confirm" role="group" aria-label="Confirm disconnect"><p className="ws-muted">Disconnect this repository? The project and any records already collected are kept.</p><div><button type="button" className="ws-button" onClick={onCancelRemove} disabled={busy}>Keep</button><button type="button" className="ws-button ws-button-danger" onClick={onRemove} disabled={busy}>{busy ? 'Disconnecting…' : 'Disconnect'}</button></div></div>}
  </article>
}

// Presentational so every state renders without network access.
export function ConnectedRepositoriesView({ state, connections = [], error, canManage, canSync = false, syncingIds = [], onSync, onAdd, onRetry, removing, busy, onAskRemove, onCancelRemove, onRemove }) {
  return <section className="ws-panel ws-repositories" aria-labelledby="connected-repositories">
    <div className="ws-section-heading"><div><h2 id="connected-repositories">Connected repositories</h2><p>Code and discussion that give this project its context.</p></div>{canManage && <button type="button" className="ws-text-button" onClick={onAdd}>+ Add repository</button>}</div>
    {state === 'loading' && <div className="ws-repo-grid" role="status" aria-label="Loading repositories"><div className="ws-skeleton"/><div className="ws-skeleton"/></div>}
    {state === 'error' && <div className="ws-integration-body"><p className="ws-error" role="alert">{error}</p><button type="button" className="ws-button" onClick={onRetry}>Try again</button></div>}
    {state === 'ready' && (connections.length
      ? <div className="ws-repo-grid">{connections.map(connection => <RepositoryCard key={connection.id} connection={connection} canManage={canManage} canSync={canSync} syncing={syncingIds.includes(connection.id)} onSync={() => onSync?.(connection)} busy={busy} confirming={removing === connection.id} onAskRemove={() => onAskRemove(connection.id)} onCancelRemove={onCancelRemove} onRemove={() => onRemove(connection)}/>)}</div>
      : <p className="ws-panel-empty">{canManage ? 'No repositories connected yet. Add one to bring its issues, pull requests, and commits into this project.' : 'No repositories are connected to this project yet.'}{canManage && <><br/><button type="button" className="ws-button ws-button-primary" onClick={onAdd}>Add repository</button></>}</p>)}
  </section>
}

export default function ConnectedRepositories({ projectId, canManage, canSync, refreshKey, onAdd, onLoaded, onConnections, onSynced }) {
  const [result, setResult] = useState(null)
  const [tick, setTick] = useState(0)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)
  const [syncingIds, setSyncingIds] = useState([])
  const [actionError, setActionError] = useState('')
  const attempted = useRef(new Set())
  const connections = result?.projectId === projectId ? result.connections : null
  const state = result?.projectId !== projectId ? 'loading' : result.error && !connections ? 'error' : 'ready'

  useEffect(() => {
    const controller = new AbortController()
    listProjectRepositories(projectId, controller.signal)
      .then(data => {
        const next = data.integrations?.github || []
        setResult({ projectId, connections: next })
        onLoaded?.(next.map(connection => connection.repository.id))
        onConnections?.(next)
      })
      // Keep showing the last known repositories if a background refresh fails.
      .catch(error => { if (error.name !== 'AbortError') setResult(previous => ({ projectId, connections: previous?.projectId === projectId ? previous.connections : null, error: error.message })) })
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks are stable state setters
  }, [projectId, refreshKey, tick])

  async function sync(connection) {
    if (syncingIds.includes(connection.id)) return
    setSyncingIds(ids => [...ids, connection.id])
    setActionError('')
    try {
      await syncGitHubRepository(projectId, connection.id)
    } catch (error) {
      // "Already running" is not a failure: the poll below follows the other run to completion.
      if (error.data?.error !== 'sync_in_progress') setActionError(error.message)
    } finally {
      setSyncingIds(ids => ids.filter(id => id !== connection.id))
      setTick(count => count + 1)
      onSynced?.()
    }
  }

  // First sync for a new association, and catch-up after a webhook marked it stale.
  useEffect(() => {
    if (!canSync || !connections) return
    const next = connections.find(connection => ['pending'].includes(connection.sync?.status) || (connection.sync?.stale && connection.sync?.status !== 'syncing'))
    if (next && !attempted.current.has(next.id)) { attempted.current.add(next.id); sync(next) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sync only needs to run per discovered connection
  }, [connections, canSync])

  // A sync started elsewhere (another tab, a webhook) is followed until it finishes.
  const remoteSyncing = connections?.some(connection => connection.sync?.status === 'syncing') && syncingIds.length === 0
  useEffect(() => {
    if (!remoteSyncing) return undefined
    const timer = setTimeout(() => setTick(count => count + 1), 4000)
    return () => clearTimeout(timer)
  }, [remoteSyncing, tick])

  async function remove(connection) {
    setBusy(true)
    setActionError('')
    try {
      await unlinkGitHubRepository(projectId, connection.id)
      setRemoving(null)
      setTick(count => count + 1) // Re-read from the backend rather than trusting local state.
      onSynced?.()
    } catch (error) { setActionError(error.message) } finally { setBusy(false) }
  }

  return <>
    <ConnectedRepositoriesView state={state} connections={connections || []} error={result?.error} canManage={canManage} canSync={canSync} syncingIds={syncingIds} onSync={sync} onAdd={onAdd} onRetry={() => { setResult(null); setTick(count => count + 1) }} removing={removing} busy={busy} onAskRemove={setRemoving} onCancelRemove={() => setRemoving(null)} onRemove={remove}/>
    {actionError && <p className="ws-error" role="alert">{actionError}</p>}
  </>
}
