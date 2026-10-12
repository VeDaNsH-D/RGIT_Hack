import { useEffect, useRef } from 'react'
import { Badge } from './ui'

const KINDS = { fact: 'Source-backed', inference: 'Inference', unknown: 'Unknown' }

// Presentational: renders the stored report exactly as generated.
export function HandoffReportBody({ report }) {
  return <div className="ws-report">
    <p className="ws-muted">{`Generated ${new Date(report.generatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`}</p>
    <div className="ws-report-repos">{report.repositories.map(repo => <div key={repo.fullName}><strong>{repo.fullName}</strong><span className="ws-muted">{`commit ${repo.commitSha.slice(0, 7)} · ${repo.branch} · analysis ${repo.status} (${repo.coverage.percent}% of eligible files) · knowledge ${repo.freshness || 'unknown'}`}</span></div>)}</div>
    {report.limitations.length > 0 && <div className="ws-notice" role="status"><strong>Limitations</strong><ul>{report.limitations.map(item => <li key={item}>{item}</li>)}</ul></div>}
    {report.sections.map(section => <section key={section.key} aria-labelledby={`report-${section.key}`}>
      <h3 id={`report-${section.key}`}>{section.title}</h3>
      <ul className="ws-report-items">{section.items.map((item, index) => <li key={index}>
        <span>{item.text}</span>
        {section.key !== 'links' && <span className="ws-report-tags">{item.kind && <span className={`ws-badge ${item.kind === 'fact' ? 'ws-badge-completed' : ''}`}>{KINDS[item.kind]}</span>}{item.evidence?.map(source => source.url ? <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a> : <small key={source.id} className="ws-muted">{source.label}</small>)}</span>}
        {section.key === 'links' && item.evidence?.[0]?.url && <a href={item.evidence[0].url} target="_blank" rel="noopener noreferrer">{item.evidence[0].url}</a>}
      </li>)}</ul>
    </section>)}
  </div>
}

export default function HandoffReportPreview({ report, onClose, onDownload, downloading, error }) {
  const dialog = useRef(null)
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
    {error && <p className="ws-error" role="alert">{error}</p>}
    <HandoffReportBody report={report}/>
    <div className="ws-modal-actions"><button type="button" className="ws-button" onClick={onClose}>Close</button><button type="button" className="ws-button ws-button-primary" onClick={onDownload} disabled={downloading}>{downloading ? 'Preparing PDF…' : 'Download PDF'}</button></div>
  </dialog>
}
