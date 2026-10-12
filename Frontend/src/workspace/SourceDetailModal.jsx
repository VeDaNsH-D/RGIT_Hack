import { useRef, useEffect } from 'react'
import { Badge } from './ui'
import { downloadProjectDocument } from '../api/documents'

export default function SourceDetailModal({ source, projectId, onClose }) {
  const dialog = useRef(null)

  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => {
      if (el && el.open) el.close()
    }
  }, [])

  if (!source) return null

  async function handleDownloadDoc() {
    if (!source.document?.documentId) return
    try {
      await downloadProjectDocument(projectId, source.document.documentId, source.document.filename)
    } catch (err) {
      alert(err.message || 'Failed to download document.')
    }
  }

  return (
    <dialog
      ref={dialog}
      className="ws-modal ws-source-detail-modal"
      aria-labelledby="source-detail-title"
      onCancel={onClose}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <button className="ws-modal-close" aria-label="Close" onClick={onClose}>×</button>
      <span className="ws-eyebrow">EVIDENCE & SOURCE REFERENCE</span>
      <h2 id="source-detail-title" style={{ marginTop: '4px', marginBottom: '8px' }}>
        {source.label || source.title || 'Source Reference'}
      </h2>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span className="ws-badge ws-badge-completed">Verified Evidence</span>
        {source.type && <span className="ws-badge">{source.type}</span>}
        {source.kind && <Badge value={source.kind} />}
      </div>

      <div className="ws-source-detail-content">
        <div>
          <strong style={{ fontSize: '12px', color: '#475569', display: 'block', marginBottom: '6px' }}>
            Extracted Excerpt / Verbatim Content:
          </strong>
          <div className="ws-source-excerpt-box">
            {source.excerpt || source.text || source.label || 'No excerpt text preserved.'}
          </div>
        </div>

        <div className="ws-source-meta-grid">
          <div className="ws-source-meta-item">
            <small>Source Provider</small>
            <strong>{source.type || source.provider || 'System Record'}</strong>
          </div>
          <div className="ws-source-meta-item">
            <small>Reference Identifier</small>
            <strong>{source.document?.chunkId || source.id || 'N/A'}</strong>
          </div>
          {source.document?.filename && (
            <div className="ws-source-meta-item">
              <small>File / Document</small>
              <strong>{source.document.filename}</strong>
            </div>
          )}
          {source.url && (
            <div className="ws-source-meta-item">
              <small>External Resource</small>
              <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', fontSize: '12px' }}>
                Open original link ↗
              </a>
            </div>
          )}
        </div>
      </div>

      <div className="ws-modal-actions">
        {source.document?.documentId && (
          <button type="button" className="ws-button ws-button-primary" onClick={handleDownloadDoc}>
            Download Full Document
          </button>
        )}
        {source.url && (
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="ws-button ws-button-primary">
            Open in {source.type || 'Source'}
          </a>
        )}
        <button type="button" className="ws-button" onClick={onClose}>Close</button>
      </div>
    </dialog>
  )
}
