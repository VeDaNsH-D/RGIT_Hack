import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { request } from '../api/client'
import { draftHandoffWithAi } from '../api/connections'
import { useWorkspace } from './WorkspaceContext'
import { describeDraftError, generateAiHandoff, summarizeContext } from './aiHandoffWorkflow'
import { formatDate } from './utils'
import DeveloperHandoffSection from './DeveloperHandoff'

const stat = (label, value) => <div className="ws-ai-stat" key={label}><span className="ws-muted">{label}</span><strong>{value ?? 'Unavailable'}</strong></div>

// Presentational: every state is a prop so it renders (and tests) without network access.
export function AiProjectContextView({ extra = null, summary, mode, existing, recipients = [], recipientId, onRecipient, busy, error, onGenerate }) {
  const { repositories, sync, openIssues, openPullRequests, lastActivity } = summary
  const label = busy === 'creating' ? 'Creating handoff…' : busy === 'drafting' ? 'Generating draft…' : error && existing ? 'Retry draft' : 'Generate AI Handoff'
  return <section className="ws-panel ws-ai-context" aria-labelledby="ai-project-context">
    <div className="ws-section-heading"><div><h2 id="ai-project-context">AI Project Context</h2><p>Turn repository activity and project knowledge into actionable handoffs.</p></div></div>
    <div className="ws-ai-stats">
      {stat('Connected repositories', repositories)}
      {stat('Synchronization', sync)}
      {stat('Open issues', openIssues)}
      {stat('Open pull requests', openPullRequests)}
      {stat('Last activity', lastActivity ? formatDate(lastActivity) : null)}
    </div>
    {extra}
    {extra && <h3 className="ws-ai-subhead">Ownership handoff</h3>}
    {mode === 'not_owner' && <p className="ws-muted">Only the project owner can start a handoff.</p>}
    {mode === 'in_progress' && <p className="ws-notice" role="status">{'A handoff is already in progress. '}{existing?.id ? <Link to={`/handoffs/${existing.id}`}>Open the handoff →</Link> : null}</p>}
    {mode === 'no_teammates' && <p className="ws-muted">Add a teammate to this project to choose who receives the handoff.</p>}
    {['ready', 'draft_ready'].includes(mode) && <>
      {mode === 'draft_ready' && <p className="ws-notice" role="status">{'A draft is ready for review. '}{existing?.id ? <Link to={`/handoffs/${existing.id}`}>Review the draft →</Link> : null}</p>}
      {!existing && <label>Hand over to<select value={recipientId} onChange={event => onRecipient(event.target.value)} disabled={Boolean(busy)}><option value="" disabled>Choose a teammate</option>{recipients.map(member => <option value={member.userId} key={member.userId}>{`${member.name} · ${member.email}`}</option>)}</select></label>}
      {error && <p className={error.kind === 'unsynced' || error.kind === 'no_data' ? 'ws-notice' : 'ws-error'} role="alert">{error.message}</p>}
      <div className="ws-ai-actions"><button type="button" className="ws-button ws-button-primary" onClick={onGenerate} disabled={Boolean(busy) || (!existing && !recipientId)}>{label}</button><span className="ws-muted">{existing ? 'Uses your open handoff — no duplicate is created.' : 'Creates a draft handoff, then drafts it from your project sources.'}</span></div>
    </>}
  </section>
}

export default function AiProjectContext({ project, userId, connections }) {
  const { reload } = useWorkspace()
  const navigate = useNavigate()
  const [recipientId, setRecipientId] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [createdId, setCreatedId] = useState(null)
  const lock = useRef(false)

  const owner = project.ownerId === userId
  const open = project.handoffs.find(handoff => handoff.isOpen)
  const editable = open && open.fromUserId === userId && ['DRAFT', 'EDITING'].includes(open.state)
  const existing = editable ? open : createdId ? { id: createdId } : open || null
  const recipients = (project.context?.members || []).filter(member => member.userId !== userId)
  const mode = !owner ? 'not_owner' : open && !editable ? 'in_progress' : !existing && !recipients.length ? 'no_teammates' : editable && open.aiDraft ? 'draft_ready' : 'ready'

  async function generate() {
    if (lock.current) return // a second click while a request is running does nothing
    lock.current = true
    setError(null)
    const canReuse = editable ? open : createdId ? { id: createdId } : null
    setBusy(canReuse ? 'drafting' : 'creating')
    try {
      const { handoffId } = await generateAiHandoff({
        existing: canReuse,
        recipientId,
        createHandoff: toUserId => request(`/projects/${project.id}/handoffs`, { method: 'POST', body: { toUserId } }),
        draft: id => { setBusy('drafting'); return draftHandoffWithAi(id) },
        onHandoff: setCreatedId,
      })
      await reload() // so the editor opens with the saved draft
      navigate(`/handoffs/${handoffId}`)
    } catch (failure) {
      const described = describeDraftError(failure)
      if (described.kind === 'conflict') await reload()
      setError(described)
    } finally {
      lock.current = false
      setBusy(null)
    }
  }

  return <AiProjectContextView extra={<DeveloperHandoffSection projectId={project.id} canAct={project.myRole !== 'viewer'}/>} summary={summarizeContext(connections)} mode={mode} existing={existing} recipients={recipients} recipientId={recipientId} onRecipient={setRecipientId} busy={busy} error={error} onGenerate={generate}/>
}
