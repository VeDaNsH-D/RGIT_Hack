import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { eligibleRecipients, searchTeams, addTeamMembersToProject } from '../api/teams'
import { TRANSFER_LABEL } from './handoffLabels'

const REASONS = [
  'Requires expertise from another team',
  'Current owner is unavailable',
  'Issue has moved into another team’s area of responsibility',
  'Escalation is required',
  'Our team has completed its part of the work',
]

function ProjectChips({ team }) {
  const shown = team.projects || []
  if (!shown.length && !team.hiddenProjectCount) return <small className="wt-picker-projects">Not on any project yet</small>
  return <span className="wt-picker-projects" aria-label="Projects this team works on">
    {shown.map(project => <span className="wt-pill" key={project.id}>{project.name}</span>)}
    {team.hiddenProjectCount > 0 && <span className="wt-pill muted">+{team.hiddenProjectCount} more</span>}
  </span>
}

/**
 * Every distinct team the sender can see, searchable by name, with the projects each one works on.
 * Teams not yet on this project are marked; they are added to it when the handoff is created.
 */
export function TeamPicker({ teams, loading, value, onChange, currentTeamId, projectId, query = '', onQuery = () => {} }) {
  return <fieldset className="wt-picker">
    <legend>Destination team (Global directory)</legend>
    <input type="search" aria-label="Search teams" value={query} onChange={event => onQuery(event.target.value)} placeholder="Search global team directory by name"/>
    <div className="wt-picker-list" role="radiogroup" aria-label="Destination team" aria-busy={loading}>
      <button type="button" role="radio" aria-checked={!value} className={!value ? 'selected' : ''} onClick={() => onChange('')}><strong>No team</strong><small>Hand the project to an individual</small></button>
      {teams.map(team => {
        const onThisProject = team.linked ?? (team.projects || []).some(project => project.id === projectId)
        return <button type="button" role="radio" aria-checked={value === team.id} key={team.id} className={value === team.id ? 'selected' : ''} onClick={() => onChange(team.id)}>
          <strong>{team.name}{team.id === currentTeamId && <span className="wt-pill owns">Current team</span>}</strong>
          <small>Led by {team.leaderName} · {team.memberCount} {team.memberCount === 1 ? 'member' : 'members'} · {team.projectCount} {team.projectCount === 1 ? 'project' : 'projects'}</small>
          <ProjectChips team={team}/>
          {!onThisProject && <small className="wt-picker-note">Not on this project yet. It will be added when you create the handoff.</small>}
        </button>
      })}
      {loading && <p className="ws-muted">Searching teams…</p>}
      {!loading && !teams.length && <p className="ws-muted" role="status">{query.trim() ? `No teams match “${query}”.` : 'You don’t have any teams yet.'}</p>}
    </div>
  </fieldset>
}

/** Presentational: destination team → named recipient → reason. The receiving team and the person are chosen separately. */
export function DestinationFieldsView({ project, teams, teamsLoading, teamQuery, onTeamQuery, teamId, selectedTeam, onTeam, recipients, recipientsLoading, recipient, onRecipient, reason, onReason, instructions, onInstructions, error, individualRecipients, onAddMembers, addingMembers }) {
  const owningTeam = teams.find(team => team.id === project?.owningTeamId) || (selectedTeam?.id === project?.owningTeamId ? selectedTeam : null)
  const type = !teamId ? 'individual' : project?.owningTeamId === teamId ? 'intra_team' : 'inter_team'
  const people = teamId ? recipients : individualRecipients
  return <>
    <div className="wt-dest-meta">
      <div><small>Current owner</small><strong>{project?.context?.members.find(member => member.userId === project?.ownerId)?.name || 'You'}</strong></div>
      <div><small>Owning team</small><strong>{owningTeam?.name || (project?.owningTeamId ? 'Assigned' : 'None assigned')}</strong></div>
      <div><small>Transfer type</small><strong>{TRANSFER_LABEL[type]}</strong></div>
    </div>
    <TeamPicker teams={teams} loading={teamsLoading} value={teamId} onChange={onTeam} currentTeamId={project?.owningTeamId} projectId={project?.id} query={teamQuery} onQuery={onTeamQuery}/>
    {!teamsLoading && !teams.length && !teamQuery?.trim() && project && <p className="ws-muted">Teams from the global directory will appear here to route work between teams.</p>}
    <label>{teamId ? `Recipient in ${selectedTeam?.name || 'team'}` : 'Next owner'}
      <select required value={recipient} onChange={event => onRecipient(event.target.value)} disabled={recipientsLoading}>
        <option value="" disabled>{recipientsLoading ? 'Loading…' : 'Choose a teammate'}</option>
        {people.map(person => <option key={person.userId} value={person.userId}>{person.name}{person.isLeader ? ' · Team leader' : ''}{person.openTasks !== undefined ? ` · ${person.openTasks} open task${person.openTasks === 1 ? '' : 's'}` : ''}</option>)}
      </select>
    </label>
    {teamId && !recipientsLoading && !people.length && <div className="wt-no-members-box">
      <p className="ws-muted" role="status">None of this team’s members are on this project yet.</p>
      {onAddMembers && <button type="button" className="ws-button" onClick={onAddMembers} disabled={addingMembers}>{addingMembers ? 'Adding team members…' : `Add ${selectedTeam?.name || 'team'} members to project`}</button>}
    </div>}
    {teamId && <>
      <label>Reason for transfer
        <select value={REASONS.includes(reason) ? reason : reason ? '__custom' : ''} onChange={event => onReason(event.target.value === '__custom' ? ' ' : event.target.value)}>
          <option value="">Select a reason…</option>{REASONS.map(item => <option key={item}>{item}</option>)}<option value="__custom">Something else…</option>
        </select>
      </label>
      {(!REASONS.includes(reason) && reason !== '') && <label>Describe the reason<textarea required rows={2} maxLength={1000} value={reason.trim() === '' ? '' : reason} onChange={event => onReason(event.target.value || ' ')}/></label>}
      <label>Additional instructions <span className="ws-muted">(optional)</span><textarea rows={2} maxLength={2000} value={instructions} onChange={event => onInstructions(event.target.value)} placeholder="Anything the receiving team should know first"/></label>
    </>}
    {error && <p className="ws-error" role="alert">{error}</p>}
  </>
}

export default function HandoffDestination({ project, currentUserId, teamId, onTeam, recipient, onRecipient, reason, onReason, instructions, onInstructions }) {
  const projectId = project?.id
  const [query, setQuery] = useState('')
  const [teams, setTeams] = useState({ key: '', list: [], error: '' })
  const [recips, setRecips] = useState({ key: '', list: [], error: '' })
  const [known, setKnown] = useState({})
  const searchKey = `${projectId}:${query.trim()}`
  useEffect(() => {
    if (!projectId) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchTeams(query.trim(), projectId, controller.signal)
        .then(data => { if (!controller.signal.aborted) { setKnown(previous => ({ ...previous, ...Object.fromEntries(data.teams.map(team => [team.id, team])) })); setTeams({ key: searchKey, list: data.teams, error: '' }) } })
        .catch(err => { if (!controller.signal.aborted && err.name !== 'AbortError') setTeams({ key: searchKey, list: [], error: err.message }) })
    }, query.trim() ? 250 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [projectId, query, searchKey])
  const [recipReload, setRecipReload] = useState(0)
  const [addingMembers, setAddingMembers] = useState(false)
  const recipientKey = teamId ? `${projectId}:${teamId}:${recipReload}` : ''
  useEffect(() => {
    if (!teamId) return undefined
    const controller = new AbortController()
    eligibleRecipients(projectId, teamId, controller.signal).then(data => { if (!controller.signal.aborted) setRecips({ key: recipientKey, list: data.recipients, error: '' }) }).catch(err => { if (!controller.signal.aborted && err.name !== 'AbortError') setRecips({ key: recipientKey, list: [], error: err.message }) })
    return () => controller.abort()
  }, [projectId, teamId, recipientKey])

  async function handleAddMembers() {
    if (!teamId || addingMembers) return
    setAddingMembers(true)
    try {
      await addTeamMembersToProject(projectId, teamId)
      setRecipReload(n => n + 1)
    } catch (err) {
      setRecips(prev => ({ ...prev, error: err.message }))
    } finally {
      setAddingMembers(false)
    }
  }

  const individualRecipients = (project?.context?.members || []).filter(member => member.userId !== currentUserId)
  return <DestinationFieldsView
    project={project} teams={teams.list} teamsLoading={teams.key !== searchKey}
    teamQuery={query} onTeamQuery={setQuery} teamId={teamId} selectedTeam={known[teamId]} onTeam={onTeam}
    recipients={recips.key === recipientKey ? recips.list : []} recipientsLoading={Boolean(teamId) && recips.key !== recipientKey}
    recipient={recipient} onRecipient={onRecipient} reason={reason} onReason={onReason} instructions={instructions} onInstructions={onInstructions}
    error={teams.error || recips.error} individualRecipients={individualRecipients}
    onAddMembers={handleAddMembers} addingMembers={addingMembers}
  />
}
