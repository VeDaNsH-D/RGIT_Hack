import { useState, useRef, useEffect } from 'react'
import { Badge } from './ui'
import { reviewConflict, resolveConflict } from '../api/conflicts'
import { formatDate } from './utils'

export default function ConflictComparisonModal({ conflict, onClose, onUpdated, canManage = false }) {
  const dialog = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [outcome, setOutcome] = useState('resolved')

  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => {
      if (el && el.open) el.close()
    }
  }, [])

  const evidence = conflict.evidence || []
  const sideA = evidence[0] || null
  const sideB = evidence[1] || null
  const extraEvidence = evidence.slice(2)

  async function handleReview() {
    setBusy(true)
    setError('')
    try {
      const res = await reviewConflict(conflict.id)
      onUpdated(res.conflict)
    } catch (err) {
      setError(err.message || 'Failed to update conflict status.')
    } finally {
      setBusy(false)
    }
  }

  async function handleResolve(e) {
    e.preventDefault()
    if (!note.trim()) {
      setError('Please provide a resolution note.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await resolveConflict(conflict.id, { outcome, note: note.trim() })
      onUpdated(res.conflict)
    } catch (err) {
      setError(err.message || 'Failed to resolve conflict.')
    } finally {
      setBusy(false)
    }
  }

  const isResolved = ['resolved', 'dismissed'].includes(conflict.status)

  return (
    <dialog
      ref={dialog}
      className="ws-modal ws-modal-wide"
      aria-labelledby="conflict-modal-title"
      onCancel={onClose}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <button className="ws-modal-close" aria-label="Close" onClick={onClose}>×</button>
      <span className="ws-eyebrow">AI CONFLICT COMPARISON</span>
      <h2 id="conflict-modal-title" style={{ marginTop: '4px', marginBottom: '8px' }}>{conflict.title}</h2>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px' }}>
        <span className={`ws-badge ws-badge-${conflict.severity || 'medium'}`}>{conflict.severity || 'Medium'} Severity</span>
        <Badge value={conflict.status} />
        {conflict.createdAt && <span className="ws-muted" style={{ fontSize: '11px' }}>Detected {formatDate(conflict.createdAt)}</span>}
      </div>

      {conflict.description && (
        <p style={{ fontSize: '13px', color: '#475569', lineHeight: '1.6', marginBottom: '16px' }}>
          {conflict.description}
        </p>
      )}

      {error && <p className="ws-error" role="alert" style={{ marginBottom: '14px' }}>{error}</p>}

      {/* Side-by-Side Comparison Grid */}
      <div className="ws-comparison-grid">
        <div className="ws-comparison-card side-a">
          <div className="ws-comparison-card-head">
            <span>Primary Claim (Source A)</span>
            <span className="ws-badge">{sideA?.sourceType || 'Source A'}</span>
          </div>
          <div className="ws-comparison-excerpt">
            “{sideA?.excerpt || 'No excerpt available'}”
          </div>
          <div className="ws-comparison-meta">
            {sideA?.timestamp && <span>Timestamp: {formatDate(sideA.timestamp)}</span>}
            {sideA?.url ? (
              <a href={sideA.url} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb' }}>
                Open original reference ↗
              </a>
            ) : (
              <span>Internal system fact</span>
            )}
          </div>
        </div>

        <div className="ws-comparison-card side-b">
          <div className="ws-comparison-card-head">
            <span>Contradicting Claim (Source B)</span>
            <span className="ws-badge">{sideB?.sourceType || 'Source B'}</span>
          </div>
          <div className="ws-comparison-excerpt">
            “{sideB?.excerpt || 'No excerpt available'}”
          </div>
          <div className="ws-comparison-meta">
            {sideB?.timestamp && <span>Timestamp: {formatDate(sideB.timestamp)}</span>}
            {sideB?.url ? (
              <a href={sideB.url} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb' }}>
                Open original reference ↗
              </a>
            ) : (
              <span>Internal system fact</span>
            )}
          </div>
        </div>
      </div>

      {extraEvidence.length > 0 && (
        <div style={{ marginTop: '12px', marginBottom: '16px' }}>
          <strong style={{ fontSize: '12px', color: '#64748b' }}>Additional Competing Evidence:</strong>
          <ul style={{ paddingLeft: '20px', fontSize: '12px', marginTop: '6px' }}>
            {extraEvidence.map((ex, i) => (
              <li key={i} style={{ marginBottom: '6px' }}>
                <strong>{ex.sourceType}:</strong> “{ex.excerpt}”
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Resolution or Audit details */}
      {isResolved ? (
        <div className="ws-conflict-resolution-box resolved">
          <strong style={{ fontSize: '13px', color: '#166534' }}>
            Resolution ({conflict.status === 'resolved' ? 'Resolved' : 'Dismissed'}):
          </strong>
          <p style={{ margin: 0, fontSize: '12px', color: '#334155' }}>{conflict.resolutionNote}</p>
          {conflict.resolvedAt && (
            <small className="ws-muted">Recorded on {formatDate(conflict.resolvedAt)}</small>
          )}
        </div>
      ) : canManage && (
        <form onSubmit={handleResolve} className="ws-conflict-resolution-box">
          <strong style={{ fontSize: '13px', color: '#0f172a' }}>Resolve or Review this Conflict</strong>
          <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
            <label style={{ fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                type="radio"
                name="outcome"
                value="resolved"
                checked={outcome === 'resolved'}
                onChange={() => setOutcome('resolved')}
              />
              Mark Resolved (Action agreed)
            </label>
            <label style={{ fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                type="radio"
                name="outcome"
                value="dismissed"
                checked={outcome === 'dismissed'}
                onChange={() => setOutcome('dismissed')}
              />
              Dismiss (Not a blocker)
            </label>
          </div>
          <textarea
            required
            rows={2}
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Explain how this conflict was settled or why it is dismissed..."
            style={{
              padding: '8px 10px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              fontSize: '12px',
              width: '100%',
            }}
          />
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '4px' }}>
            {conflict.status === 'open' && (
              <button
                type="button"
                className="ws-button"
                onClick={handleReview}
                disabled={busy}
              >
                Mark Under Review
              </button>
            )}
            <button
              type="submit"
              className="ws-button ws-button-primary"
              disabled={busy || !note.trim()}
            >
              {busy ? 'Saving…' : 'Submit Resolution'}
            </button>
          </div>
        </form>
      )}

      <div className="ws-modal-actions" style={{ marginTop: '20px' }}>
        <button type="button" className="ws-button" onClick={onClose}>Close</button>
      </div>
    </dialog>
  )
}
