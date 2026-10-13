import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { addTeamMember, createTeam, formTeamFromMembers, getTeam, linkTeam, listTeams, removeTeamMember, searchTeams, setOwningTeam, setTeamMemberRole, unlinkTeam, updateTeam } from '../api/teams'
import { useAuth } from '../auth/AuthContext'
import { Badge } from './ui'
import './teams.css'

const initials = name => (name || '?').split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()
const HANDOFF_STATE_LABEL = { DRAFT: 'Draft', EDITING: 'Editing', SUBMITTED: 'Awaiting acceptance', CLARIFICATION_REQUESTED: 'Changes requested', ACKNOWLEDGED: 'Accepted', REJECTED: 'Rejected', CANCELLED: 'Cancelled' }

export function TeamCard({ team, onOpen }) {
  const shown = team.members.slice(0, 4)
  return <article className={`wt-team-card ${team.isActive ? '' : 'inactive'}`}>
    <header>
      <h3>{team.name}</h3>
      <div className="wt-team-badges">{team.otherProjects > 0 && <span className="wt-pill" title="This team also works on other projects">+{team.otherProjects} other {team.otherProjects === 1 ? 'project' : 'projects'}</span>}{team.ownsProject && <span className="wt-pill owns">Owns this project</span>}{!team.isActive && <span className="wt-pill">Inactive</span>}</div>
    </header>
    <p className="wt-team-desc">{team.description || 'No description yet.'}</p>
    <div className="wt-team-leader"><span className="wt-avatar">{initials(team.leader?.name)}</span><div><small>Team leader</small><strong>{team.leader?.name || 'Unassigned'}</strong></div></div>
    <div className="wt-team-members" aria-label={`${team.members.length} members`}>
      {shown.map(member => <span className="wt-avatar" key={member.userId} title={`${member.name}${member.role === 'leader' ? ' (leader)' : ''}`}>{initials(member.name)}</span>)}
      {team.members.length > shown.length && <span className="wt-avatar more">+{team.members.length - shown.length}</span>}
      <span className="wt-team-count">{team.members.length} {team.members.length === 1 ? 'member' : 'members'}</span>
    </div>
    <dl className="wt-team-stats">
      <div><dt>Active cases</dt><dd>{team.activeCases}</dd></div>
      <div><dt>Incoming</dt><dd>{team.incomingHandoffs}</dd></div>
      <div><dt>Outgoing</dt><dd>{team.outgoingHandoffs}</dd></div>
    </dl>
    <button type="button" className="ws-button" onClick={() => onOpen(team.id)}>View team</button>
  </article>
}

export function CreateTeamForm({ projectMembers, defaultName = 'Team 1', busy, error, onSubmit, onCancel }) {
  const candidates = projectMembers.filter(member => member.role !== 'viewer')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [leaderId, setLeaderId] = useState('')
  const [memberIds, setMemberIds] = useState([])
  const toggle = id => setMemberIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
  return <form className="wt-team-form ws-panel" onSubmit={event => { event.preventDefault(); onSubmit({ ...(name.trim() ? { name: name.trim() } : {}), description: description.trim(), leaderId, memberIds: memberIds.filter(id => id !== leaderId) }) }}>
    <h3>Create a team</h3>
    <label>Team name <span className="ws-muted">(optional)</span><input maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={`${defaultName} (auto-numbered)`}/></label>
    <p className="ws-muted wt-hint">Leave the name blank and this team becomes “{defaultName}”. You can rename it any time.</p>
    <label>Description<textarea rows={2} maxLength={500} value={description} onChange={event => setDescription(event.target.value)} placeholder="What does this team own?"/></label>
    <label>Team leader<select required value={leaderId} onChange={event => setLeaderId(event.target.value)}><option value="" disabled>Choose a project member</option>{candidates.map(member => <option key={member.userId} value={member.userId}>{member.name} · {member.email}</option>)}</select></label>
    <fieldset><legend>Members <span className="ws-muted">(optional)</span></legend>
      {projectMembers.filter(member => member.userId !== leaderId).map(member => <label className="ws-checkbox-label" key={member.userId}><input type="checkbox" checked={memberIds.includes(member.userId)} onChange={() => toggle(member.userId)}/>{member.name} <span className="ws-muted">{member.email}</span></label>)}
    </fieldset>
    {error && <p className="ws-error" role="alert">{error}</p>}
    <div className="wt-form-actions"><button type="button" className="ws-button" onClick={onCancel} disabled={busy}>Cancel</button><button className="ws-button ws-button-primary" disabled={busy || !leaderId}>{busy ? 'Creating…' : 'Create team'}</button></div>
  </form>
}

export function TeamDetailView({ detail, projectMembers, canManage, canManageRoster, canUnlink, busy, error, notice, onBack, onAction }) {
  const { team, cases = [], handoffs = [] } = detail
  const memberIds = new Set(team.members.map(member => member.userId))
  const addable = projectMembers.filter(member => !memberIds.has(member.userId))
  const [adding, setAdding] = useState('')
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(team.name)
  const [description, setDescription] = useState(team.description)
  return <section className="wt-team-detail">
    <button type="button" className="ws-text-button" onClick={onBack}>← All teams</button>
    <header className="wt-detail-head">
      <div>
        <h2>{team.name} {!team.isActive && <span className="wt-pill">Inactive</span>} {team.ownsProject && <span className="wt-pill owns">Owns this project</span>}</h2>
        <p className="ws-muted">{team.description || 'No description yet.'}</p>
        <p className="ws-muted">Led by <strong>{team.leader?.name || 'nobody'}</strong> · {team.members.length} members{team.otherProjects > 0 ? ` · also works on ${team.otherProjects} other ${team.otherProjects === 1 ? 'project' : 'projects'}` : ''}</p>
      </div>
      {canManage && <div className="wt-detail-actions">
        <button className="ws-button" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? 'Close editor' : 'Edit team'}</button>
        {team.isActive && !team.ownsProject && <button className="ws-button" disabled={busy} onClick={() => onAction('owning', team.id)}>Set as owning team</button>}
        {team.ownsProject && <button className="ws-button" disabled={busy} onClick={() => onAction('owning', null)}>Clear owning team</button>}
        {canUnlink && !team.ownsProject && <button className="ws-button" disabled={busy} onClick={() => { if (window.confirm('Remove this team from the project? The team itself and its other projects are not affected.')) onAction('unlink') }}>Remove from project</button>}
        <button className="ws-button" disabled={busy} onClick={() => { if (window.confirm(team.isActive ? 'Deactivate this team? It stops being a handoff destination on every project it works on.' : 'Reactivate this team?')) onAction('active', !team.isActive) }}>{team.isActive ? 'Deactivate' : 'Reactivate'}</button>
      </div>}
    </header>
    {notice && <p className="ws-notice" role="status">{notice}</p>}
    {error && <p className="ws-error" role="alert">{error}</p>}
    {editing && <form className="ws-panel wt-team-form" onSubmit={event => { event.preventDefault(); onAction('edit', { name: name.trim(), description: description.trim() }); setEditing(false) }}>
      <label>Team name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)}/></label>
      <label>Description<textarea rows={2} maxLength={500} value={description} onChange={event => setDescription(event.target.value)}/></label>
      <div className="wt-form-actions"><button className="ws-button ws-button-primary" disabled={busy || !name.trim()}>Save changes</button></div>
    </form>}
    <div className="wt-detail-grid">
      <section className="ws-panel">
        <div className="ws-section-heading"><h2>Members</h2></div>
        <ul className="wt-member-list">
          {team.members.map(member => <li key={member.userId}>
            <span className="wt-avatar">{initials(member.name)}</span>
            <div><strong>{member.name}</strong><small>{member.onProject === false ? 'Not on this project' : member.email}</small></div>
            <Badge value={member.role}/>
            {canManageRoster && member.role !== 'leader' && <span className="wt-member-actions">
              {canManage && <button className="ws-text-button" disabled={busy} onClick={() => onAction('leader', member.userId)}>Make leader</button>}
              <button className="ws-text-button ws-danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${member.name} from ${team.name}?`)) onAction('remove', member.userId) }}>Remove</button>
            </span>}
          </li>)}
        </ul>
        {canManageRoster && team.isActive && <form className="wt-add-member" onSubmit={event => { event.preventDefault(); if (adding) { onAction('add', adding); setAdding('') } }}>
          <select aria-label="Add a project member" value={adding} onChange={event => setAdding(event.target.value)}><option value="">{addable.length ? 'Add a project member…' : 'Everyone on the project is already here'}</option>{addable.map(member => <option key={member.userId} value={member.userId}>{member.name} · {member.email}</option>)}</select>
          <button className="ws-button" disabled={busy || !adding}>Add</button>
        </form>}
      </section>
      <section className="ws-panel">
        <div className="ws-section-heading"><h2>Cases</h2></div>
        {cases.length ? <ul className="wt-simple-list">{cases.map(item => <li key={item.id}><Link to={`/projects/${item.id}`}>{item.name}</Link><Badge value={item.status}/></li>)}</ul> : <p className="ws-panel-empty">This team doesn’t own the project right now.</p>}
        <div className="ws-section-heading wt-spaced"><h2>Handoffs</h2></div>
        {handoffs.length ? <ul className="wt-simple-list">{handoffs.map(item => <li key={item.id}><Link to={`/handoffs/${item.id}`}>{item.direction === 'incoming' ? 'Incoming' : 'Outgoing'} · {item.transferType.replace('_', '-')}</Link><span className="wt-handoff-state">{HANDOFF_STATE_LABEL[item.state] || item.state}</span></li>)}</ul> : <p className="ws-panel-empty">No handoffs involve this team yet.</p>}
      </section>
    </div>
  </section>
}

export function LinkTeamPanelView({ search, onSearch, results, loading, busyId, error, onLink, onClose }) {
  return <section className="ws-panel wt-link-panel">
    <div className="ws-section-heading"><div><h3>Add an existing team</h3><p className="ws-muted">One team can work on several projects. People keep their own project access.</p></div><button className="ws-text-button" onClick={onClose}>Close</button></div>
    <input type="search" autoFocus aria-label="Search your teams" value={search} onChange={event => onSearch(event.target.value)} placeholder="Search teams by name"/>
    {error && <p className="ws-error" role="alert">{error}</p>}
    {loading ? <p className="ws-muted">Searching…</p> : results.length ? <ul className="wt-link-results">{results.map(team => <li key={team.id}>
      <div><strong>{team.name}</strong><small>Led by {team.leaderName} · {team.memberCount} {team.memberCount === 1 ? 'member' : 'members'} · {team.projectCount} {team.projectCount === 1 ? 'project' : 'projects'}</small>{(team.projects?.length > 0 || team.hiddenProjectCount > 0) && <span className="wt-picker-projects">{team.projects.map(project => <span className="wt-pill" key={project.id}>{project.name}</span>)}{team.hiddenProjectCount > 0 && <span className="wt-pill muted">+{team.hiddenProjectCount} more</span>}</span>}</div>
      {team.linked ? <span className="wt-pill">Already here</span> : <button className="ws-button" disabled={busyId === team.id} onClick={() => onLink(team)}>{busyId === team.id ? 'Adding…' : 'Add to project'}</button>}
    </li>)}</ul> : <p className="ws-panel-empty">No teams found.</p>}
  </section>
}

function LinkTeamPanel({ projectId, onLinked, onClose }) {
  const [search, setSearch] = useState('')
  const [state, setState] = useState({ results: [], loading: true, error: '' })
  const [busyId, setBusyId] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchTeams(search.trim(), projectId, controller.signal)
        .then(data => { if (!controller.signal.aborted) setState({ results: data.teams, loading: false, error: '' }) })
        .catch(err => { if (!controller.signal.aborted && err.name !== 'AbortError') setState({ results: [], loading: false, error: err.message }) })
    }, search ? 250 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [search, projectId])
  async function add(team) {
    setBusyId(team.id)
    try {
      const result = await linkTeam(projectId, team.id)
      onLinked(result.membersNotOnProject ? `${team.name} added. ${result.membersNotOnProject} of its members aren’t on this project yet, so they can’t receive handoffs here until invited.` : `${team.name} added to this project.`)
    } catch (err) { setState(previous => ({ ...previous, error: err.message })) } finally { setBusyId('') }
  }
  return <LinkTeamPanelView search={search} onSearch={setSearch} results={state.results} loading={state.loading} busyId={busyId} error={state.error} onLink={add} onClose={onClose}/>
}

export default function TeamsSection({ project, canManage }) {
  const { session } = useAuth()
  const [linking, setLinking] = useState(false)
  const [state, setState] = useState({ teams: [], owningTeamId: null, nextDefaultName: 'Team 1', loading: true, error: '' })
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)
  const projectMembers = project.context.members

  const load = useCallback(async signal => {
    try {
      const data = await listTeams(project.id, signal)
      if (!signal?.aborted) setState({ teams: data.teams, owningTeamId: data.owningTeamId, nextDefaultName: data.nextDefaultName, loading: false, error: '' })
    } catch (err) { if (!signal?.aborted) setState(previous => ({ ...previous, loading: false, error: err.message })) }
  }, [project.id])
  useEffect(() => { const controller = new AbortController(); load(controller.signal); return () => controller.abort() }, [load])

  const loadDetail = useCallback(async (id, signal) => {
    try { const data = await getTeam(project.id, id, signal); if (!signal?.aborted) setDetail(data) }
    catch (err) { if (!signal?.aborted) { setError(err.message); setOpenId(null) } }
  }, [project.id])
  useEffect(() => {
    if (!openId) return undefined
    const controller = new AbortController()
    loadDetail(openId, controller.signal)
    return () => controller.abort()
  }, [openId, loadDetail])

  async function run(task, success) {
    setBusy(true); setError(''); setNotice('')
    try { await task(); if (success) setNotice(success); await load(); if (openId) await loadDetail(openId) }
    catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  async function handleAction(kind, value) {
    if (kind === 'edit') return run(() => updateTeam(project.id, openId, value), 'Team updated.')
    if (kind === 'active') return run(() => updateTeam(project.id, openId, { isActive: value }), value ? 'Team reactivated.' : 'Team deactivated.')
    if (kind === 'owning') return run(() => setOwningTeam(project.id, value), value ? 'This team now owns the project.' : 'Owning team cleared.')
    if (kind === 'leader') return run(() => setTeamMemberRole(project.id, openId, value, 'leader'), 'Leader changed.')
    if (kind === 'remove') return run(() => removeTeamMember(project.id, openId, value), 'Member removed.')
    if (kind === 'add') return run(() => addTeamMember(project.id, openId, { userId: value }), 'Member added.')
    if (kind === 'unlink') {
      setBusy(true); setError(''); setNotice('')
      try { await unlinkTeam(project.id, openId); setOpenId(null); setDetail(null); setNotice('Team removed from this project.'); await load() } catch (err) { setError(err.message) } finally { setBusy(false) }
    }
  }

  const form = useMemo(() => <CreateTeamForm projectMembers={projectMembers} defaultName={state.nextDefaultName} busy={busy} error={error} onCancel={() => { setCreating(false); setError('') }} onSubmit={async body => {
    setBusy(true); setError('')
    try { await createTeam(project.id, body); setCreating(false); await load() } catch (err) { setError(err.message) } finally { setBusy(false) }
  }}/>, [projectMembers, state.nextDefaultName, busy, error, project.id, load])

  const selected = openId && detail?.team?.id === openId ? detail : null
  const perms = selected?.permissions || { admin: false, roster: false, unlink: false }
  if (openId) {
    return selected ? <TeamDetailView detail={selected} projectMembers={projectMembers} canManage={perms.admin} canManageRoster={perms.roster || selected.team.leaderId === session.user.id} canUnlink={perms.unlink} busy={busy} error={error} notice={notice} onBack={() => { setOpenId(null); setDetail(null); setNotice(''); setError('') }} onAction={handleAction}/> : <div className="ws-loading" role="status"><span className="ws-spinner"/>Loading team…</div>
  }
  return <section className="wt-teams">
    <TeamsList state={state} search={search} onSearch={setSearch} showInactive={showInactive} onShowInactive={setShowInactive} canManage={canManage} creating={creating} onCreate={() => setCreating(true)} form={form} linking={linking} onLink={() => setLinking(true)} linkPanel={<LinkTeamPanel projectId={project.id} onClose={() => setLinking(false)} onLinked={async message => { setLinking(false); setNotice(message); await load() }}/>} onFromMembers={async () => { setBusy(true); setError(''); try { await formTeamFromMembers(project.id); setNotice('Team created from this project’s members.'); await load() } catch (err) { setError(err.message) } finally { setBusy(false) } }} memberCount={projectMembers.filter(member => member.role !== 'viewer').length} onOpen={id => { setDetail(null); setOpenId(id) }} error={state.error || error} notice={notice}/>
  </section>
}

export function TeamsList({ state, search, onSearch, showInactive, onShowInactive, canManage, creating, onCreate, form, linking = false, onLink = () => {}, linkPanel = null, onFromMembers = null, memberCount = 0, onOpen, error, notice }) {
  const query = search.trim().toLowerCase()
  const shown = state.teams.filter(team => (showInactive || team.isActive) && (!query || [team.name, team.description, team.leader?.name, ...team.members.map(member => member.name)].some(value => value?.toLowerCase().includes(query))))
  return <>
    <div className="wt-teams-head">
      <div><span className="ws-eyebrow">PEOPLE & OWNERSHIP</span><h2>Teams & members</h2><p className="ws-muted">Teams own cases and receive handoffs. Everyone listed here is already on the project.</p></div>
      {canManage && !creating && !linking && <div className="wt-head-actions"><button className="ws-button" onClick={onLink}>Add existing team</button><button className="ws-button ws-button-primary" onClick={onCreate}>+ New team</button></div>}
    </div>
    {creating && form}
    {linking && linkPanel}
    {notice && <p className="ws-notice" role="status">{notice}</p>}
    <div className="wt-teams-toolbar">
      <input type="search" aria-label="Search teams" value={search} onChange={event => onSearch(event.target.value)} placeholder="Search teams or people"/>
      <label className="ws-checkbox-label"><input type="checkbox" checked={showInactive} onChange={event => onShowInactive(event.target.checked)}/>Show inactive</label>
    </div>
    {error && <p className="ws-error" role="alert">{error}</p>}
    {state.loading ? <div className="ws-loading" role="status"><span className="ws-spinner"/>Loading teams…</div>
      : shown.length ? <div className="wt-team-grid">{shown.map(team => <TeamCard key={team.id} team={team} onOpen={onOpen}/>)}</div>
            : <div className="ws-panel ws-panel-empty">{state.teams.length ? 'No teams match your search.' : canManage ? <>No teams yet. Create one, add an existing team{onFromMembers && memberCount > 0 && <>, or <button type="button" className="ws-text-button" onClick={onFromMembers}>form a team from this project’s {memberCount} {memberCount === 1 ? 'person' : 'people'}</button></>}.</> : 'No teams have been set up for this project yet.'}</div>}
  </>
}
