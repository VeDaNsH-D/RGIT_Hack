import { useEffect, useRef, useState } from 'react'
import { request } from '../api/client'
import './projectChat.css'
export function ProjectChatView({ turns = [], loading, busy, error, question, onQuestion, onSubmit, onClear, onRetry }) {
  return <section className="ws-panel project-chat" aria-labelledby="project-chat-title">
    <div className="ws-section-heading"><div><span className="ws-eyebrow">PROJECT KNOWLEDGE</span><h2 id="project-chat-title">Ask your project</h2><p>Answers grounded in your imported sources, documents, and current work.</p></div><button className="ws-text-button" onClick={onClear} disabled={busy || loading || !turns.length}>Clear my chat</button></div>
    <div className="project-chat-transcript" aria-live="polite" aria-busy={busy || loading}>
      {loading ? <p>Loading your conversation…</p> : !turns.length ? <div className="project-chat-empty"><strong>Your project’s context, one question away.</strong><p>Try “What are the launch blockers?” or “What did we decide about payments?”</p></div> : turns.map(turn => <div className="project-chat-turn" key={turn.id}><div className="project-chat-question"><small>You</small><p>{turn.question}</p></div><div className="project-chat-answer"><small>Project assistant</small><p>{turn.answer}</p>{turn.citations?.length > 0 && <details><summary>Sources ({turn.citations.length})</summary>{turn.citations.map(source => <blockquote key={source.id}><strong>[{source.id}] {source.title}</strong><small>{source.provider}</small><p>{source.text}</p>{source.url && /^https?:\/\//.test(source.url) && <a href={source.url} target="_blank" rel="noopener noreferrer">Open source ↗</a>}</blockquote>)}</details>}{turn.limitations?.length > 0 && <small className="project-chat-limitations">{turn.limitations.join(' ')}</small>}</div></div>)}
      {busy && <p className="project-chat-thinking">Finding relevant context and preparing an answer…</p>}
    </div>
    {error && <div className="ws-error" role="alert">{error} <button className="ws-text-button" onClick={onRetry} disabled={busy}>Retry</button></div>}
    <form onSubmit={onSubmit} className="project-chat-form"><label htmlFor="project-chat-question">Ask a question about this project</label><textarea id="project-chat-question" value={question} onChange={event => onQuestion(event.target.value)} maxLength={2000} rows={2} placeholder="What should we focus on next?" disabled={busy || loading}/><div><small>Your conversation is private to your account. Answers don’t change project data.</small><button className="ws-button ws-button-primary" disabled={busy || loading || !question.trim()}>{busy ? 'Answering…' : 'Ask project →'}</button></div></form>
  </section>
}
export default function ProjectChat({ projectId }) {
  const [turns, setTurns] = useState([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [question, setQuestion] = useState('')
  const pending = useRef(false)
  const path = `/projects/${encodeURIComponent(projectId)}/chat`
  useEffect(() => {
    const controller = new AbortController()
    request(path, { signal: controller.signal }).then(data => { setTurns(data.turns); setLoading(false) }).catch(failure => { if (failure.name !== 'AbortError') { setError(failure.message); setLoading(false) } })
    return () => controller.abort()
  }, [path])
  async function submit(event) {
    event?.preventDefault()
    if (pending.current || !question.trim()) return
    pending.current = true; setBusy(true); setError('')
    try { const data = await request(path, { method: 'POST', body: { question }, signal: AbortSignal.timeout(60000) }); setTurns(current => [...current, data.turn]); setQuestion('') }
    catch (failure) { setError(failure.name === 'TimeoutError' ? 'The answer took too long. Please retry.' : failure.message) }
    finally { pending.current = false; setBusy(false) }
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
  return <ProjectChatView turns={turns} loading={loading} busy={busy} error={error} question={question} onQuestion={setQuestion} onSubmit={submit} onClear={clear} onRetry={retry}/>
}
