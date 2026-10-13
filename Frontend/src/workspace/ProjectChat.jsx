import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../api/client'
import { analyzeRepository } from '../api/connections'
import { useWorkspace } from './WorkspaceContext'
import './projectChat.css'

const LABELS = { not_analyzed: 'Not analyzed', analyzing: 'Analyzing…', completed: 'Analysis complete', partial: 'Partial analysis', failed: 'Analysis failed' }
const BADGES = { completed: 'ws-badge-completed', partial: 'ws-badge-pending', analyzing: 'ws-badge-pending', failed: 'ws-badge-critical' }

const SUGGESTIONS = [
  ['✦', 'Summarize this project'],
  ['⚑', 'What are the launch blockers?'],
  ['◇', 'What did we decide recently?'],
  ['⌘', 'What is the tech stack?'],
  ['☰', 'What is open and who owns it?'],
  ['→', 'What should we focus on next?'],
]

function renderInline(text, citationMap, turnId, onSelectCitation, highlightedSourceId, keyPrefix) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[S\d+\])/g).map((part, index) => {
    if (!part) return null
    const key = `${keyPrefix}-${index}`
    const cite = part.match(/^\[(S\d+)\]$/)
    if (cite) {
      const sourceId = cite[1]
      const source = citationMap.get(sourceId)
      if (source) {
        return <button key={key} type="button" className={`project-chat-citation-pill ${highlightedSourceId === sourceId ? 'active' : ''}`} title={`View evidence [${sourceId}]: ${source.title}`} aria-label={`View evidence [${sourceId}]: ${source.title}`} onClick={() => onSelectCitation?.(turnId, sourceId)}>{`[${sourceId}]`}</button>
      }
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={key}>{renderInline(part.slice(2, -2), citationMap, turnId, onSelectCitation, highlightedSourceId, key)}</strong>
    if (/^`[^`]+`$/.test(part)) return <code key={key}>{part.slice(1, -1)}</code>
    return part
  })
}

// Renders the assistant's light markdown (paragraphs, lists, headings, bold, code) plus [S#] citation pills.
function renderAnswerText(answer, citations = [], turnId, onSelectCitation, highlightedSourceId) {
  if (!answer) return null
  const citationMap = new Map((citations || []).map(c => [c.id, c]))
  const inline = (text, key) => renderInline(text, citationMap, turnId, onSelectCitation, highlightedSourceId, key)
  const blocks = []
  let list = null
  let paragraph = []
  const flushParagraph = () => { if (paragraph.length) { blocks.push({ type: 'p', text: paragraph.join(' ') }); paragraph = [] } }
  const flushList = () => { if (list) { blocks.push(list); list = null } }
  for (const raw of answer.replace(/\r/g, '').split('\n')) {
    const line = raw.trim()
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    const bullet = line.match(/^[-*•]\s+(.*)$/)
    const numbered = line.match(/^\d+[.)]\s+(.*)$/)
    if (!line) { flushParagraph(); flushList(); continue }
    if (heading) { flushParagraph(); flushList(); blocks.push({ type: 'h', text: heading[1] }); continue }
    if (bullet || numbered) {
      flushParagraph()
      const type = bullet ? 'ul' : 'ol'
      if (list?.type !== type) { flushList(); list = { type, items: [] } }
      list.items.push((bullet || numbered)[1])
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph(); flushList()
  return blocks.map((block, index) => {
    if (block.type === 'h') return <h4 key={index}>{inline(block.text, `h${index}`)}</h4>
    if (block.type === 'ul') return <ul key={index}>{block.items.map((item, i) => <li key={i}>{inline(item, `u${index}-${i}`)}</li>)}</ul>
    if (block.type === 'ol') return <ol key={index}>{block.items.map((item, i) => <li key={i}>{inline(item, `o${index}-${i}`)}</li>)}</ol>
    return <p key={index}>{inline(block.text, `p${index}`)}</p>
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
  const transcriptRef = useRef(null)
  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = turns.length || busy ? el.scrollHeight : 0
  }, [turns.length, busy, loading])
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
    <div className="ws-section-heading"><div><span className="ws-eyebrow">PROJECT KNOWLEDGE</span><h2 id="project-chat-title">Ask your project</h2><p>Answers grounded in your imported sources, documents, and current work.</p></div><div className="project-chat-head-actions">
    {(knowledgeStatus.length > 0 || repositories.length > 0) && <details className="project-chat-knowledge">
      <summary>
        <span>Available project evidence</span>
        {onRefreshKnowledge && <button type="button" className="ws-text-button project-chat-refresh-btn" onClick={e => { e.preventDefault(); e.stopPropagation(); onRefreshKnowledge() }} disabled={analyzingIds.length > 0}>Refresh status</button>}
      </summary>
      <div className="project-chat-knowledge-body">
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
    </div>
    </details>}
    <button className="ws-text-button" onClick={onClear} disabled={busy || loading || !turns.length}>Clear my chat</button></div></div>
    <div className="project-chat-transcript" ref={transcriptRef} aria-live="polite" aria-busy={busy || loading}>
      {loading ? <p>Loading your conversation…</p> : !turns.length ? <div className="project-chat-empty">
        <span className="project-chat-empty-mark" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 19 19 5M10 5h9v9"/></svg></span>
        <h3>What would you like to know?</h3>
        <p>Ask about decisions, blockers, tasks, or code. Every answer is backed by your project’s own sources.</p>
        <div className="project-chat-suggestions">
          {SUGGESTIONS.map(([icon, label]) => <button type="button" key={label} onClick={() => { onQuestion(label); document.getElementById('project-chat-question')?.focus() }}><span aria-hidden="true">{icon}</span>{label}</button>)}
        </div>
      </div> : turns.map(turn => {
        const isDetailsOpen = openSources[turn.id]
        const isTurnHighlighted = highlightedSource?.turnId === turn.id
        return <div className="project-chat-turn" key={turn.id}>
          <div className="project-chat-question"><small>You</small><p>{turn.question}</p></div>
          <div className="project-chat-answer">
            <small>Project assistant</small>
            <div className="project-chat-md">{renderAnswerText(turn.answer, turn.citations, turn.id, handleSelectCitation, isTurnHighlighted ? highlightedSource.sourceId : null)}</div>
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
      {busy && <p className="project-chat-thinking"><span className="project-chat-dots"><i/><i/><i/></span>{statusNotice || 'Finding relevant context and preparing an answer…'}</p>}
    </div>
    {error && <div className="ws-error" role="alert">{error} <button className="ws-text-button" onClick={onRetry} disabled={busy}>Retry</button></div>}
    <form onSubmit={onSubmit} className="project-chat-form">
      <label className="project-chat-sr" htmlFor="project-chat-question">Ask a question about this project</label>
      <div className="project-chat-composer">
        <textarea id="project-chat-question" value={question} onChange={event => onQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy && !loading && question.trim()) onSubmit(event) } }} maxLength={2000} rows={1} placeholder="Ask anything about this project…" disabled={busy || loading}/>
        <button className="project-chat-send" aria-label={busy ? 'Answering…' : 'Send question'} disabled={busy || loading || !question.trim()}>{busy ? <span className="project-chat-spinner"/> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>}</button>
      </div>
      <small>Your conversation is private to your account. Answers don’t change project data.</small>
    </form>
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
