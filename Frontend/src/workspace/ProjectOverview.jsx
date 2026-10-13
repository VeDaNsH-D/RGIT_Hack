import AppIcon from '../components/AppIcon'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Icon } from './ui'
import { formatDate } from './utils'
import { request } from '../api/client'
import { listProjectConflicts } from '../api/conflicts'
import { listProjectDocuments } from '../api/documents'
import { useWorkspace } from './WorkspaceContext'
import './projectOverview.css'

const priorityRank = { critical: 4, high: 3, medium: 2, low: 1 }
function Sparkline({ nodes, actions, color, now }) {
  const days = Array(7).fill(0)
  for (const node of nodes) {
    const age = Math.floor((now - new Date(node.occurredAt)) / 86400000)
    if (age >= 0 && age < 7 && actions.includes(node.action)) days[6 - age]++
  }
  const max = Math.max(1, ...days)
  const points = days.map((value, index) => `${index * 20},${38 - value / max * 30}`).join(' ')
  return <svg viewBox="0 0 120 44" className="pd-sparkline" aria-label={`${days.reduce((sum, value) => sum + value, 0)} recorded events in the past seven days`} role="img"><polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/></svg>
}
function PanelHeading({ icon, title, action, onAction, children }) {
  return <div className="pd-panel-heading"><span className="pd-heading-icon"><Icon name={icon} size={18}/></span><h2>{title}</h2>{action && <button className="ws-text-button" onClick={onAction}>{action} <span aria-hidden="true">→</span></button>}{children}</div>
}
export default function ProjectOverview({ project, writable, onSection, onTask, integrations, sourcesError }) {
  const { reload } = useWorkspace()
  const [result, setResult] = useState(null), [busy, setBusy] = useState(null), [mutationError, setMutationError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    Promise.allSettled([
      request(`/projects/${project.id}/work-tree?limit=100`, { signal: controller.signal }),
      listProjectConflicts(project.id, { signal: controller.signal }),
      listProjectDocuments(project.id, controller.signal),
    ]).then(([activity, conflicts, documents]) => {
      if (controller.signal.aborted) return
      setResult({ projectId: project.id, observedAt: Date.now(),
        nodes: activity.status === 'fulfilled' ? activity.value.nodes || [] : null,
        conflicts: conflicts.status === 'fulfilled' ? conflicts.value.conflicts || [] : null,
        documents: documents.status === 'fulfilled' ? documents.value.documents || [] : null,
      })
    })
    return () => controller.abort()
  }, [project.id, project.tasks, project.handoffs])
  const data = result?.projectId === project.id ? result : null
  const open = project.tasks.filter(task => task.status === 'open')
  const completed = project.tasks.filter(task => task.status === 'completed')
  const handoff = project.handoffs.find(item => item.isOpen)
  const tasks = [...open].sort((a, b) => {
    const overdue = item => item.deadline && new Date(item.deadline) < new Date() ? 1 : 0
    return overdue(b) - overdue(a) || (priorityRank[b.priority] || 0) - (priorityRank[a.priority] || 0)
  }).slice(0, 5)
  const deadlines = [...open].filter(task => task.deadline).sort((a, b) => new Date(a.deadline) - new Date(b.deadline)).slice(0, 4)
  const validation = handoff?.lastValidation
  const score = typeof validation?.score === 'number' ? Math.max(0, Math.min(100, validation.score)) : null
  const blockers = data?.conflicts?.filter(conflict => !['resolved', 'dismissed'].includes(conflict.status))
  const sourceCards = [{ id: 'slack', title: 'Slack' }, { id: 'notion', title: 'Notion' }, { id: 'github', title: 'GitHub' }, { id: 'jira', title: 'Jira' }, { id: 'documents', title: 'Documents', icon: 'tasks' }]
  const stats = [
    { title: 'Open tasks', value: open.length, icon: 'tasks', color: '#ff5425', actions: ['TASK_CREATED'], section: 'team' },
    { title: 'Completed tasks', value: completed.length, icon: 'check', color: '#20b875', actions: ['TASK_UPDATED'], section: 'team' },
    { title: 'Active handoffs', value: project.handoffs.filter(item => item.isOpen).length, icon: 'handoffs', color: '#ff5425', actions: ['HANDOFF_CREATED', 'HANDOFF_SUBMITTED'], section: 'handoff' },
    { title: 'Team members', value: project.context.members.length, icon: 'users', color: '#a459eb', actions: ['INVITATION_ACCEPTED', 'MEMBER_ADDED'], section: 'team' },
  ]
  async function completeTask(task) {
    setBusy(task.id); setMutationError('')
    try { await request(`/tasks/${task.id}`, { method: 'PATCH', body: { status: 'completed' } }); await reload() }
    catch (error) { setMutationError(error.message) } finally { setBusy(null) }
  }
  return <div className="pd-overview">
    <div className="pd-stat-grid">{stats.map(stat => <button key={stat.title} className="pd-stat" onClick={() => onSection(stat.section)} style={{ '--pd-stat-color': stat.color }}><span className="pd-stat-icon"><Icon name={stat.icon} size={22}/></span><span className="pd-stat-copy"><span>{stat.title}</span><strong>{stat.value}</strong><small>{data?.nodes ? 'Activity · last 7 days' : 'Current total'}</small></span><Sparkline nodes={stat.title === 'Completed tasks' ? (data?.nodes || []).filter(node => node.details?.toStatus === 'completed' || node.details?.status === 'completed') : data?.nodes || []} actions={stat.actions} color={stat.color} now={data?.observedAt || 0}/></button>)}</div>
    <div className="pd-content-grid"><div className="pd-main-column">
      <section className="pd-panel pd-task-panel"><PanelHeading icon="tasks" title="What’s next" action="View all tasks" onAction={() => onSection('team')}>{writable && <button className="ws-button ws-button-primary" onClick={onTask}><Icon name="plus" size={16}/>Add task</button>}</PanelHeading><p className="pd-panel-description">Your top priorities, starting with overdue work.</p>{mutationError && <p className="ws-error" role="alert">{mutationError}</p>}<div className="pd-table-scroll"><table className="pd-task-table"><thead><tr><th scope="col"><span className="pd-square" aria-hidden="true"/><span className="pd-sr-only">Completion</span></th><th scope="col">Task</th><th scope="col">Priority</th><th scope="col">Due date</th><th scope="col">Assignee</th><th scope="col">Status</th><th scope="col"><span className="pd-sr-only">Actions</span></th></tr></thead><tbody>{tasks.map(task => { const member = project.context.members.find(person => person.userId === task.assignee); return <tr key={task.id}><td><input type="checkbox" aria-label={`Complete ${task.title}`} checked={false} disabled={!writable || busy !== null} onChange={() => completeTask(task)}/></td><td><button className="pd-task-name" onClick={() => onSection('team')}>{task.title}</button></td><td><Badge value={task.priority}/></td><td><span className="pd-due-date"><Icon name="clock" size={14}/>{task.deadline ? formatDate(task.deadline) : 'No due date'}</span></td><td><span className="pd-assignee">{member && <span>{member.name.charAt(0)}</span>}{member?.name || 'Unassigned'}</span></td><td><Badge value={task.status}/></td><td><button className="pd-row-more" aria-label={`View ${task.title}`} onClick={() => onSection('team')}>⋯</button></td></tr> })}</tbody></table></div>{!tasks.length && <div className="pd-empty">{project.tasks.length ? 'All tasks are completed.' : 'No tasks yet. Add a task to get started.'}</div>}</section>
      <div className="pd-lower-grid"><section className="pd-panel"><PanelHeading icon="clock" title="Recent activity" action="View all" onAction={() => onSection('tree')}/>{!data ? <p className="pd-empty">Loading activity…</p> : data.nodes === null ? <p className="pd-empty">Activity couldn’t load. Open Working tree to retry.</p> : !data.nodes.length ? <p className="pd-empty">Project activity will appear here.</p> : <ol className="pd-timeline">{[...data.nodes].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)).slice(0, 4).map(node => <li key={node.id}><span className="pd-timeline-dot"/><span className="pd-activity-avatar">{(node.actor || 'Project').charAt(0)}</span><div><strong>{node.label}</strong><p>{node.description || node.actor}</p></div><time dateTime={node.occurredAt}>{formatDate(node.occurredAt)}</time></li>)}</ol>}</section>
      <section className="pd-panel"><PanelHeading icon="connections" title="Connected sources" action="Manage" onAction={() => onSection('connections')}/><p className="pd-panel-description">Bring your project’s context together.</p>{sourcesError && <p className="ws-error" role="alert">{sourcesError}</p>}<div className="pd-source-grid">{sourceCards.map(source => { const count = source.id === 'documents' ? data?.documents?.length : integrations?.[source.id]?.length; return <button className={`pd-source-${source.id}`} key={source.id} onClick={() => onSection('connections')}>{['slack', 'notion'].includes(source.id) ? <AppIcon name={source.id}/> : <Icon name={source.icon || source.id} size={24}/>}<span><strong>{source.title}</strong><small className={count ? 'pd-source-connected' : ''}><i/>{count === undefined ? 'Unavailable' : count ? `${count} connected` : 'Not connected'}</small></span></button> })}<button className="pd-source-add" onClick={() => onSection('connections')}><Icon name="plus" size={20}/><span>Add source</span></button></div></section></div>
    </div><aside className="pd-side-column"><section className="pd-panel"><PanelHeading icon="tasks" title="Handoff readiness" action="View details" onAction={() => onSection('handoff')}/><div className="pd-readiness-summary"><div className="pd-readiness-ring" style={{ '--pd-score': `${score || 0}%` }} role="img" aria-label={score === null ? 'Readiness not checked' : `${score}% readiness at last check`}><span>{score === null ? '—' : `${score}%`}</span></div><div><strong>{!handoff ? 'No active handoff' : score === null ? 'Not checked yet' : validation.ready ? 'Ready to send' : 'Needs attention'}</strong><p>{score === null ? 'Prepare a handoff and check its readiness.' : 'Results from the last readiness check.'}</p></div></div>{validation?.checks?.length > 0 ? <ul className="pd-readiness-checks">{validation.checks.slice(0, 5).map(check => <li key={check.name}><span className={check.passed || check.waived ? 'passed' : ''}>{check.passed || check.waived ? '✓' : '□'}</span>{check.name.replaceAll('_', ' ')}</li>)}</ul> : <p className="pd-muted">Readiness checks appear after validation.</p>}{handoff && <Link className="pd-readiness-link" to={`/handoffs/${handoff.id}`}>Open handoff →</Link>}{blockers?.length > 0 && <button className="pd-blocker-button" onClick={() => onSection('review')}><Icon name="search" size={16}/>Review conflicts ({blockers.length}) →</button>}</section>
      <section className="pd-panel"><PanelHeading icon="clock" title="Upcoming deadlines" action="View all" onAction={() => onSection('team')}/>{deadlines.length ? <ul className="pd-deadlines">{deadlines.map(task => <li key={task.id}><span className={`pd-deadline-dot ${task.priority}`}/><button onClick={() => onSection('team')}>{task.title}</button><time dateTime={task.deadline}>{formatDate(task.deadline)}</time><Badge value={task.priority}/></li>)}</ul> : <p className="pd-empty">No deadlines scheduled.</p>}</section></aside></div>
  </div>
}
