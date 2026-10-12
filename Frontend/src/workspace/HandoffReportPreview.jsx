import { useEffect, useRef, useState } from 'react'
import { Badge } from './ui'
import { downloadProjectDocument } from '../api/documents'
import { SOURCE_TYPE_LABELS } from './documentHelpers'

const KINDS = { fact: 'Source-backed', inference: 'Inference', unknown: 'Unknown' }

// One citation chip. Uploaded documents are private: they open through the authorized API (never a public link),
// everything else links to its GitHub URL when it has one. The type tag keeps the source kinds distinguishable.
function Source({ source, onOpenDocument }) {
  const tag = SOURCE_TYPE_LABELS[source.type] && <span className={`ws-source-type ws-source-type-${source.type}`}>{SOURCE_TYPE_LABELS[source.type]}</span>
  if (source.type === 'document' && source.document) {
    return <span>{tag}{onOpenDocument ? <button type="button" className="ws-source-button" onClick={() => onOpenDocument(source)}>{source.label}</button> : <small className="ws-muted">{source.label}</small>}<span className="ws-source-ref">{` ref ${source.document.chunkId}`}</span></span>
  }
  return <span>{tag}{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a> : <small className="ws-muted">{source.label}</small>}</span>
}

// Presentational: renders the stored report exactly as generated.
export function HandoffReportBody({ report, onOpenDocument }) {
  return <div className="ws-report">
    <p className="ws-muted">{`Generated ${new Date(report.generatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`}</p>
    <div className="ws-report-repos">{report.repositories.map(repo => <div key={repo.fullName}><strong>{repo.fullName}</strong><span className="ws-muted">{`commit ${repo.commitSha.slice(0, 7)} · ${repo.branch} · analysis ${repo.status} (${repo.coverage.percent}% of eligible files) · knowledge ${repo.freshness || 'unknown'}`}</span></div>)}</div>
    {report.limitations.length > 0 && <div className="ws-notice" role="status"><strong>Limitations</strong><ul>{report.limitations.map(item => <li key={item}>{item}</li>)}</ul></div>}
    {report.sections.map(section => <section key={section.key} aria-labelledby={`report-${section.key}`}>
      <h3 id={`report-${section.key}`}>{section.title}</h3>
      <ul className="ws-report-items">{section.items.map((item, index) => <li key={index}>
        <span>{item.text}</span>
        {section.key !== 'links' && <span className="ws-report-tags">{item.kind && <span className={`ws-badge ${item.kind === 'fact' ? 'ws-badge-completed' : ''}`}>{KINDS[item.kind]}</span>}{item.evidence?.map(source => <Source key={source.id} source={source} onOpenDocument={onOpenDocument}/>)}</span>}
        {section.key === 'links' && item.evidence?.[0]?.url && <a href={item.evidence[0].url} target="_blank" rel="noopener noreferrer">{item.evidence[0].url}</a>}
      </li>)}</ul>
    </section>)}
  </div>
}

export default function HandoffReportPreview({ report, onClose, onDownload, downloading, error }) {
  const dialog = useRef(null)
  const [documentError, setDocumentError] = useState('')
  async function openDocument(source) {
    setDocumentError('')
    try { await downloadProjectDocument(report.projectId, source.document.documentId, source.document.filename) } catch (failure) { setDocumentError(failure.message) }
  }
  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])
  return <dialog ref={dialog} className="ws-modal ws-modal-wide" aria-labelledby="report-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <button className="ws-modal-close" aria-label="Close preview" onClick={onClose}>×</button>
    <span className="ws-eyebrow">DEVELOPER HANDOFF</span>
    <h2 id="report-title">{report.projectName}</h2>
    <Badge value="preview"/>
    {(error || documentError) && <p className="ws-error" role="alert">{error || documentError}</p>}
    <HandoffReportBody report={report} onOpenDocument={openDocument}/>
    <div className="ws-modal-actions"><button type="button" className="ws-button" onClick={onClose}>Close</button><button type="button" className="ws-button ws-button-primary" onClick={onDownload} disabled={downloading}>{downloading ? 'Preparing PDF…' : 'Download PDF'}</button></div>
  </dialog>
}
