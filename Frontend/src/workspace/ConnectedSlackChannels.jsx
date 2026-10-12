import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getSlackChannels,
  getSlackStatus,
  linkSlackChannel,
  unlinkSlackChannel,
  syncSlackChannel,
  listProjectRepositories,
} from '../api/connections'
import { formatDate } from './utils'
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

function SlackChannelPickerModal({ isOpen, onClose, onChannelConnected }) {
  const dialogRef = useRef(null)
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [channels, setChannels] = useState([])
  const [workspaceConnected, setWorkspaceConnected] = useState(true)
  const [error, setError] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedChannel, setSelectedChannel] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const node = dialogRef.current
    if (!node) return
    if (isOpen) {
      if (!node.open) node.showModal()
      loadChannels()
    } else {
      if (node.open) node.close()
    }
  }, [isOpen])

  async function loadChannels() {
    setLoading(true)
    setError('')
    setSelectedChannel(null)
    try {
      const data = await getSlackChannels()
      if (data.connected === false) {
        setWorkspaceConnected(false)
        setChannels([])
      } else {
        setWorkspaceConnected(true)
        setChannels(data.channels || [])
      }
    } catch (err) {
      setError(err.message || 'Could not load Slack channels.')
    } finally {
      setLoading(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!selectedChannel || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await onChannelConnected(selectedChannel)
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to connect Slack channel.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  const filtered = channels.filter(c =>
    (c.name || '').toLowerCase().includes(searchQuery.trim().toLowerCase())
  )

  return (
    <dialog
      ref={dialogRef}
      className="ws-modal"
      onCancel={onClose}
      onClick={e => {
        if (e.target === e.currentTarget && !submitting) onClose()
      }}
      style={{ maxWidth: '520px' }}
    >
      <button
        className="ws-modal-close"
        aria-label="Close dialog"
        onClick={onClose}
        disabled={submitting}
      >
        ×
      </button>
      <span className="ws-eyebrow">SLACK INTEGRATION</span>
      <h2>Connect a Slack channel</h2>
      <p className="ws-muted" style={{ marginBottom: '16px', fontSize: '13px' }}>
        Select a channel from your connected workspace to link discussions and context to this project.
      </p>

      {loading && (
        <div className="ws-loading" role="status" style={{ padding: '24px 0' }}>
          <span className="ws-spinner" /> Loading available channels…
        </div>
      )}

      {!loading && !workspaceConnected && (
        <div style={{ background: '#fdf8f4', border: '1px solid #f2dfd0', borderRadius: '8px', padding: '16px', textAlign: 'center' }}>
          <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--ws-ink)' }}>
            Your Slack workspace is not connected yet. Connect your bot token first before linking channels.
          </p>
          <button
            type="button"
            className="ws-button ws-button-primary"
            onClick={() => {
              onClose()
              navigate('/connections')
            }}
          >
            Go to Connections
          </button>
        </div>
      )}

      {!loading && workspaceConnected && (
        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '14px' }}>
          {channels.length > 5 && (
            <div style={{ position: 'relative' }}>
              <input
                type="search"
                placeholder="Search channels…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--ws-border)',
                  fontSize: '12px',
                  outline: 'none',
                  background: '#fff',
                }}
              />
            </div>
          )}

          {filtered.length === 0 ? (
            <p className="ws-muted" style={{ textAlign: 'center', padding: '16px 0', fontSize: '13px' }}>
              {channels.length === 0
                ? 'No channels found. Ensure the bot is added to channels or has the required scopes.'
                : 'No channels match your search.'}
            </p>
          ) : (
            <div
              style={{
                maxHeight: '260px',
                overflowY: 'auto',
                display: 'grid',
                gap: '6px',
                padding: '2px',
              }}
            >
              {filtered.map(channel => {
                const isSelected = selectedChannel?.id === channel.id
                return (
                  <div
                    key={channel.id}
                    onClick={() => setSelectedChannel(channel)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: isSelected
                        ? '1.5px solid #c14e16'
                        : '1px solid var(--ws-border)',
                      background: isSelected ? '#fdf8f4' : '#fff',
                      cursor: 'pointer',
                      transition: 'border-color 0.15s, background-color 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: '600', color: isSelected ? '#c14e16' : 'var(--ws-ink)', fontSize: '13px' }}>
                        #{channel.name}
                      </span>
                      <span className={`ws-badge ${channel.is_private ? 'ws-badge-pending' : ''}`} style={{ fontSize: '10.5px' }}>
                        {channel.is_private ? 'Private' : 'Public'}
                      </span>
                    </div>
                    {channel.is_member ? (
                      <span style={{ fontSize: '11px', color: '#2e7d32', fontWeight: '500' }}>
                        ✓ Bot joined
                      </span>
                    ) : (
                      <span style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                        Needs /invite
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {error && <p className="ws-error" role="alert">{error}</p>}

          <div className="ws-modal-actions" style={{ marginTop: '8px' }}>
            <button type="button" className="ws-button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              type="submit"
              className="ws-button ws-button-primary"
              disabled={!selectedChannel || submitting}
            >
              {submitting ? 'Connecting & syncing…' : 'Connect Channel'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  )
}

function SlackChannelCard({
  channel,
  canManage,
  canSync,
  busy,
  syncing,
  confirming,
  onAskRemove,
  onCancelRemove,
  onRemove,
  onSync,
}) {
  const sync = channel.sync || {}
  const status = syncing ? 'syncing' : sync.status || 'pending'

  return (
    <article className="ws-repo-card">
      <div className="ws-project-card-top">
        <span className="ws-project-symbol">
          <Icon name="slack" />
        </span>
        <span className={`ws-badge ${SYNC_BADGES[status] || ''}`}>
          {SYNC_LABELS[status] || 'Not synced'}
        </span>
      </div>
      <h3>#{channel.channelName || channel.channelId}</h3>
      <div className="ws-repo-meta">
        <span className="ws-badge">
          {channel.teamName || channel.teamDomain || 'Slack'}
        </span>
        <span className="ws-muted">
          {sync.lastSuccessAt ? `Last synced ${dateTime(sync.lastSuccessAt)}` : 'Not synced yet'}
        </span>
      </div>
      <div className="ws-repo-stats">
        <span>
          <strong>{sync.syncedMessageCount || 0}</strong> messages synced
        </span>
      </div>
      {sync.error && <p className="ws-inline-error" role="alert">{sync.error}</p>}
      <div className="ws-repo-actions">
        <span className="ws-repo-links">
          {canManage && !confirming && (
            <button
              type="button"
              className="ws-text-button ws-danger"
              onClick={onAskRemove}
              disabled={syncing}
            >
              Disconnect
            </button>
          )}
        </span>
        {canSync && (
          <button
            type="button"
            className="ws-button"
            onClick={onSync}
            disabled={syncing || status === 'syncing'}
          >
            {status === 'syncing' ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>
      {confirming && (
        <div className="ws-repo-confirm" role="group" aria-label="Confirm disconnect">
          <p className="ws-muted">
            Disconnect #{channel.channelName || channel.channelId}? Ingested records for this channel will be removed from the project.
          </p>
          <div>
            <button type="button" className="ws-button" onClick={onCancelRemove} disabled={busy}>
              Keep
            </button>
            <button
              type="button"
              className="ws-button ws-button-danger"
              onClick={onRemove}
              disabled={busy}
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </div>
      )}
    </article>
  )
}

export default function ConnectedSlackChannels({ projectId, canManage, canSync }) {
  const [channels, setChannels] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const [removingId, setRemovingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [syncingIds, setSyncingIds] = useState([])

  async function loadConnectedChannels() {
    setLoading(true)
    setError('')
    try {
      const data = await listProjectRepositories(projectId)
      setChannels(data.integrations?.slack || [])
    } catch (err) {
      setError(err.message || 'Failed to load connected Slack channels.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadConnectedChannels()
  }, [projectId])

  async function handleChannelConnected(channel) {
    await linkSlackChannel(projectId, {
      channelId: channel.id,
      channelName: channel.name,
    })
    await loadConnectedChannels()
  }

  async function handleSync(channel) {
    setSyncingIds(prev => [...prev, channel.id])
    try {
      await syncSlackChannel(projectId, channel.id)
      await loadConnectedChannels()
    } catch (err) {
      setError(err.message || 'Failed to sync Slack channel.')
    } finally {
      setSyncingIds(prev => prev.filter(id => id !== channel.id))
    }
  }

  async function handleRemove(channel) {
    setBusy(true)
    try {
      await unlinkSlackChannel(projectId, channel.id)
      setRemovingId(null)
      await loadConnectedChannels()
    } catch (err) {
      setError(err.message || 'Failed to remove Slack channel.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ws-panel ws-repositories" aria-labelledby="connected-slack-channels">
      <div className="ws-section-heading">
        <div>
          <h2 id="connected-slack-channels">Connected Slack channels</h2>
          <p>Discussions, threads, and decisions that give this project its team context.</p>
        </div>
        {canManage && (
          <button type="button" className="ws-text-button" onClick={() => setIsPickerOpen(true)}>
            + Connect Slack channel
          </button>
        )}
      </div>

      {loading && (
        <div className="ws-repo-grid" role="status" aria-label="Loading Slack channels">
          <div className="ws-skeleton" />
        </div>
      )}

      {error && !loading && (
        <div className="ws-integration-body" style={{ marginBottom: '12px' }}>
          <p className="ws-error" role="alert">{error}</p>
          <button type="button" className="ws-button" onClick={loadConnectedChannels}>
            Try again
          </button>
        </div>
      )}

      {!loading && (
        channels.length > 0 ? (
          <div className="ws-repo-grid">
            {channels.map(channel => (
              <SlackChannelCard
                key={channel.id}
                channel={channel}
                canManage={canManage}
                canSync={canSync}
                busy={busy}
                syncing={syncingIds.includes(channel.id)}
                confirming={removingId === channel.id}
                onAskRemove={() => setRemovingId(channel.id)}
                onCancelRemove={() => setRemovingId(null)}
                onRemove={() => handleRemove(channel)}
                onSync={() => handleSync(channel)}
              />
            ))}
          </div>
        ) : (
          <p className="ws-panel-empty">
            {canManage
              ? 'No Slack channels connected yet. Connect one to bring its conversations and decisions into this project.'
              : 'No Slack channels are connected to this project yet.'}
            {canManage && (
              <>
                <br />
                <button
                  type="button"
                  className="ws-button ws-button-primary"
                  onClick={() => setIsPickerOpen(true)}
                  style={{ marginTop: '8px' }}
                >
                  Connect Slack channel
                </button>
              </>
            )}
          </p>
        )
      )}

      <SlackChannelPickerModal
        isOpen={isPickerOpen}
        onClose={() => setIsPickerOpen(false)}
        onChannelConnected={handleChannelConnected}
      />
    </section>
  )
}
