import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ownershipHistory } from '../api/teams'
import { Badge } from './ui'
import { formatDate, memberName } from './utils'
import { STATE_LABEL, TRANSFER_LABEL } from './handoffLabels'
import './handoffTransfer.css'

/** Who is handing the work to whom: sending team + owner on one side, receiving team + named recipient on the other. */
export function TransferSummary({ handoff, project, fromTeam, toTeam }) {
  const type = handoff.transferType || 'individual'
  return <section className="ws-panel wt-transfer">
    <div className="wt-transfer-head"><span className={`wt-type-chip ${type}`}>{TRANSFER_LABEL[type]}</span><Badge value={handoff.state}/></div>
    <div className="wt-transfer-flow">
      <div><small>From</small><strong>{fromTeam?.name || 'No team assigned'}</strong><span>{memberName(project, handoff.fromUserId)} · current owner</span></div>
      <span className="wt-transfer-arrow" aria-hidden="true">→</span>
      <div><small>To</small><strong>{toTeam?.name || 'Individual recipient'}</strong><span>{memberName(project, handoff.toUserId)} · proposed owner</span></div>
    </div>
    {handoff.reason && <div className="wt-transfer-reason"><small>Reason for transfer</small><p>{handoff.reason}</p></div>}
    {handoff.instructions && <div className="wt-transfer-reason"><small>Additional instructions</small><p>{handoff.instructions}</p></div>}
    {handoff.state === 'REJECTED' && <div className="wt-transfer-reason rejected"><small>Rejected{handoff.rejectedAt ? ` · ${formatDate(handoff.rejectedAt)}` : ''}</small><p>{handoff.rejectionReason}</p></div>}
    {['DRAFT', 'EDITING', 'SUBMITTED'].includes(handoff.state) && <p className="ws-muted wt-transfer-note">Ownership stays with {memberName(project, handoff.fromUserId)} until the recipient accepts.</p>}
  </section>
}

/** The immutable context captured at submission. User-entered facts and AI-generated material are labelled separately. */
export function ContextSnapshotPanel({ snapshot, stale, project }) {
  if (!snapshot) return null
  const items = snapshot.items || []
  const tasks = snapshot.openTasks || []
  const docs = snapshot.documents || []
  const conflicts = snapshot.openConflicts || []
  return <section className="ws-panel wt-snapshot">
    <div className="ws-section-heading"><div><h2>Context submitted for review</h2><p className="ws-muted">Captured {formatDate(snapshot.capturedAt)} · version <code>{String(snapshot.hash || '').slice(0, 10)}</code></p></div></div>
    {stale && <p className="ws-warning" role="status">Project data has changed since this was submitted. Review the live project before accepting.</p>}
    <div className="wt-snapshot-grid">
      <div><small>Entered by sender</small>
        <p>{snapshot.currentStatus || 'No status written.'}</p>
        {items.length > 0 && <ul>{items.map((item, index) => <li key={index}><Badge value={item.type}/> {item.text}</li>)}</ul>}
      </div>
      <div><small>Open tasks ({tasks.length})</small>
        {tasks.length ? <ul>{tasks.slice(0, 8).map(task => <li key={task.id}>{task.title}<span className="ws-muted"> · {task.priority}{task.assignee ? ` · ${memberName(project, task.assignee)}` : ' · unassigned'}{task.deadline ? ` · due ${formatDate(task.deadline)}` : ''}</span></li>)}</ul> : <p className="ws-muted">None at submission.</p>}
        <small>Documents ({docs.length})</small>
        {docs.length ? <ul>{docs.map(doc => <li key={doc.id}>{doc.title}</li>)}</ul> : <p className="ws-muted">No documents attached.</p>}
      </div>
      <div><small>Potential conflicts ({conflicts.length})</small>
        {conflicts.length ? <ul>{conflicts.map(conflict => <li key={conflict.id}><Badge value={conflict.severity}/> {conflict.title}</li>)}</ul> : <p className="ws-muted">No open conflicts.</p>}
        <small>AI-generated</small>
        <p className="ws-muted">{snapshot.aiGenerated ? `An AI draft (${snapshot.aiGenerated.generatedAt ? formatDate(snapshot.aiGenerated.generatedAt) : 'undated'}) was available to the sender. It is a suggestion; the sender reviewed what was kept.` : 'No AI draft was used.'}</p>
        {snapshot.readiness && <p className="ws-muted">Readiness at submission: <strong>{snapshot.readiness.score}%</strong>{snapshot.readiness.missingFields?.length ? ` · missing: ${snapshot.readiness.missingFields.join(', ').replaceAll('_', ' ')}` : ''}</p>}
      </div>
    </div>
  </section>
}

export function OwnershipTimelineView({ data, loading, error }) {
  if (loading) return <section className="ws-panel"><p className="ws-muted">Loading ownership timeline…</p></section>
  if (error) return <section className="ws-panel"><p className="ws-error" role="alert">{error}</p></section>
  const transfers = data?.ownershipHistory || []
  const place = side => [side.team?.name, side.user?.name || side.name].filter(Boolean).join(' / ')
  return <section className="ws-panel wt-timeline">
    <div className="ws-section-heading"><div><h2>Ownership timeline</h2><p className="ws-muted">Currently with <strong>{data?.current?.team ? `${data.current.team.name} / ` : ''}{data?.current?.owner?.name || 'unknown'}</strong></p></div></div>
    {transfers.length ? <ol>{transfers.map(entry => <li key={`${entry.handoffId}-${entry.changedAt}`}>
      <span className="wt-timeline-dot" aria-hidden="true"/>
      <div>
        <strong>{place({ team: entry.fromTeam, user: entry.fromUser })} <span className="ws-accent">→</span> {place({ team: entry.toTeam, user: entry.toUser })}</strong>
        <small>{formatDate(entry.changedAt)} · initiated by {entry.initiatedBy?.name}, accepted by {entry.acceptedBy?.name}</small>
        {entry.reason && <p>“{entry.reason}”</p>}
        <Link to={`/handoffs/${entry.handoffId}`}>View handoff →</Link>
      </div>
    </li>)}</ol> : <p className="ws-panel-empty">Ownership hasn’t been transferred yet.</p>}
  </section>
}

export function OwnershipTimeline({ projectId, refreshKey }) {
  const [state, setState] = useState({ data: null, loading: true, error: '' })
  useEffect(() => {
    const controller = new AbortController()
    ownershipHistory(projectId, controller.signal)
      .then(data => { if (!controller.signal.aborted) setState({ data, loading: false, error: '' }) })
      .catch(err => { if (!controller.signal.aborted && err.name !== 'AbortError') setState({ data: null, loading: false, error: err.message }) })
    return () => controller.abort()
  }, [projectId, refreshKey])
  return <OwnershipTimelineView {...state}/>
}

/** Incoming / outgoing handoff lists with state filters. Pure: callers pass the current user and the handoffs. */
export function HandoffInboxView({ handoffs, projects, userId, direction, stateFilter }) {
  const mine = handoffs.filter(handoff => direction === 'incoming' ? handoff.toUserId === userId : handoff.fromUserId === userId)
  const rows = mine.filter(handoff => stateFilter === 'all' || (stateFilter === 'open' ? handoff.state === 'SUBMITTED' : stateFilter === 'changes' ? handoff.state === 'CLARIFICATION_REQUESTED' : stateFilter === 'accepted' ? handoff.state === 'ACKNOWLEDGED' : handoff.state === 'REJECTED'))
  if (!rows.length) return <div className="ws-panel ws-panel-empty">{direction === 'incoming' ? 'Nothing is waiting for you.' : 'You haven’t sent any handoffs in this view.'}</div>
  return <div className="wt-inbox">{rows.map(handoff => {
    const project = projects.find(item => item.id === handoff.projectId)
    const latest = [...(handoff.clarifications || [])].pop()
    return <Link className="wt-inbox-row" key={handoff.id} to={`/handoffs/${handoff.id}`}>
      <div><strong>{project?.name || 'Project'}</strong><small>{TRANSFER_LABEL[handoff.transferType || 'individual']}</small></div>
      <div><small>{direction === 'incoming' ? 'From' : 'To'}</small><span>{memberName(project, direction === 'incoming' ? handoff.fromUserId : handoff.toUserId)}</span></div>
      <div><small>Submitted</small><span>{handoff.submittedAt ? formatDate(handoff.submittedAt) : 'Not sent'}</span></div>
      <div><small>Latest response</small><span>{handoff.state === 'REJECTED' ? handoff.rejectionReason : latest ? latest.note : '—'}</span></div>
      <Badge value={handoff.state}/>
      <span className="wt-inbox-status">{STATE_LABEL[handoff.state] || handoff.state}</span>
    </Link>
  })}</div>
}
