import { useState } from 'react'
import { Link } from 'react-router-dom'
import { request } from '../api/client'
import { useWorkspace } from './WorkspaceContext'
import { Badge } from './ui'
import WorkspaceModal from './WorkspaceModal'
import { formatDate } from './utils'
import { githubStatusLabel, safeGithubUrl } from './taskGithub'

export function GithubStatus({ task, writable, busy, onRetry }) {
  const { github } = task
  const label = githubStatusLabel(github)
  if (!label) return null
  const repo = github.repository?.fullName
  const issueUrl = safeGithubUrl(github.issueUrl)
  return <small className={`ws-task-github ws-task-github-${github.status}`}>
    {github.status === 'synced' && issueUrl ? <>{label} · <a href={issueUrl} target="_blank" rel="noopener noreferrer">View issue</a></> : label}
    {repo && github.status !== 'not_connected' && <> · {repo}</>}
    {github.status === 'failed' && github.error?.message && <> {github.error.message}</>}
    {github.retryable && writable && <> <button type="button" className="ws-text-button" onClick={onRetry} disabled={busy}>Retry</button></>}
  </small>
}

export default function TaskList({ tasks }) {
  const { projects, reload } = useWorkspace()
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  async function update(task, values) {
    setBusy(task.id)
    setError('')
    try { await request(`/tasks/${task.id}`, { method: 'PATCH', body: values }); await reload() }
    catch (err) { setError(err.message) }
    finally { setBusy(null) }
  }
  async function retryGithub(task) {
    setBusy(task.id)
    setError('')
    try {
      const { task: updated } = await request(`/tasks/${task.id}/github/retry`, { method: 'POST' })
      if (updated.github?.status === 'failed') setError(updated.github.error?.message || 'GitHub issue creation failed again.')
      await reload()
    } catch (err) { setError(err.message) }
    finally { setBusy(null) }
  }
  return <>{error && <p className="ws-error" role="alert">{error}</p>}<div className="ws-task-list">{tasks.map(task => {
    const project = projects.find(project => project.id === task.projectId)
    const writable = project?.myRole !== 'viewer'
    return <div className={`ws-task-row ${task.status === 'completed' ? 'ws-task-done' : ''}`} key={task.id}>
      <input aria-label={`Mark ${task.title} ${task.status === 'completed' ? 'open' : 'completed'}`} type="checkbox" checked={task.status === 'completed'} disabled={!writable || busy !== null} onChange={() => update(task, { status: task.status === 'open' ? 'completed' : 'open' })}/>
      <div className="ws-task-title"><strong>{task.title}</strong><Link to={`/projects/${task.projectId}`}>{project?.name}</Link>{task.github && <GithubStatus task={task} writable={writable} busy={busy !== null} onRetry={() => retryGithub(task)}/>}</div>
      <Badge value={task.priority}/>
      <span className={`ws-task-date ${task.overdue ? 'ws-overdue' : ''}`}>{formatDate(task.deadline)}</span>
      <select className="ws-assignee-select" aria-label={`Assign ${task.title}`} value={task.assignee || ''} disabled={!writable || busy !== null} onChange={event => update(task, { assignee: event.target.value || null })}><option value="">Unassigned</option>{project?.context?.members.map(member => <option value={member.userId} key={member.userId}>{member.name}</option>)}</select>
      {writable && <button className="ws-task-edit" aria-label={`Edit ${task.title}`} onClick={() => setEditing(task)} disabled={busy !== null}>Edit</button>}
    </div>
  })}</div>{editing && <WorkspaceModal kind="editTask" projectId={editing.projectId} initialTask={editing} onClose={() => setEditing(null)}/>}</>
}
