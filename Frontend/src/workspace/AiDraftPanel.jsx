import { useState } from 'react'
import { Badge } from './ui'
import SourceDetailModal from './SourceDetailModal'

const KINDS = { sourced: 'Supported by sources', inference: 'Inference', unknown: 'Unknown' }

// Presentational: shows what the AI produced, what it was based on, and how trustworthy each line is.
export function AiDraftPanel({ draft, busy, disabled, onGenerate, onApply }) {
  const [selectedSource, setSelectedSource] = useState(null)

  return (
    <>
      <section className="ws-panel ws-ai-draft" aria-labelledby="ai-draft-title">
        <div className="ws-section-heading"><div><h2 id="ai-draft-title">Draft from your project’s sources</h2><p>Built from synchronized GitHub activity, notes, and tasks. Nothing is saved until you apply the draft and save.</p></div><button type="button" className="ws-button ws-button-primary" onClick={onGenerate} disabled={disabled}>{busy ? 'Drafting…' : draft ? 'Draft again' : 'Draft with AI'}</button></div>
        {busy && <p className="ws-muted" role="status">Reading project sources and drafting. This can take up to a minute.</p>}
        {draft && <>
          <p className="ws-muted">{`Generated ${new Date(draft.generatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} from ${draft.basedOn?.github ?? 0} GitHub records, ${draft.basedOn?.notes ?? 0} notes and ${draft.basedOn?.tasks ?? 0} tasks.`}</p>
          {draft.limitations?.length > 0 && <div className="ws-notice" role="status"><strong>Data limitations</strong><ul>{draft.limitations.map(item => <li key={item}>{item}</li>)}</ul></div>}
          <p className="ws-ai-summary">{draft.currentStatus}</p>
          {draft.items.length > 0 && <ul className="ws-ai-items">{draft.items.map((item, index) => <li key={index}><span className="ws-ai-item-tags"><Badge value={item.type}/><span className={`ws-badge ${item.kind === 'sourced' ? 'ws-badge-completed' : ''}`}>{KINDS[item.kind] || KINDS.inference}</span></span><span>{item.text}</span></li>)}</ul>}
          {draft.sources?.length > 0 && (
            <div className="ws-ai-sources">
              <strong>Sources used</strong>
              <ul>
                {draft.sources.map(source => (
                  <li key={source.id}>
                    <button
                      type="button"
                      className="ws-source-button"
                      style={{ background: 'none', border: 'none', padding: 0, color: '#c04d26', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => setSelectedSource(source)}
                    >
                      {source.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" className="ws-button" onClick={onApply} disabled={disabled}>Apply to this handoff</button>
        </>}
      </section>
      {selectedSource && (
        <SourceDetailModal
          source={selectedSource}
          onClose={() => setSelectedSource(null)}
        />
      )}
    </>
  )
}
