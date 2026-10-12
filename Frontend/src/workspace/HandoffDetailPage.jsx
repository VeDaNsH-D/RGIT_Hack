import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from './WorkspaceContext'
import { request } from '../api/client'
import { draftHandoffWithAi } from '../api/connections'
import { AiDraftPanel } from './AiDraftPanel'
import { Badge, EmptyState, PageHeading } from './ui'
import { memberName } from './utils'

function HandoffEditor({ handoff, project }) {
  const { session } = useAuth()
  const { reload } = useWorkspace()
  const [status, setStatus] = useState(handoff.currentStatus || '')
  const [items, setItems] = useState(handoff.items || [])
  const [links, setLinks] = useState((handoff.supportingLinks || []).join('\n'))
  const [noPending, setNoPending] = useState(handoff.noPendingActionsConfirmed)
  const [validation, setValidation] = useState(['DRAFT', 'EDITING'].includes(handoff.state) ? null : handoff.lastValidation)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [note, setNote] = useState('')
  const [draft, setDraft] = useState(handoff.aiDraft || null)
  const outgoing = handoff.fromUserId === session.user.id
  const incoming = handoff.toUserId === session.user.id
  const editable = outgoing && ['DRAFT', 'EDITING'].includes(handoff.state)
  const dirty = status !== handoff.currentStatus || JSON.stringify(items) !== JSON.stringify(handoff.items) || links !== (handoff.supportingLinks || []).join('\n') || noPending !== handoff.noPendingActionsConfirmed

  async function generate() {
    if (busy) return
    setBusy('draft')
    setError('')
    setNotice('')
    try {
      const result = await draftHandoffWithAi(handoff.id)
      setDraft(result.handoff.aiDraft)
      setNotice('Draft ready. Review it, then apply it to this handoff.')
    } catch (err) { setError(err.message) } finally { setBusy('') }
  }

  function applyDraft() {
    if (!draft) return
    if ((status.trim() || items.length) && !window.confirm('Replace the current status and add the draft notes to this handoff? You can still edit everything before saving.')) return
    setStatus(draft.currentStatus)
    setItems([...items, ...draft.items.map(({ type, text, sourceRecordId }) => ({ type, text, sourceRecordId: sourceRecordId || null }))].slice(0, 200))
    setLinks([...new Set([...links.split('\n').map(link => link.trim()).filter(Boolean), ...draft.supportingLinks])].slice(0, 50).join('\n'))
    setValidation(null)
    setNotice('Draft applied. Review and edit it, then save the context.')
  }

  async function action(name) {
    if (busy) return
    setBusy(name)
    setError('')
    setNotice('')
    try {
      if (name === 'save') {
        await request(`/handoffs/${handoff.id}`, { method: 'PATCH', body: { currentStatus: status.trim(), items: items.map(item => ({ ...item, text: item.text.trim() })), supportingLinks: links.split('\n').map(link => link.trim()).filter(Boolean), noPendingActionsConfirmed: noPending } })
        setNotice('Context saved. Review readiness before sending.')
        setValidation(null)
      } else {
        const body = ['clarify', 'respond'].includes(name) ? { note: note.trim() } : {}
        const result = await request(`/handoffs/${handoff.id}/${name}`, { method: 'POST', body })
        if (result.validation) setValidation(result.validation)
        setNotice(name === 'validate' ? result.validation.ready ? 'Everything is ready to hand over.' : 'A few things still need your attention.' : name === 'acknowledge' ? 'Handoff acknowledged. You now own this project.' : name === 'submit' ? 'Handoff sent to your teammate.' : name === 'cancel' ? 'Handoff cancelled.' : 'Your note has been added.')
        setNote('')
      }
      await reload()
    } catch (err) { setError(err.message); if (err.data?.validation) setValidation(err.data.validation) }
    finally { setBusy('') }
  }

  return <>
    <div className="ws-handoff-summary"><Badge value={handoff.state}/><span>{memberName(project, handoff.fromUserId)} <span className="ws-accent">→</span> {memberName(project, handoff.toUserId)}</span><Link to={`/projects/${project.id}`}>View project →</Link></div>
    {editable && <AiDraftPanel draft={draft} busy={busy === 'draft'} disabled={Boolean(busy)} onGenerate={generate} onApply={applyDraft}/>}
    {error && <p className="ws-error" role="alert">{error}</p>}{notice && <p className="ws-notice" role="status">{notice}</p>}
    <div className="ws-handoff-detail-grid"><section className="ws-panel ws-editor">
      <h2>The context that matters</h2><p className="ws-muted">Capture where things stand and what should happen next.</p>
      <label>Current project status<textarea value={status} readOnly={!editable} maxLength={5000} rows={4} placeholder="What’s been done? What’s changing? What does your teammate need to know?" onChange={event => { setStatus(event.target.value); setValidation(null) }}/></label>
      <div className="ws-section-heading"><h3>Handoff notes</h3>{editable && <button className="ws-text-button" disabled={items.length >= 200} onClick={() => { setItems([...items, { type: 'pending', text: '' }]); setValidation(null) }}>+ Add note</button>}</div>
      {items.map((item, index) => <div className="ws-handoff-item" key={index}><select aria-label={`Note ${index + 1} type`} disabled={!editable} value={item.type} onChange={event => { setItems(items.map((value, i) => i === index ? { ...value, type: event.target.value } : value)); setValidation(null) }}>{['completed', 'pending', 'blocker', 'decision', 'deadline', 'dependency', 'risk'].map(type => <option key={type}>{type}</option>)}</select><textarea aria-label={`Note ${index + 1} context`} required readOnly={!editable} value={item.text} maxLength={2000} rows={2} onChange={event => { setItems(items.map((value, i) => i === index ? { ...value, text: event.target.value } : value)); setValidation(null) }}/>{editable && <button aria-label={`Remove note ${index + 1}`} onClick={() => { setItems(items.filter((_, i) => i !== index)); setValidation(null) }}>×</button>}</div>)}
      {!items.length && <p className="ws-muted">No notes added yet.</p>}
      <label className="ws-checkbox-label"><input type="checkbox" disabled={!editable} checked={Boolean(noPending)} onChange={event => { setNoPending(event.target.checked); setValidation(null) }}/>There are no pending actions to hand over.</label>
      <label>Supporting links <span className="ws-muted">(one per line)</span><textarea rows={3} readOnly={!editable} value={links} placeholder="https://…" onChange={event => { setLinks(event.target.value); setValidation(null) }}/></label>
      {editable && <button className="ws-button ws-button-primary" disabled={Boolean(busy) || items.some(item => !item.text.trim()) || !dirty} onClick={() => action('save')}>{busy === 'save' ? 'Saving…' : 'Save context'}</button>}
    </section><aside className="ws-panel ws-readiness"><span className="ws-eyebrow">A CONFIDENT HANDOFF</span><h2>Ready for the next person?</h2><p className="ws-muted">Check the context, task ownership, deadlines, and supporting material before sending.</p>{validation && <><div className="ws-validation-score"><strong>{validation.score}%</strong><span>{validation.ready ? 'Ready to send' : 'Needs attention'}</span></div><ul>{validation.checks?.map(check => <li key={check.name}><span className={check.passed || check.waived ? 'ws-check-pass' : 'ws-check-fail'}>{check.passed || check.waived ? '✓' : '!'}</span><div><strong>{check.name.replaceAll('_', ' ')}</strong><small>{check.reason || (check.waived ? check.waivedReason : '')}</small></div></li>)}</ul></>}
      {editable && <><button className="ws-button" disabled={Boolean(busy) || dirty} onClick={() => action('validate')}>{busy === 'validate' ? 'Checking…' : 'Check readiness'}</button><button className="ws-button ws-button-primary" disabled={Boolean(busy) || dirty || !validation?.ready} onClick={() => action('submit')}>{busy === 'submit' ? 'Sending…' : 'Send handoff →'}</button>{dirty && <p className="ws-muted">Save your context before checking readiness.</p>}</>}
      {incoming && handoff.state === 'SUBMITTED' && <button className="ws-button ws-button-primary" disabled={Boolean(busy)} onClick={() => action('acknowledge')}>{busy === 'acknowledge' ? 'Accepting…' : 'Accept ownership'}</button>}
      {outgoing && handoff.isOpen && <button className="ws-text-button ws-danger" disabled={Boolean(busy)} onClick={() => { if (window.confirm('Cancel this handoff? The project will stay with its current owner.')) action('cancel') }}>Cancel handoff</button>}
    </aside></div>
    {handoff.clarifications?.length > 0 && <section className="ws-panel"><h2>Conversation</h2>{handoff.clarifications.map((entry, index) => <div className="ws-conversation" key={index}><Badge value={entry.type}/><p>{entry.note}</p><small>{memberName(project, entry.author)}</small></div>)}</section>}
    {((incoming && handoff.state === 'SUBMITTED') || (outgoing && handoff.state === 'CLARIFICATION_REQUESTED')) && <section className="ws-panel ws-editor"><h2>{incoming ? 'Need a little more context?' : 'Answer your teammate’s question'}</h2><label>Your note<textarea required maxLength={2000} rows={3} value={note} onChange={event => setNote(event.target.value)}/></label><button className="ws-button ws-button-primary" disabled={Boolean(busy) || !note.trim()} onClick={() => action(incoming ? 'clarify' : 'respond')}>{incoming ? 'Request clarification' : 'Send response'}</button></section>}
  </>
}

export default function HandoffDetailPage() {
  const { handoffId } = useParams()
  const { handoffs, projects } = useWorkspace()
  const handoff = handoffs.find(item => item.id === handoffId)
  const project = projects.find(item => item.id === handoff?.projectId)
  if (!handoff || !project) return <EmptyState title="Handoff not found." description="This handoff may not be available to your account."/>
  return <><Link className="ws-back-link" to="/handoffs">← All handoffs</Link><PageHeading eyebrow="LEAVE NOTHING IMPORTANT BEHIND" title={project.name} description="A clear start for the person taking the work forward."/><HandoffEditor handoff={handoff} project={project} key={`${handoff.id}-${handoff.version}`}/></>
}
