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
function LegacyReportBody({ report, onOpenDocument }) {
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

// Explicit evidence classes of the engineering layout (the earlier layout keeps its own wording in KINDS).
const CLASSES = { fact: 'Verified fact', inference: 'Inference', unknown: 'Unknown' }
const STATUS = { matches: 'Matches', conflicts: 'Conflict', unverified: 'Unverified', not_found: 'Not found in code' }
const LABELS = { confirmed: 'Confirmed', 'inferred risk': 'Inferred risk' }
const when = value => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

// Inline source numbers: compact [1,2] markers that jump to the numbered source index (no citation block under every statement).
function Refs({ item }) {
  if (!item.refs?.length) return null
  return <sup className="ws-refs">[{item.refs.map((n, i) => <span key={n}>{i > 0 && ','}<a href={`#src-${n}`}>{n}</a></span>)}]</sup>
}

function Tag({ item, tagged = true }) {
  const label = item.type === 'comparison' ? STATUS[item.status] : LABELS[item.label] || (tagged || item.kind === 'unknown' ? CLASSES[item.kind] : null)
  if (!label) return null
  const tone = item.type === 'comparison' ? (item.status === 'conflicts' ? 'ws-tag-alert' : '') : item.label === 'confirmed' ? 'ws-tag-alert' : `ws-tag-${item.kind}`
  return <span className={`ws-tag ${tone}`}>{label}</span>
}

const BASIS = { confirmed: 'confirmed', suggested: 'suggested', clarification_needed: 'clarification needed' }

// Joins list entries with "; " unless an entry already ends a sentence.
const joinList = list => (list || []).reduce((acc, x, i) => (i === 0 ? x : `${acc}${/[.!?]$/.test(acc) ? ' ' : '; '}${x}`), '')

function Detail({ name, children, code = false, alert = false }) {
  if (!children || (Array.isArray(children) && !children.length)) return null
  return <p className={code ? 'ws-code-line' : 'ws-detail'}><b className={alert ? 'ws-alert-text' : undefined}>{`${name}:`}</b> {code ? <code>{children}</code> : children}</p>
}

function Action({ item }) {
  return <li className="ws-action" value={item.n}>
    <strong>{item.text}</strong> <span className={`ws-tag ${item.priority === 'P1' ? 'ws-tag-alert' : ''}`}>{`${item.priority} ${BASIS[item.basis] || item.basis}`}</span><Refs item={item}/>
    <Detail name="Why">{item.why}</Detail>
    <Detail name="Needs first">{joinList(item.prerequisites)}</Detail>
    <Detail name="Done when">{item.doneWhen}</Detail>
    <Detail name="Files" code>{item.files?.join(', ')}</Detail>
    <Detail name="Symbols" code>{item.symbols?.join(', ')}</Detail>
    <Detail name="Scope" alert>{item.note}</Detail>
  </li>
}

// Technical walkthrough entry: purpose, entry point, ordered execution flow, functions and relationships, I/O, dependencies, limits.
function Subsystem({ item }) {
  const hasSteps = item.steps?.length > 0
  return <li className="ws-subsystem">
    <strong>{item.text}</strong> <Tag item={item}/><Refs item={item}/>
    <Detail name="Purpose">{item.purpose}</Detail>
    <Detail name="Entry point" code>{item.entry}</Detail>
    {hasSteps ? <><p className="ws-detail"><b>Execution flow:</b></p><ol className="ws-steps">{item.steps.map((step, i) => <li key={i}>{step}</li>)}</ol><Detail name="Summary">{item.flow}</Detail></> : <Detail name="How it runs">{item.flow}</Detail>}
    {item.functions?.length > 0 && <><p className="ws-detail"><b>Key functions:</b></p><ul className="ws-functions">{item.functions.map(f => <li key={f.name}><code>{f.name}{f.file && f.line ? ` (${f.file}:${f.line})` : ''}</code>{f.role ? ` ${f.role}` : ''}</li>)}</ul></>}
    <Detail name="Textual call sites" code>{item.calls?.map(c => `${c.from} -> ${c.to} (L${c.line})`).join(', ')}</Detail>
    <Detail name="Inputs">{joinList(item.inputs)}</Detail>
    <Detail name="Outputs">{joinList(item.outputs)}</Detail>
    <Detail name="Depends on">{joinList(item.dependencies)}</Detail>
    <Detail name="Limitations" alert>{joinList(item.limits)}</Detail>
    <Detail name="Files" code>{item.files?.join(', ')}</Detail>
  </li>
}

function Step({ item }) {
  return <li className="ws-step"><strong>{item.text}</strong><Refs item={item}/>
    <p className="ws-detail">{item.detail}</p>
    {item.reads?.length > 0 && <ul className="ws-functions">{item.reads.map(r => <li key={r.file}><code>{r.file}</code>{r.why ? ` - ${r.why}` : ''}</li>)}</ul>}
  </li>
}

function Statement({ item, ai }) {
  const url = item.inline && item.evidence?.[0]?.url
  return <li><Tag item={item} tagged={ai}/> <span>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{item.text}</a> : item.text}</span><Refs item={item}/>{item.resolvedLabel && <small className="ws-muted">{` Addressed by: ${item.resolvedLabel}`}</small>}</li>
}

function SectionItem({ item, ai }) {
  if (item.type === 'recommendation') return <Action item={item}/>
  if (item.type === 'subsystem') return <Subsystem item={item}/>
  if (item.type === 'path') return <li><strong>{item.text}</strong> <Tag item={item}/><Refs item={item}/><p>{item.flow}</p>{item.files?.length > 0 && <p className="ws-code-line"><b>Files:</b> <code>{item.files.join(', ')}</code></p>}{item.symbols?.length > 0 && <p className="ws-code-line"><b>Symbols:</b> <code>{item.symbols.join(', ')}</code></p>}</li>
  if (item.type === 'step') return <Step item={item}/>
  if (item.type === 'status') return <div className="ws-status-row"><dt>{item.label}</dt><dd>{item.text}</dd></div>
  return <Statement item={item} ai={ai}/>
}

// Reports stored before the verification section existed still show their verification block.
function VerificationStatus({ v }) {
  const t = v.tests.discovered
  const rows = [
    ['Tests discovered', t.fileCount || t.scripts.length ? `${t.fileCount} file(s)${t.frameworks.length ? ` (${t.frameworks.join(', ')})` : ''}${t.scripts.length ? `; scripts: ${t.scripts.map(x => x.name).join(', ')}` : ''}` : 'None found in the analyzed files'],
    ['Tests executed', v.tests.executed.detail], ['Runtime behaviour', v.runtime.detail], ['Requirements', v.requirements.detail], ['Work tracking', v.workTracking.detail], ['Completion', v.completion.detail],
  ]
  return <dl className="ws-verification" aria-label="Verification status">{rows.map(([k, text]) => <div key={k}><dt>{k}</dt><dd>{text}</dd></div>)}</dl>
}

function SourceIndex({ sources, onOpenDocument }) {
  return <ol className="ws-source-index">{sources.map(source => <li key={source.id} id={`src-${source.n}`} value={source.n}><Source source={source} onOpenDocument={onOpenDocument}/></li>)}</ol>
}

function ReportSection({ section }) {
  const ai = section.origin === 'ai'
  const body = section.items.some(i => i.type === 'status')
    ? <dl className="ws-verification" aria-label="Verification status">{section.items.map((item, i) => <SectionItem key={i} item={item} ai={ai}/>)}</dl>
    : section.items.some(i => i.type === 'step') ? <ol className="ws-steps ws-onboarding">{section.items.map((item, i) => <SectionItem key={i} item={item} ai={ai}/>)}</ol>
    : <ul className={`ws-report-items${section.items.some(i => i.type === 'subsystem') ? ' ws-walkthrough' : ''}`}>{section.items.map((item, i) => <SectionItem key={i} item={item} ai={ai}/>)}</ul>
  const Title = section.group ? 'h4' : 'h3'
  return <section aria-labelledby={`report-${section.key}`}>
    <Title id={`report-${section.key}`}>{section.title}</Title>
    {section.intro && <p className="ws-muted ws-intro">{section.intro}</p>}
    {body}
  </section>
}

// Presentational: renders the stored report exactly as generated; the PDF is rendered from the same structure.
export function HandoffReportBody({ report, onOpenDocument }) {
  if (!report.brief) return <LegacyReportBody report={report} onOpenDocument={onOpenDocument}/>
  const { brief, verification: v } = report
  return <div className="ws-report ws-brief-report">
    <p className="ws-muted">{`Generated ${when(report.generatedAt)}${report.complexity ? ` · ${report.complexity} codebase` : ''}`}</p>
    <div className="ws-report-repos">{report.repositories.map(repo => <div key={repo.fullName}><strong>{repo.fullName}</strong><span className="ws-muted">{`${repo.branch} @ ${repo.commitSha.slice(0, 7)} · analysis ${repo.status}: ${repo.coverage.analyzed} of ${repo.coverage.eligible} files (${repo.coverage.percent}%)${v?.coverage?.find(c => c.repository === repo.fullName)?.gaps?.length ? ` · not analyzed: ${v.coverage.find(c => c.repository === repo.fullName).gaps.join(', ')}` : ''}`}</span></div>)}</div>
    <section aria-labelledby="brief-summary" className="ws-brief"><h3 id="brief-summary">Executive summary</h3><p>{brief.summary}</p>
      {(brief.currentState.length > 0 || brief.status?.length > 0) && <><h4>Current verified state</h4>
        {brief.currentState.length > 0 && <ul className="ws-report-items">{brief.currentState.map((item, i) => <Statement key={i} item={item} ai/>)}</ul>}
        {brief.status?.length > 0 && <dl className="ws-verification">{brief.status.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl>}</>}
      {brief.doFirst.length > 0 && <><h4>Do first</h4><ol className="ws-actions">{brief.doFirst.map((item, i) => <Action key={i} item={item}/>)}</ol></>}
      {brief.findings?.text && <p className="ws-detail ws-findings"><b className="ws-alert-text">Needs attention:</b> {brief.findings.text}</p>}
      {brief.attention?.length > 0 && <><h4>Needs attention</h4><ul className="ws-report-items">{brief.attention.map((item, i) => <li key={i}><Tag item={item}/> <span>{item.text}</span><Refs item={item}/></li>)}</ul></>}
    </section>
    {report.sections.map((section, i) => <div key={section.key}>
      {section.group && section.group !== report.sections[i - 1]?.group && <h3 className="ws-group">{section.group}</h3>}
      <ReportSection section={section}/>
    </div>)}
    {v && !report.sections.some(s => s.key === 'verification') && v.tests && v.runtime && <section aria-labelledby="report-verification"><h3 id="report-verification">Verification status</h3><VerificationStatus v={v}/></section>}
    {report.sourceIndex?.length > 0 && <section aria-labelledby="report-sources"><h3 id="report-sources">Sources</h3><SourceIndex sources={report.sourceIndex} onOpenDocument={onOpenDocument}/></section>}
    {report.limitations.length > 0 && <section aria-labelledby="report-limits"><h3 id="report-limits">Limitations and data quality</h3><ul className="ws-report-items ws-muted">{report.limitations.map(item => <li key={item}>{item}</li>)}</ul></section>}
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
