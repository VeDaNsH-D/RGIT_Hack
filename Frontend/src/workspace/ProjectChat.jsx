import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../api/client'
import { analyzeRepository } from '../api/connections'
import { useWorkspace } from './WorkspaceContext'
import './projectChat.css'

const LABELS = { not_analyzed: 'Not analyzed', analyzing: 'Analyzing…', completed: 'Analysis complete', partial: 'Partial analysis', failed: 'Analysis failed' }
const BADGES = { completed: 'ws-badge-completed', partial: 'ws-badge-pending', analyzing: 'ws-badge-pending', failed: 'ws-badge-critical' }

function renderAnswerText(answer, citations = [], turnId, onSelectCitation, highlightedSourceId) {
  if (!answer) return null
  const citationMap = new Map((citations || []).map(c => [c.id, c]))
  const parts = answer.split(/(\[S\d+\])/g)
  return parts.map((part, index) => {
    const match = part.match(/^\[(S\d+)\]$/)
    if (match) {
      const sourceId = match[1]
      const source = citationMap.get(sourceId)
      if (source) {
        const isHighlighted = highlightedSourceId === sourceId
        return (
          <button
            key={index}
            type="button"
            className={`project-chat-citation-pill ${isHighlighted ? 'active' : ''}`}
            title={`View evidence [${sourceId}]: ${source.title}`}
            aria-label={`View evidence [${sourceId}]: ${source.title}`}
            onClick={() => onSelectCitation?.(turnId, sourceId)}
          >
            {`[${sourceId}]`}
          </button>
        )
      }
    }
    return part
  })
}

export function ProjectChatView({
  turns = [],
  knowledgeStatus = [],
  repositories = [],
  analyzingIds = [],
  canAct = false,
  analysisError = '',
  onAnalyze,
  onRefreshKnowledge,
  loading,
  busy,
  statusNotice = '',
  error,
  question,
  onQuestion,
  onSubmit,
  onClear,
  onRetry,
}) {
  const [highlightedSource, setHighlightedSource] = useState(null)
  const [openSources, setOpenSources] = useState({})

  function handleSelectCitation(turnId, sourceId) {
    setOpenSources(prev => ({ ...prev, [turnId]: true }))
    setHighlightedSource({ turnId, sourceId })
    setTimeout(() => {
      if (typeof document !== 'undefined') {
        const el = document.getElementById(`source-${turnId}-${sourceId}`)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
      }
    }, 60)
    setTimeout(() => {
      setHighlightedSource(null)
    }, 3000)
  }

  return <section className="ws-panel project-chat" aria-labelledby="project-chat-title">
    <div className="ws-section-heading"><div><span className="ws-eyebrow">PROJECT KNOWLEDGE</span><h2 id="project-chat-title">Ask your project</h2><p>Answers grounded in your imported sources, documents, and current work.</p></div><button className="ws-text-button" onClick={onClear} disabled={busy || loading || !turns.length}>Clear my chat</button></div>
    {(knowledgeStatus.length > 0 || repositories.length > 0) && <details className="project-chat-knowledge">
      <summary>
        <span>Available project evidence</span>
        {onRefreshKnowledge && <button type="button" className="ws-text-button project-chat-refresh-btn" onClick={e => { e.preventDefault(); e.stopPropagation(); onRefreshKnowledge() }} disabled={analyzingIds.length > 0}>Refresh status</button>}
      </summary>
      {analysisError && <p className="ws-inline-error" role="alert">{analysisError}</p>}
      {repositories.length > 0 && <div className="project-chat-repos">
        {repositories.map(item => {
          const status = analyzingIds.includes(item.connectionId) ? 'analyzing' : item.analysis?.status || 'not_analyzed'
          const snap = item.analysis?.snapshot
          return <div key={item.connectionId} className="project-chat-repo-row">
            <div className="project-chat-repo-head">
              <strong>{item.repository.fullName}</strong>
              <span className={`ws-badge ${BADGES[status] || ''}`}>{LABELS[status] || LABELS.not_analyzed}</span>
              {item.analysis?.freshness?.state === 'stale' && <span className="ws-badge ws-badge-pending">Stale</span>}
              {item.analysis?.freshness?.state === 'current' && <span className="ws-badge">Up to date</span>}
            </div>
            {snap ? <div className="project-chat-repo-meta">
              <span>{`Commit ${snap.commitSha.slice(0, 7)} on ${snap.branch}`}</span>
              <span>{`${snap.coverage?.analyzed ?? 0} of ${snap.coverage?.eligible ?? 0} eligible files (${snap.coverage?.percent ?? 0}%)`}</span>
            </div> : <p className="ws-muted">{status === 'analyzing' ? 'Analyzing repository files…' : 'No usable repository analysis is available. Analyze the repository to make its code, README, and manifests available to chat.'}</p>}
            {item.analysis?.error && <p className="ws-inline-error" role="alert">{item.analysis.error.message}</p>}
            {canAct ? <button type="button" className={`ws-button ${status === 'not_analyzed' ? 'ws-button-primary' : ''}`} disabled={status === 'analyzing'} onClick={() => onAnalyze?.(item.connectionId)}>
              {status === 'analyzing' ? 'Analyzing…' : snap ? (status === 'failed' ? 'Retry analysis' : 'Refresh analysis') : 'Analyze repository'}
            </button> : (status !== 'completed' && <small className="ws-muted">Project viewers cannot trigger analysis. Ask a project member or owner to run analysis.</small>)}
          </div>
        })}
      </div>}
      {knowledgeStatus.length > 0 && <ul>{knowledgeStatus.map((message, index) => <li key={index}>{message}</li>)}</ul>}
    </details>}
    <div className="project-chat-transcript" aria-live="polite" aria-busy={busy || loading}>
      {loading ? <p>Loading your conversation…</p> : !turns.length ? <div className="project-chat-empty"><strong>Your project’s context, one question away.</strong><p>Try “What are the launch blockers?” or “What did we decide about payments?”</p></div> : turns.map(turn => {
        const isDetailsOpen = openSources[turn.id]
        const isTurnHighlighted = highlightedSource?.turnId === turn.id
        return <div className="project-chat-turn" key={turn.id}>
          <div className="project-chat-question"><small>You</small><p>{turn.question}</p></div>
          <div className="project-chat-answer">
            <small>Project assistant</small>
            <p>{renderAnswerText(turn.answer, turn.citations, turn.id, handleSelectCitation, isTurnHighlighted ? highlightedSource.sourceId : null)}</p>
            {turn.citations?.length > 0 && <details open={isDetailsOpen} onToggle={e => { const isOpen = e.currentTarget.open; setOpenSources(prev => ({ ...prev, [turn.id]: isOpen })) }}>
              <summary>Sources ({turn.citations.length})</summary>
              {turn.citations.map(source => {
                const isHighlight = isTurnHighlighted && highlightedSource?.sourceId === source.id
                return <blockquote key={source.id} id={`source-${turn.id}-${source.id}`} className={`project-chat-source-card ${isHighlight ? 'highlighted' : ''}`}>
                  <div className="project-chat-source-header">
                    <strong>[{source.id}] {source.title}</strong>
                    <span className="project-chat-source-provider-badge">{source.provider}</span>
                  </div>
                  <p>{source.text}</p>
                  {source.url && /^https?:\/\//.test(source.url) && <a href={source.url} target="_blank" rel="noopener noreferrer">Open source ↗</a>}
                </blockquote>
              })}
            </details>}
            {turn.limitations?.length > 0 && <small className="project-chat-limitations">{turn.limitations.join(' ')}</small>}
          </div>
        </div>
      })}
      {busy && <p className="project-chat-thinking">{statusNotice || 'Finding relevant context and preparing an answer…'}</p>}
    </div>
    {error && <div className="ws-error" role="alert">{error} <button className="ws-text-button" onClick={onRetry} disabled={busy}>Retry</button></div>}
    <form onSubmit={onSubmit} className="project-chat-form"><label htmlFor="project-chat-question">Ask a question about this project</label><textarea id="project-chat-question" value={question} onChange={event => onQuestion(event.target.value)} maxLength={2000} rows={2} placeholder="What should we focus on next?" disabled={busy || loading}/><div><small>Your conversation is private to your account. Answers don’t change project data.</small><button className="ws-button ws-button-primary" disabled={busy || loading || !question.trim()}>{busy ? 'Answering…' : 'Ask project →'}</button></div></form>
  </section>
}

export default function ProjectChat({ projectId, canAct }) {
  const workspace = useWorkspace?.()
  const projects = workspace?.projects
  const currentProject = projects?.find(p => p.id === projectId)
  const userCanAct = canAct ?? (currentProject ? currentProject.myRole !== 'viewer' : false)
  const [turns, setTurns] = useState([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [question, setQuestion] = useState('')
  const [knowledgeStatus, setKnowledgeStatus] = useState([])
  const [repositories, setRepositories] = useState([])
  const [analyzingIds, setAnalyzingIds] = useState([])
  const [analysisError, setAnalysisError] = useState('')
  const [statusNotice, setStatusNotice] = useState('')
  const pending = useRef(false)
  const path = `/projects/${encodeURIComponent(projectId)}/chat`

  const fetchChat = useCallback(async (signal) => {
    try {
      const data = await request(path, { signal })
      setTurns(data.turns || [])
      setKnowledgeStatus(data.knowledgeStatus || [])
      setRepositories(data.repositories || [])
      setLoading(false)
    } catch (failure) {
      if (failure.name !== 'AbortError') {
        setError(failure.message)
        setLoading(false)
      }
    }
  }, [path])

  useEffect(() => {
    const controller = new AbortController()
    fetchChat(controller.signal)
    return () => controller.abort()
  }, [fetchChat])

  // Follow any remote or background analysis
  const hasAnalyzing = repositories?.some(item => item.analysis?.status === 'analyzing') || analyzingIds.length > 0
  useEffect(() => {
    if (!hasAnalyzing) return undefined
    const timer = setTimeout(() => fetchChat(), 4000)
    return () => clearTimeout(timer)
  }, [hasAnalyzing, fetchChat])

  async function handleAnalyze(connectionId) {
    if (analyzingIds.includes(connectionId)) return
    setAnalyzingIds(ids => [...ids, connectionId])
    setAnalysisError('')
    try {
      await analyzeRepository(projectId, connectionId, false)
      await fetchChat()
    } catch (err) {
      if (err.data?.error !== 'analysis_in_progress') {
        setAnalysisError(err.message || 'Analysis failed.')
      }
      await fetchChat()
    } finally {
      setAnalyzingIds(ids => ids.filter(id => id !== connectionId))
    }
  }

  async function submit(event) {
    event?.preventDefault()
    if (pending.current || !question.trim()) return
    pending.current = true; setBusy(true); setError(''); setStatusNotice('Searching repository knowledge & documents…')
    try {
      const data = await request(path, { method: 'POST', body: { question }, signal: AbortSignal.timeout(60000) })
      setTurns(current => [...current, data.turn])
      setQuestion('')
    }
    catch (failure) { setError(failure.name === 'TimeoutError' ? 'The answer took too long. Please retry.' : failure.message) }
    finally { pending.current = false; setBusy(false); setStatusNotice('') }
  }
  async function clear() {
    setBusy(true); setError('')
    try { await request(path, { method: 'DELETE' }); setTurns([]) } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  async function retry() {
    if (question.trim()) return submit()
    setLoading(true); setError('')
    try { const data = await request(path); setTurns(data.turns) } catch (failure) { setError(failure.message) } finally { setLoading(false) }
  }
  return <ProjectChatView
    knowledgeStatus={knowledgeStatus}
    repositories={repositories}
    analyzingIds={analyzingIds}
    canAct={userCanAct}
    analysisError={analysisError}
    onAnalyze={handleAnalyze}
    onRefreshKnowledge={() => fetchChat()}
    turns={turns}
    loading={loading}
    busy={busy}
    statusNotice={statusNotice}
    error={error}
    question={question}
    onQuestion={setQuestion}
    onSubmit={submit}
    onClear={clear}
    onRetry={retry}
  />
}
