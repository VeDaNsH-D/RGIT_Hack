import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getNotionStatus,
  getNotionPages,
  getProjectNotion,
  linkProjectNotion,
  syncProjectNotion,
  unlinkProjectNotion,
} from '../api/connections'
import { Icon } from './ui'

const dateTime = value =>
  value
    ? new Date(value).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Not synced yet'

const SYNC_LABELS = {
  pending: 'Not synced',
  syncing: 'Syncing…',
  completed: 'Synced',
  partial: 'Partially synced',
  failed: 'Sync failed',
}

const SYNC_BADGES = {
  completed: 'ws-badge-completed',
  failed: 'ws-badge-critical',
  partial: 'ws-badge-pending',
  syncing: 'ws-badge-pending',
}

function NotionRow({
  link,
  canManage,
  canSync,
  syncing,
  confirming,
  busy,
  pageContent,
  onSync,
  onAskRemove,
  onCancel,
  onRemove,
}) {
  const [showRemaining, setShowRemaining] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [showContent, setShowContent] = useState(false)
  const status = syncing ? 'syncing' : link.sync?.status || 'pending'

  const remainingItems = link.sync?.remainingItems || []
  const completedItems = link.sync?.completedItems || []
  const remainingCount = link.sync?.remainingCount ?? remainingItems.length
  const completedCount = link.sync?.completedCount ?? completedItems.length
  const hasTasks = remainingCount > 0 || completedCount > 0

  return (
    <article className="ws-repo-card">
      <div className="ws-project-card-top">
        <span className="ws-project-symbol">
          <Icon name="notion" />
        </span>
        <span className={`ws-badge ${SYNC_BADGES[status] || ''}`}>
          {SYNC_LABELS[status]}
        </span>
      </div>

      <h3>{link.title || 'Notion resource'}</h3>

      <div className="ws-repo-meta">
        <span className="ws-muted">
          {(link.syncedAt || link.sync?.lastSuccessAt)
            ? `Last synced ${dateTime(link.syncedAt || link.sync?.lastSuccessAt)}`
            : 'Not synced yet'}
        </span>
        {link.url && (
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="ws-muted"
            style={{ color: 'var(--ws-accent, #e06c3a)', textDecoration: 'none' }}
          >
            Open in Notion ↗
          </a>
        )}
      </div>

      {status !== 'failed' && (
        <div style={{ margin: '10px 0' }}>
          {hasTasks ? (
            <div style={{ display: 'grid', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                {remainingCount > 0 ? (
                  <span
                    className="ws-badge ws-badge-pending"
                    style={{ fontSize: '11px', fontWeight: '600', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  >
                    <Icon name="clock" size={12} />
                    {remainingCount} remaining
                  </span>
                ) : (
                  <span
                    className="ws-badge ws-badge-completed"
                    style={{ fontSize: '11px', fontWeight: '600', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  >
                    <Icon name="check" size={12} />
                    All tasks completed
                  </span>
                )}

                {completedCount > 0 && (
                  <span className="ws-muted" style={{ fontSize: '12px' }}>
                    {completedCount} completed
                  </span>
                )}

                {remainingCount > 0 && (
                  <button
                    type="button"
                    className="ws-text-button"
                    style={{ fontSize: '12px', padding: 0 }}
                    onClick={() => setShowRemaining(prev => !prev)}
                  >
                    {showRemaining ? 'Hide remaining' : `View remaining (${remainingCount})`}
                  </button>
                )}
              </div>

              {showRemaining && remainingItems.length > 0 && (
                <div
                  style={{
                    background: '#faf9f7',
                    border: '1px solid var(--ws-border, #e7ddd4)',
                    borderRadius: '8px',
                    padding: '12px 14px',
                    marginTop: '4px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <strong style={{ fontSize: '11px', textTransform: 'uppercase', color: '#8c4217', letterSpacing: '0.5px' }}>
                      Pending action items
                    </strong>
                    <span className="ws-badge ws-badge-pending" style={{ fontSize: '10px', padding: '1px 6px' }}>
                      {remainingItems.length} open
                    </span>
                  </div>
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '6px' }}>
                    {remainingItems.map((item, idx) => (
                      <li key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', lineHeight: '1.4', color: 'var(--ws-ink)' }}>
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#d9531e', marginTop: '6px', flexShrink: 0 }} />
                        <strong>{item}</strong>
                      </li>
                    ))}
                  </ul>

                  {completedCount > 0 && (
                    <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid #e7ddd4' }}>
                      <button
                        type="button"
                        className="ws-text-button"
                        style={{ fontSize: '11px', color: 'var(--ws-muted)' }}
                        onClick={() => setShowCompleted(prev => !prev)}
                      >
                        {showCompleted ? 'Hide completed' : `Show ${completedCount} completed tasks`}
                      </button>
                      {showCompleted && (
                        <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '4px' }}>
                          {completedItems.map((item, idx) => (
                            <li key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '11.5px', color: '#7a6a5b' }}>
                              <span style={{ color: '#2e7d32', marginTop: '1px', flexShrink: 0, display: 'inline-flex' }}>
                                <Icon name="check" size={11} />
                              </span>
                              <span style={{ textDecoration: 'line-through' }}>{item}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div>
              <p className="ws-muted" style={{ margin: '0 0 4px', fontSize: '12px' }}>
                Page content synced (no open checklist items).
              </p>
              {pageContent && (
                <button
                  type="button"
                  className="ws-text-button"
                  style={{ fontSize: '12px', padding: 0 }}
                  onClick={() => setShowContent(prev => !prev)}
                >
                  {showContent ? 'Hide content' : 'View page content'}
                </button>
              )}
              {showContent && pageContent && (
                <pre
                  style={{
                    background: '#fcfaf8',
                    border: '1px solid var(--ws-border)',
                    borderRadius: '6px',
                    padding: '8px 10px',
                    fontSize: '11.5px',
                    maxHeight: '180px',
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    marginTop: '6px',
                  }}
                >
                  {pageContent}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {status === 'failed' && link.sync?.error && (
        <p className="ws-inline-error" role="alert">
          {link.sync.error}
        </p>
      )}

      <div className="ws-repo-actions">
        <span className="ws-repo-links">
          {canManage && !confirming && (
            <button
              type="button"
              className="ws-text-button ws-danger"
              onClick={onAskRemove}
              disabled={syncing}
            >
              Unlink
            </button>
          )}
        </span>
        {canSync && (
          <button
            type="button"
            className="ws-button"
            onClick={onSync}
            disabled={syncing}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>

      {confirming && (
        <div className="ws-repo-confirm" role="group" aria-label="Confirm unlink">
          <p className="ws-muted">
            Unlink this Notion resource? Its content and task history will be removed from future handoffs.
          </p>
          <div>
            <button type="button" className="ws-button" onClick={onCancel} disabled={busy}>
              Keep
            </button>
            <button
              type="button"
              className="ws-button ws-button-danger"
              onClick={onRemove}
              disabled={busy}
            >
              {busy ? 'Unlinking…' : 'Unlink'}
            </button>
          </div>
        </div>
      )}
    </article>
  )
}

export function ConnectedNotionPagesView({
  state,
  links = [],
  availableResources = [],
  pages = [],
  error,
  canManage,
  canSync,
  notionConnected,
  inputVal,
  onInputChange,
  onLink,
  linking,
  syncingIds = [],
  confirmingId,
  busy,
  onSync,
  onAskRemove,
  onCancel,
  onRemove,
}) {
  const databases = availableResources.filter(r => r.object === 'database')
  const pageResources = availableResources.filter(r => r.object === 'page')

  return (
    <section className="ws-panel ws-repositories" aria-labelledby="connected-notion">
      <div className="ws-section-heading">
        <div>
          <h2 id="connected-notion">Connected Notion pages</h2>
          <p>
            Documentation, task databases and shared knowledge. Linked pages show remaining tasks and feed into handoffs.
          </p>
        </div>
      </div>

      {error && <p className="ws-error" role="alert">{error}</p>}

      {state === 'loading' && (
        <div className="ws-repo-grid" role="status" aria-label="Loading Notion pages">
          <div className="ws-skeleton" />
        </div>
      )}

      {state === 'ready' && (
        links.length ? (
          <div className="ws-repo-grid">
            {links.map(link => {
              const matchingPage = pages.find(p => p.url === link.url || p.title === link.title)
              return (
                <NotionRow
                  key={link.id}
                  link={link}
                  canManage={canManage}
                  canSync={canSync}
                  syncing={syncingIds.includes(link.id)}
                  confirming={confirmingId === link.id}
                  busy={busy}
                  pageContent={matchingPage?.content}
                  onSync={() => onSync(link)}
                  onAskRemove={() => onAskRemove(link.id)}
                  onCancel={onCancel}
                  onRemove={() => onRemove(link)}
                />
              )
            })}
          </div>
        ) : (
          <p className="ws-panel-empty">No Notion pages or databases linked yet.</p>
        )
      )}

      {state === 'ready' && canManage && (
        notionConnected ? (
          <form
            className="ws-jira-link"
            onSubmit={event => {
              event.preventDefault()
              if (inputVal.trim()) onLink()
            }}
          >
            {availableResources.length > 0 && (
              <div style={{ display: 'grid', gap: '4px', marginBottom: '8px', width: '100%' }}>
                <label htmlFor="notion-resource-select" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                  Select accessible Notion page or database:
                </label>
                <select
                  id="notion-resource-select"
                  value={availableResources.some(r => r.id === inputVal || r.url === inputVal) ? inputVal : ''}
                  onChange={event => onInputChange(event.target.value)}
                  style={{
                    border: '1px solid var(--ws-border)',
                    borderRadius: '7px',
                    padding: '7px 10px',
                    fontSize: '12px',
                    background: '#fff',
                    color: 'var(--ws-ink)',
                    outline: 'none',
                    maxWidth: '360px',
                  }}
                >
                  <option value="" disabled>-- Choose from your Notion workspace --</option>
                  {databases.length > 0 && (
                    <optgroup label="Databases">
                      {databases.map(db => (
                        <option key={db.id} value={db.id}>
                          {db.title} [Database]
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {pageResources.length > 0 && (
                    <optgroup label="Pages">
                      {pageResources.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.title} [Page]
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
            )}

            <label htmlFor="notion-input" style={{ fontSize: '12px', color: '#7a6a5b' }}>
              {links.length > 0 ? 'Link another Notion page or database' : 'Notion page URL or ID'}
            </label>
            <input
              id="notion-input"
              value={inputVal}
              placeholder="Paste Notion page URL or UUID"
              maxLength={2000}
              autoComplete="off"
              onChange={event => onInputChange(event.target.value)}
              style={{
                height: '39px',
                minWidth: '220px',
                border: '1px solid #e7ddd4',
                borderRadius: '7px',
                padding: '0 12px',
                fontSize: '13px',
                background: '#fff',
              }}
            />
            <button
              type="submit"
              className="ws-button ws-button-primary"
              disabled={linking || !inputVal.trim()}
            >
              {linking ? 'Linking…' : 'Link Notion page'}
            </button>
          </form>
        ) : (
          <p className="ws-notice" role="status">
            Your Notion account is not connected. <Link to="/connections">Connect Notion</Link> first, then link pages here.
          </p>
        )
      )}
    </section>
  )
}

export default function ConnectedNotionPages({ projectId, canManage, canSync }) {
  const [links, setLinks] = useState(null)
  const [pages, setPages] = useState([])
  const [notionStatus, setNotionStatus] = useState(null)
  const [availableResources, setAvailableResources] = useState([])
  const [error, setError] = useState('')
  const [inputVal, setInputVal] = useState('')
  const [linking, setLinking] = useState(false)
  const [syncingIds, setSyncingIds] = useState([])
  const [confirmingId, setConfirmingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      getProjectNotion(projectId, controller.signal).catch(() => ({ connections: [], pages: [] })),
      canManage ? getNotionStatus(controller.signal).catch(() => null) : null,
      canManage ? getNotionPages(controller.signal).catch(() => null) : null,
    ])
      .then(([projData, status, resourcesData]) => {
        setLinks(projData.connections || [])
        setPages(projData.pages || [])
        setNotionStatus(status)
        if (resourcesData?.resources?.length) {
          setAvailableResources(resourcesData.resources)
          setInputVal(current => current || resourcesData.resources[0].id)
        }
      })
      .catch(failure => {
        if (failure.name !== 'AbortError') {
          setError(failure.message || 'Could not load Notion pages.')
          setLinks(previous => previous || [])
        }
      })
    return () => controller.abort()
  }, [projectId, canManage, tick])

  const reload = () => setTick(count => count + 1)

  async function handleLink() {
    if (!inputVal.trim()) return
    setLinking(true)
    setError('')
    try {
      await linkProjectNotion(projectId, inputVal.trim())
      setInputVal('')
      reload()
    } catch (failure) {
      setError(failure.message || 'Failed to link Notion page.')
    } finally {
      setLinking(false)
    }
  }

  async function handleSync(link) {
    setSyncingIds(ids => [...ids, link.id])
    setError('')
    try {
      await syncProjectNotion(projectId, link.id)
    } catch (failure) {
      setError(failure.message || 'Failed to sync Notion page.')
    } finally {
      setSyncingIds(ids => ids.filter(id => id !== link.id))
      reload()
    }
  }

  async function handleRemove(link) {
    setBusy(true)
    setError('')
    try {
      await unlinkProjectNotion(projectId, link.id)
      setConfirmingId(null)
    } catch (failure) {
      setError(failure.message || 'Failed to unlink Notion page.')
    } finally {
      setBusy(false)
      reload()
    }
  }

  return (
    <ConnectedNotionPagesView
      state={links ? 'ready' : 'loading'}
      links={links || []}
      availableResources={availableResources}
      pages={pages}
      error={error}
      canManage={canManage}
      canSync={canSync}
      notionConnected={Boolean(notionStatus?.connected || availableResources.length > 0)}
      inputVal={inputVal}
      onInputChange={setInputVal}
      onLink={handleLink}
      linking={linking}
      syncingIds={syncingIds}
      confirmingId={confirmingId}
      busy={busy}
      onSync={handleSync}
      onAskRemove={setConfirmingId}
      onCancel={() => setConfirmingId(null)}
      onRemove={handleRemove}
    />
  )
}
