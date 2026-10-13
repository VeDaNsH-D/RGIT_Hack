import { useEffect, useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { request } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from './WorkspaceContext'
import ProjectIntegrations from './ProjectIntegrations'
import { linkGitHubRepository, startGitHubInstall } from '../api/connections'
import { clearProjectDraft, loadProjectDraft, saveProjectDraft } from './projectDraft'
import OnboardingModal from './OnboardingModal'

const titles = { repository: 'Add a GitHub repository.', project: 'A new place for good work.', task: 'Make the next step clear.', handoff: 'Pass the context forward.', member: 'Bring your team together.', editProject: 'Refine your project.', editTask: 'Refine the next step.' }

export default function WorkspaceModal(props) {
  if (props.kind === 'member') {
    return <MemberWorkspaceModal {...props} />
  }
  return <StandardWorkspaceModal {...props} />
}

function MemberWorkspaceModal({ projectId, onClose }) {
  const { projects, reload } = useWorkspace()
  const project = projects.find(item => item.id === projectId) || projects[0]
  return (
    <OnboardingModal
      projectId={projectId || project?.id}
      projectName={project?.name}
      onClose={onClose}
      onCreated={async () => {
        await reload()
      }}
    />
  )
}

function StandardWorkspaceModal({ kind, projectId, initialTask, resumeDraft = false, excludeRepositoryIds = [], onClose }) {
  const dialog = useRef(null)
  const { projects, reload } = useWorkspace()
  const { session } = useAuth()
  const navigate = useNavigate()
  const eligible = projects.filter(project => kind === 'handoff' ? project.ownerId === session.user.id && !project.handoffs.some(h => h.isOpen) : ['task', 'editTask'].includes(kind) ? project.myRole !== 'viewer' : true)
  const [selected, setSelected] = useState(projectId || eligible[0]?.id || '')
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [integrations, setIntegrations] = useState({ github: null })
  const [partial, setPartial] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [draft] = useState(() => (kind === 'project' && resumeDraft ? loadProjectDraft() : null))
  const form = useRef(null)
  const project = projects.find(item => item.id === selected)
  const members = project?.context?.members || []
  const recipients = members.filter(member => member.userId !== session.user.id)

  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])

  function close() { if (kind === 'project') clearProjectDraft(); onClose() }

  async function finishPartial(retryLink) {
    setBusy(true)
    setError('')
    try {
      if (retryLink) await linkGitHubRepository(partial.projectId, integrations.github.id)
      clearProjectDraft()
      await reload()
      onClose()
      navigate(`/projects/${partial.projectId}`)
    } catch (err) { setError(err.message); setBusy(false) }
  }

  async function deleteProject() {
    setBusy(true)
    setError('')
    try {
      await request(`/projects/${selected}`, { method: 'DELETE' })
      await reload()
      onClose()
      navigate('/projects')
    } catch (err) { setError(err.message); setBusy(false) }
  }

  async function connectGitHub() {
    // Only text is kept; the project itself is created later, so a redirect can never duplicate it.
    const fields = Object.fromEntries(new FormData(form.current))
    saveProjectDraft({ name: fields.name || '', description: fields.description || '' })
    setBusy(true)
    setError('')
    try {
      const { url } = await startGitHubInstall()
      if (!url?.startsWith('https://github.com/')) throw new Error('GitHub returned an unexpected installation address.')
      window.location.assign(url)
    } catch (err) { setError(err.message); setBusy(false) }
  }

  async function submit(event) {
    event.preventDefault()
    if (busy || partial) return
    setBusy(true)
    setError(''); setNotice('')
    const fields = Object.fromEntries(new FormData(event.currentTarget))
    try {
      let destination
      if (kind === 'project') {
        const { project, integrations: linked } = await request('/projects', { method: 'POST', body: { name: fields.name.trim(), description: fields.description.trim(), ...(integrations.github ? { integrations: { github: { repositoryId: integrations.github.id } } } : {}) } })
        if (linked?.github?.status === 'failed') {
          setPartial({ projectId: project.id })
          setError(`Your project was created, but ${integrations.github.fullName} couldn’t be linked. Retry linking, or continue and connect it later.`)
          setBusy(false)
          return
        }
        clearProjectDraft()
        destination = `/projects/${project.id}`
      } else if (kind === 'editProject') {
        await request(`/projects/${selected}`, { method: 'PATCH', body: { name: fields.name.trim(), description: fields.description.trim() } })
      } else if (['task', 'editTask'].includes(kind)) {
        await request(kind === 'editTask' ? `/tasks/${initialTask.id}` : `/projects/${selected}/tasks`, { method: kind === 'editTask' ? 'PATCH' : 'POST', body: { title: fields.title.trim(), ...(fields.description !== undefined ? { description: fields.description.trim() } : {}), priority: fields.priority, assignee: fields.assignee || null, deadline: fields.deadline ? (kind === 'editTask' && fields.deadline === initialTask.deadline?.slice(0, 10) ? initialTask.deadline : new Date(`${fields.deadline}T23:59:00`).toISOString()) : null } })
      } else if (kind === 'repository') {
        await linkGitHubRepository(selected, integrations.github.id)
      } else if (kind === 'member') {
        await request(`/projects/${selected}/invitations`, { method: 'POST', body: { email: fields.email.trim(), role: fields.role } })
      } else {
        const { handoff } = await request(`/projects/${selected}/handoffs`, { method: 'POST', body: { toUserId: recipient } })
        destination = `/handoffs/${handoff.id}`
      }
      await reload()
      if (kind === 'member') { setNotice('Invitation email sent. Your teammate will join after accepting.'); setBusy(false); return }
      onClose()
      if (destination) navigate(destination)
    } catch (err) { setError(err.message); setBusy(false) }
  }

  return <dialog ref={dialog} className="ws-modal" onCancel={event => { if (busy) event.preventDefault(); else if (partial) finishPartial(false); else close() }} onClick={event => { if (event.target === event.currentTarget && !busy && !partial) close() }}>
    <button className="ws-modal-close" aria-label="Close dialog" onClick={() => (partial ? finishPartial(false) : close())} disabled={busy}>×</button>
    <span className="ws-eyebrow">{kind === 'editProject' ? 'PROJECT SETTINGS' : kind === 'editTask' ? 'TASK DETAILS' : `NEW ${kind.toUpperCase()}`}</span>
    <h2>{titles[kind]}</h2>
    <form ref={form} onSubmit={submit}>
      {notice && <p className="ws-notice" role="status">{notice}</p>}
      {!['project', 'editProject', 'member', 'editTask', 'repository'].includes(kind) && <label>Project<select required value={selected} onChange={event => { setSelected(event.target.value); setRecipient('') }}><option value="" disabled>Select a project</option>{eligible.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}
      {['project', 'editProject'].includes(kind) && <><label>Project name<input name="name" required maxLength={200} placeholder="e.g. Website launch" defaultValue={kind === 'editProject' ? project?.name : draft?.name || ''} readOnly={Boolean(partial)}/></label><label>Description<textarea name="description" maxLength={5000} rows={3} placeholder="What are you working toward?" defaultValue={kind === 'editProject' ? project?.description : draft?.description || ''} readOnly={Boolean(partial)}/></label>{kind === 'project' && <ProjectIntegrations value={integrations} onChange={setIntegrations} onConnectGitHub={connectGitHub} busy={busy || Boolean(partial)}/>}</>}
      {['task', 'editTask'].includes(kind) && <><label>Task title<input name="title" required maxLength={300} placeholder="What needs to happen?" defaultValue={initialTask?.title || ''}/></label>{kind === 'task' && <label>Description<textarea name="description" rows={2} maxLength={5000}/></label>}<div className="ws-form-grid"><label>Priority<select name="priority" defaultValue={initialTask?.priority || 'medium'}>{['low', 'medium', 'high', 'critical'].map(value => <option key={value}>{value}</option>)}</select></label><label>Due date<input name="deadline" type="date" defaultValue={initialTask?.deadline?.slice(0, 10) || ''}/></label></div><label>Assigned to<select name="assignee" key={selected} defaultValue={initialTask?.assignee || ''}><option value="">Unassigned</option>{members.map(member => <option value={member.userId} key={member.userId}>{member.name}</option>)}</select></label></>}
      {kind === 'repository' && <ProjectIntegrations value={integrations} onChange={setIntegrations} onConnectGitHub={() => { onClose(); navigate('/connections') }} busy={busy} excludeIds={excludeRepositoryIds}/>}
      {kind === 'member' && <><p className="ws-muted">Send an email invitation to join {project?.name}. They can sign in or create an account before accepting.</p><label>Email<input name="email" type="email" required placeholder="teammate@company.com"/></label><label>Role<select name="role" defaultValue="member"><option value="member">Member — contribute to tasks</option><option value="viewer">Viewer — read project context</option></select></label></>}
      {kind === 'handoff' && <><label>Next owner<select required value={recipient} onChange={event => setRecipient(event.target.value)}><option value="" disabled>Choose a teammate</option>{recipients.map(member => <option value={member.userId} key={member.userId}>{member.name} · {member.email}</option>)}</select></label><p className="ws-muted">Create a draft, document the context, then review readiness before sending.</p>{!recipients.length && project && <p className="ws-muted">Add a teammate on the <Link to={`/projects/${project.id}`}>project page</Link> first.</p>}</>}
      {kind === 'editProject' && <div className="ws-danger-zone">
        <strong>Delete project</strong>
        <p className="ws-muted">Permanently removes this project, its tasks, handoffs, documents, and linked sources for everyone. This can’t be undone.</p>
        {confirming ? <><label>{`Type “${project?.name}” to confirm`}<input value={confirmText} onChange={event => setConfirmText(event.target.value)} autoComplete="off" disabled={busy}/></label><div className="ws-modal-actions"><button type="button" className="ws-button" onClick={() => { setConfirming(false); setConfirmText('') }} disabled={busy}>Keep project</button><button type="button" className="ws-button ws-button-danger" onClick={deleteProject} disabled={busy || confirmText.trim() !== project?.name}>{busy ? 'Deleting…' : 'Delete permanently'}</button></div></> : <button type="button" className="ws-button ws-button-danger-outline" onClick={() => setConfirming(true)} disabled={busy}>Delete project…</button>}
      </div>}
      {error && <p className="ws-error" role="alert">{error}</p>}
      {partial ? <div className="ws-modal-actions"><button type="button" className="ws-button" onClick={() => finishPartial(false)} disabled={busy}>Continue to project</button><button type="button" className="ws-button ws-button-primary" onClick={() => finishPartial(true)} disabled={busy}>{busy ? 'Linking…' : 'Retry linking'}</button></div> : <div className="ws-modal-actions"><button type="button" className="ws-button" onClick={close} disabled={busy}>{notice ? 'Done' : 'Cancel'}</button><button className="ws-button ws-button-primary" disabled={busy || Boolean(notice) || (['task', 'handoff'].includes(kind) && !selected) || (kind === 'handoff' && !recipient) || (kind === 'repository' && !integrations.github)}>{busy ? 'Saving…' : kind === 'repository' ? 'Add repository' : ['editProject', 'editTask'].includes(kind) ? 'Save changes' : kind === 'member' ? 'Send invitation' : `Create ${kind}`}</button></div>}
    </form>
  </dialog>
}
