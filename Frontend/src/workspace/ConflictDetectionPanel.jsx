import { useState, useEffect } from 'react'
import { Badge } from './ui'
import { listProjectConflicts, detectProjectConflicts, createProjectConflict } from '../api/conflicts'
import ConflictComparisonModal from './ConflictComparisonModal'
import { formatDate } from './utils'
import './conflicts.css'

export default function ConflictDetectionPanel({ projectId, canManage = false }) {
  const [conflicts, setConflicts] = useState([])
  const [loading, setLoading] = useState(true)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState('all')
  const [selectedConflict, setSelectedConflict] = useState(null)

  useEffect(() => {
    let active = true
    loadConflicts()
    async function loadConflicts() {
      setLoading(true)
      try {
        const res = await listProjectConflicts(projectId)
        if (active) setConflicts(res.conflicts || [])
      } catch (err) {
        if (active) setError(err.message || 'Failed to load conflicts.')
      } finally {
        if (active) setLoading(false)
      }
    }
    return () => { active = false }
  }, [projectId])

  async function handleScan() {
    setDetecting(true)
    setError('')
    setNotice('')
    try {
      const res = await detectProjectConflicts(projectId)
      const detected = res.conflicts || []
      if (detected.length === 0) {
        setNotice('No contradictions found! All project artifacts and sources align.')
      } else {
        // Save newly detected conflicts to DB if not present
        let newCount = 0
        for (const candidate of detected) {
          try {
            await createProjectConflict(projectId, candidate)
            newCount++
          } catch {
            // Already recorded / deduped
          }
        }
        // Refresh list
        const refreshed = await listProjectConflicts(projectId)
        setConflicts(refreshed.conflicts || [])
        setNotice(`Scan complete: evaluated ${res.evaluatedFactCount || 0} facts, found ${detected.length} potential conflict(s).`)
      }
    } catch (err) {
      setError(err.message || 'Conflict scan failed.')
    } finally {
      setDetecting(false)
    }
  }

  function handleConflictUpdated(updated) {
    setConflicts(prev => prev.map(c => c.id === updated.id ? updated : c))
    setSelectedConflict(updated)
    setNotice('Conflict status updated.')
  }

  const openCount = conflicts.filter(c => c.status === 'open').length
  const criticalCount = conflicts.filter(c => c.status === 'open' && c.severity === 'critical').length
  const filteredConflicts = conflicts.filter(c => filter === 'all' || c.status === filter)

  return (
    <section className={`ws-panel ws-conflict-panel ${criticalCount > 0 ? 'has-critical' : ''}`} aria-labelledby="conflict-panel-title">
      <div className="ws-section-heading">
        <div>
          <h2 id="conflict-panel-title">Conflict Detection & Resolution</h2>
          <p>AI scans tasks, commits, documents, and messages to detect contradictory deadlines, statuses, and decisions.</p>
        </div>
        <div className="ws-conflict-header-actions">
          {canManage && (
            <button
              type="button"
              className="ws-button ws-button-primary"
              onClick={handleScan}
              disabled={detecting}
            >
              {detecting ? 'Analyzing records…' : 'Scan for Conflicts'}
            </button>
          )}
        </div>
      </div>

      <div className="ws-conflict-stats-row">
        <span className="ws-conflict-stat-pill">
          Total: {conflicts.length}
        </span>
        <span className={`ws-conflict-stat-pill ${criticalCount > 0 ? 'critical' : ''}`}>
          {criticalCount > 0 ? `⚠️ ${criticalCount} Critical` : `${openCount} Open`}
        </span>
        <span className="ws-conflict-stat-pill resolved">
          {conflicts.filter(c => ['resolved', 'dismissed'].includes(c.status)).length} Resolved
        </span>
      </div>

      {notice && <p className="ws-notice" role="status" style={{ marginBottom: '14px' }}>{notice}</p>}
      {error && <p className="ws-error" role="alert" style={{ marginBottom: '14px' }}>{error}</p>}

      {conflicts.length > 0 && (
        <div className="ws-filters" style={{ marginBottom: '14px' }}>
          <div className="ws-tabs">
            {[['all', 'All'], ['open', 'Open'], ['reviewed', 'Reviewed'], ['resolved', 'Resolved']].map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={filter === val ? 'active' : ''}
                onClick={() => setFilter(val)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="ws-muted">{filteredConflicts.length} item(s)</span>
        </div>
      )}

      {loading ? (
        <p className="ws-muted">Loading conflict intelligence…</p>
      ) : filteredConflicts.length === 0 ? (
        <p className="ws-panel-empty">
          {conflicts.length === 0
            ? 'No conflicts detected yet. Run "Scan for Conflicts" to check project continuity.'
            : `No ${filter} conflicts found.`}
        </p>
      ) : (
        <div className="ws-conflict-list">
          {filteredConflicts.map(c => {
            const sideA = c.evidence?.[0]
            const sideB = c.evidence?.[1]
            return (
              <div key={c.id} className="ws-conflict-card">
                <div className="ws-conflict-card-top">
                  <div className="ws-conflict-title-group">
                    <h3 className="ws-conflict-card-title">{c.title}</h3>
                    {c.description && <p className="ws-conflict-description">{c.description}</p>}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span className={`ws-badge ws-badge-${c.severity || 'medium'}`}>{c.severity}</span>
                    <Badge value={c.status} />
                  </div>
                </div>

                {/* Mini Side-by-Side Preview */}
                {(sideA || sideB) && (
                  <div className="ws-conflict-preview-box">
                    <div className="ws-conflict-preview-item">
                      <span className="ws-conflict-preview-label">{sideA?.sourceType || 'Source A'}</span>
                      <span className="ws-conflict-preview-text">“{sideA?.excerpt || '—'}”</span>
                    </div>
                    <div className="ws-conflict-preview-item">
                      <span className="ws-conflict-preview-label">{sideB?.sourceType || 'Source B'}</span>
                      <span className="ws-conflict-preview-text">“{sideB?.excerpt || '—'}”</span>
                    </div>
                  </div>
                )}

                <div className="ws-conflict-actions-bar">
                  <span className="ws-muted" style={{ fontSize: '11px' }}>
                    Detected {formatDate(c.createdAt)}
                  </span>
                  <button
                    type="button"
                    className="ws-button"
                    style={{ fontSize: '11px', padding: '6px 12px', minHeight: 'auto' }}
                    onClick={() => setSelectedConflict(c)}
                  >
                    Compare Sources & Details →
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selectedConflict && (
        <ConflictComparisonModal
          conflict={selectedConflict}
          canManage={canManage}
          onClose={() => setSelectedConflict(null)}
          onUpdated={handleConflictUpdated}
        />
      )}
    </section>
  )
}
