import { useEffect, useRef, useState } from 'react'
import { Badge } from './ui'
import { downloadProjectDocument } from '../api/documents'
import { SOURCE_TYPE_LABELS } from './documentHelpers'
import SourceDetailModal from './SourceDetailModal'

const KINDS = { fact: 'Source-backed', inference: 'Inference', unknown: 'Unknown' }

// One citation chip. Uploaded documents open through the authorized API,
// and clicking any source opens the SourceDetailModal for excerpt review.
function Source({ source, onOpenSource }) {
  const tag = SOURCE_TYPE_LABELS[source.type] && <span className={`ws-source-type ws-source-type-${source.type}`}>{SOURCE_TYPE_LABELS[source.type]}</span>
  return (
    <span style={{ cursor: 'pointer' }} onClick={() => onOpenSource(source)}>
      {tag}
      <button type="button" className="ws-source-button" style={{ textDecoration: 'underline' }}>
        {source.label || 'Source'}
      </button>
      {source.document?.chunkId && <span className="ws-source-ref">{` ref ${source.document.chunkId}`}</span>}
    </span>
  )
}

// Presentational: renders the stored report exactly as generated.
export function HandoffReportBody({ report, onOpenSource }) {
  return <div className="ws-report">
    <p className="ws-muted">{`Generated ${new Date(report.generatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`}</p>
    <div className="ws-report-repos">{report.repositories.map(repo => <div key={repo.fullName}><strong>{repo.fullName}</strong><span className="ws-muted">{`commit ${repo.commitSha.slice(0, 7)} · ${repo.branch} · analysis ${repo.status} (${repo.coverage.percent}% of eligible files) · knowledge ${repo.freshness || 'unknown'}`}</span></div>)}</div>
    {report.limitations.length > 0 && <div className="ws-notice" role="status"><strong>Limitations</strong><ul>{report.limitations.map(item => <li key={item}>{item}</li>)}</ul></div>}
    {report.sections.map(section => <section key={section.key} aria-labelledby={`report-${section.key}`}>
      <h3 id={`report-${section.key}`}>{section.title}</h3>
      <ul className="ws-report-items">{section.items.map((item, index) => <li key={index}>
        <span>{item.text}</span>
        {section.key !== 'links' && <span className="ws-report-tags">{item.kind && <span className={`ws-badge ${item.kind === 'fact' ? 'ws-badge-completed' : ''}`}>{KINDS[item.kind]}</span>}{item.evidence?.map(source => <Source key={source.id} source={source} onOpenSource={onOpenSource}/>)}</span>}
        {section.key === 'links' && item.evidence?.[0]?.url && <a href={item.evidence[0].url} target="_blank" rel="noopener noreferrer">{item.evidence[0].url}</a>}
      </li>)}</ul>
    </section>)}
  </div>
}

export default function HandoffReportPreview({ report, onClose, onDownload, downloading, error }) {
  const dialog = useRef(null)
  const [documentError, setDocumentError] = useState('')
  const [selectedSource, setSelectedSource] = useState(null)

  function openSource(source) {
    setSelectedSource(source)
  }

  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])

  return (
    <>
      <dialog ref={dialog} className="ws-modal ws-modal-wide" aria-labelledby="report-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
        <button className="ws-modal-close" aria-label="Close preview" onClick={onClose}>×</button>
        <span className="ws-eyebrow">DEVELOPER HANDOFF</span>
        <h2 id="report-title">{report.projectName}</h2>
        <Badge value="preview"/>
        {(error || documentError) && <p className="ws-error" role="alert">{error || documentError}</p>}
        <HandoffReportBody report={report} onOpenSource={openSource}/>
        <div className="ws-modal-actions"><button type="button" className="ws-button" onClick={onClose}>Close</button><button type="button" className="ws-button ws-button-primary" onClick={onDownload} disabled={downloading}>{downloading ? 'Preparing PDF…' : 'Download PDF'}</button></div>
      </dialog>
      {selectedSource && (
        <SourceDetailModal
          source={selectedSource}
          projectId={report.projectId}
          onClose={() => setSelectedSource(null)}
        />
      )}
    </>
  )
}
