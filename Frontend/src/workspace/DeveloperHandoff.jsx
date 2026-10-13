import { useEffect, useRef, useState } from 'react'
import { analyzeRepository, downloadHandoffPdf, generateHandoffReport, getHandoffReport, listHandoffReports, listRepositoryKnowledge } from '../api/connections'
import { describeDraftError } from './aiHandoffWorkflow'
import HandoffReportPreview from './HandoffReportPreview'
import { changeSummary, coverageNotes } from './analysisHelpers'

const dateTime = value => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const LABELS = { not_analyzed: 'Not analyzed', analyzing: 'Analyzing…', completed: 'Analysis complete', partial: 'Partial analysis', failed: 'Analysis failed' }
const BADGES = { completed: 'ws-badge-completed', partial: 'ws-badge-pending', analyzing: 'ws-badge-pending', failed: 'ws-badge-critical' }

function RepositoryAnalysisRow({ item, analyzing, canAct, onAnalyze }) {
  const { repository, analysis } = item
  const status = analyzing ? 'analyzing' : analysis.status
  const snap = analysis.snapshot
  const notes = coverageNotes(snap?.coverage)
  return <div className="ws-analysis-row">
    <div className="ws-analysis-head"><strong>{repository.fullName}</strong><span className={`ws-badge ${BADGES[status] || ''}`}>{LABELS[status] || LABELS.not_analyzed}</span>{analysis.freshness?.state === 'stale' && <span className="ws-badge ws-badge-pending">Stale</span>}{analysis.freshness?.state === 'current' && <span className="ws-badge">Up to date</span>}</div>
    {snap ? <div className="ws-analysis-meta">
      <span>{`Commit ${snap.commitSha.slice(0, 7)} on ${snap.branch}`}</span>
      <span>{`${snap.coverage.analyzed} of ${snap.coverage.eligible} eligible files (${snap.coverage.percent}%)`}</span>
      <span>{`Analyzed ${dateTime(snap.analyzedAt)}`}</span>
      {snap.mode === 'incremental' && <span>{`Since last analysis: ${changeSummary(snap.changes)}`}</span>}
    </div> : <p className="ws-muted">{status === 'analyzing' ? 'Reading the repository…' : 'Not analyzed yet. Analysis reads the repository’s files so handoffs can explain its architecture.'}</p>}
    {notes.length > 0 && <ul className="ws-analysis-notes">{notes.map(note => <li key={note}>{note}</li>)}</ul>}
    {snap && snap.status === 'partial' && <p className="ws-muted">{`Not every file was analyzed, so the knowledge base is incomplete. ${analysis.retryable ? `${analysis.retryable} file(s) can be retried; Refresh will fetch only those and anything that changed.` : 'Refresh re-checks only changed files; files over the size limit, binary files and files containing credentials are not retried.'}`}</p>}
    {analysis.freshness?.state === 'stale' && <p className="ws-muted">{analysis.freshness.reasons.join(' ')}</p>}
    {analysis.status === 'failed' && analysis.error && <p className="ws-inline-error" role="alert">{analysis.error.message}{snap ? ' The previous analysis is still available.' : ''}</p>}
    {canAct && <button type="button" className="ws-button" onClick={onAnalyze} disabled={status === 'analyzing'}>{status === 'analyzing' ? 'Analyzing…' : snap ? 'Refresh analysis' : 'Analyze repository'}</button>}
  </div>
}

// Presentational: every state is a prop so it renders (and tests) without network access.
export function DeveloperHandoffView({ state, repositories = [], analyzingIds = [], canAct, lastReport, busy, error, notice, onAnalyze, onGenerate, reused, onRegenerate, onPreview, onDownload, downloading, onRetry }) {
  const analyzed = repositories.filter(item => item.analysis.snapshot)
  const stale = analyzed.some(item => item.analysis.freshness?.state === 'stale')
  const partial = analyzed.some(item => item.analysis.snapshot.status === 'partial')
  return <div className="ws-dev-handoff" aria-labelledby="dev-handoff-title">
    <div className="ws-section-heading"><div><h3 id="dev-handoff-title">Repository analysis and developer handoff</h3><p>Relay reads your repository first, then writes a handoff that combines its architecture with current activity.</p></div></div>
    {state === 'loading' && <div className="ws-skeleton ws-skeleton-list" role="status" aria-label="Loading repository analysis"/>}
    {state === 'error' && <div className="ws-integration-body"><p className="ws-error" role="alert">{error}</p><button type="button" className="ws-button" onClick={onRetry}>Try again</button></div>}
    {state === 'ready' && !repositories.length && <p className="ws-muted">Connect a GitHub repository to build repository knowledge for developer handoffs.</p>}
    {state === 'ready' && repositories.map(item => <RepositoryAnalysisRow key={item.connectionId} item={item} analyzing={analyzingIds.includes(item.connectionId)} canAct={canAct} onAnalyze={() => onAnalyze(item)}/>)}
    {state === 'ready' && repositories.length > 0 && <>
      {stale && <p className="ws-notice" role="status">The repository changed since it was analyzed. Refresh the analysis for the most accurate handoff.</p>}
      {partial && <p className="ws-notice" role="status">The analysis is partial. The handoff will say which parts of the repository were not analyzed.</p>}
      {error && <p className={error.includes('Analyze') ? 'ws-notice' : 'ws-error'} role="alert">{error}</p>}
      {notice && <p className="ws-notice" role="status">{notice}{reused && canAct && <> <button type="button" className="ws-text-button" onClick={onRegenerate} disabled={Boolean(busy)}>Regenerate anyway</button></>}</p>}
      <div className="ws-ai-actions">
        {canAct && <button type="button" className="ws-button ws-button-primary" onClick={onGenerate} disabled={!analyzed.length || Boolean(busy) || analyzingIds.length > 0}>{busy === 'generating' ? 'Generating handoff…' : 'Generate Handoff'}</button>}
        {lastReport && <><button type="button" className="ws-button" onClick={onPreview} disabled={Boolean(busy)}>Preview Handoff</button><button type="button" className="ws-button" onClick={onDownload} disabled={downloading}>{downloading ? 'Preparing PDF…' : 'Download PDF'}</button></>}
        {!analyzed.length && <span className="ws-muted">Analyze a repository first.</span>}
        {lastReport && <span className="ws-muted">{`Last handoff generated ${dateTime(lastReport.generatedAt)}`}</span>}
      </div>
    </>}
  </div>
}

export default function DeveloperHandoffSection({ projectId, canAct }) {
  const [tick, setTick] = useState(0)
  const [result, setResult] = useState(null)
  const [reports, setReports] = useState(null)
  const [analyzingIds, setAnalyzingIds] = useState([])
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reused, setReused] = useState(false)
  const [preview, setPreview] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const lock = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([listRepositoryKnowledge(projectId, controller.signal), listHandoffReports(projectId, controller.signal)])
      .then(([knowledge, list]) => { setResult({ projectId, repositories: knowledge.repositories }); setReports(list.reports) })
      .catch(failure => { if (failure.name !== 'AbortError') setResult(previous => ({ projectId, repositories: previous?.projectId === projectId ? previous.repositories : null, error: failure.message })) })
    return () => controller.abort()
  }, [projectId, tick])

  const repositories = result?.projectId === projectId ? result.repositories : null
  const state = !result || result.projectId !== projectId ? 'loading' : result.error && !repositories ? 'error' : 'ready'

  // An analysis running elsewhere is followed until it finishes.
  const remote = repositories?.some(item => item.analysis.status === 'analyzing') && analyzingIds.length === 0
  useEffect(() => {
    if (!remote) return undefined
    const timer = setTimeout(() => setTick(count => count + 1), 4000)
    return () => clearTimeout(timer)
  }, [remote, tick])

  async function analyze(item) {
    if (analyzingIds.includes(item.connectionId)) return
    setAnalyzingIds(ids => [...ids, item.connectionId])
    setError('')
    setNotice('')
    try {
      // Never force from the UI: the server decides what is new, changed or retryable and skips everything else.
      const result = await analyzeRepository(projectId, item.connectionId, false)
      if (result?.analysis?.upToDate) setNotice(`${item.repository.fullName} has no new commits${result.analysis.retryable ? '' : ' and nothing left that could be retried'}, so nothing was re-analyzed.`)
    } catch (failure) {
      if (failure.data?.error !== 'analysis_in_progress') setError(failure.message)
    } finally {
      setAnalyzingIds(ids => ids.filter(id => id !== item.connectionId))
      setTick(count => count + 1)
    }
  }

  async function generate(force = false) {
    if (lock.current) return
    lock.current = true
    setBusy('generating')
    setError('')
    setNotice('')
    try {
      const { report, reused } = await generateHandoffReport(projectId, force)
      setPreview(report)
      setReused(Boolean(reused))
      setNotice(reused ? 'Nothing has changed since the last handoff, so it was reused and no AI call was made.' : 'Handoff generated. Review it, then download the PDF.')
      setTick(count => count + 1)
    } catch (failure) {
      setError(failure.data?.error === 'analysis_required' ? 'Analyze a connected repository first.' : describeDraftError(failure).message)
    } finally {
      lock.current = false
      setBusy(null)
    }
  }

  async function open() {
    if (!reports?.length) return
    setPreviewError('')
    try { setPreview((await getHandoffReport(projectId, reports[0].id)).report) } catch (failure) { setError(failure.message) }
  }

  async function download(report) {
    setDownloading(true)
    setPreviewError('')
    try { await downloadHandoffPdf(projectId, report.id) } catch (failure) { setPreviewError(failure.message); setError(failure.message) } finally { setDownloading(false) }
  }

  const lastReport = reports?.[0] || null
  return <>
    <DeveloperHandoffView state={state} repositories={repositories || []} analyzingIds={analyzingIds} canAct={canAct} lastReport={lastReport} busy={busy} error={state === 'error' ? result.error : error} notice={notice} onAnalyze={analyze} onGenerate={() => generate(false)} reused={reused} onRegenerate={() => generate(true)} onPreview={open} onDownload={() => lastReport && download(lastReport)} downloading={downloading} onRetry={() => { setResult(null); setTick(count => count + 1) }}/>
    {preview && <HandoffReportPreview report={preview} onClose={() => setPreview(null)} onDownload={() => download(preview)} downloading={downloading} error={previewError}/>}
  </>
}
