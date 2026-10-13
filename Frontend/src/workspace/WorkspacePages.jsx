import { listProjectRepositories } from '../api/connections'
import ProjectOverview from './ProjectOverview'
import ProjectChat from './ProjectChat'
import ProjectInvitations from './ProjectInvitations'
import ProjectWorkTree from './ProjectWorkTree'
import ConflictDetectionPanel from './ConflictDetectionPanel'
import TroubleshootingHistory from './TroubleshootingHistory'
import ProjectOnboardingSection from './ProjectOnboardingSection'
import { getMyOnboarding } from '../api/onboarding'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { loadProjectDraft } from './projectDraft'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from './WorkspaceContext'
import { Badge, EmptyState, Icon, PageHeading, ProjectCard } from './ui'
import { formatDate, memberName } from './utils'
import WorkspaceModal from './WorkspaceModal'
import ConnectedRepositories from './ConnectedRepositories'
import ProjectDocuments from './ProjectDocuments'
import ConnectedSlackChannels from './ConnectedSlackChannels'
import ConnectedJiraProjects from './ConnectedJiraProjects'
import ConnectedNotionPages from './ConnectedNotionPages'
import RepositoryActivity from './RepositoryActivity'
import AiProjectContext from './AiProjectContext'
import TaskList from './TaskList'
import TeamsSection from './TeamsSection'
import { HandoffInboxView, OwnershipTimeline } from './HandoffTransfer'

export function DashboardPage() {
  const { session } = useAuth()
  const { projects, tasks, handoffs } = useWorkspace()
  const [modal, setModal] = useState(null)
  const openTasks = tasks.filter(task => task.status === 'open')
  const active = handoffs.filter(handoff => handoff.isOpen)
  const incoming = active.filter(handoff => handoff.toUserId === session.user.id)
  const stats = [{ name: 'projects', label: 'Your projects', value: projects.length }, { name: 'tasks', label: 'Open tasks', value: openTasks.length }, { name: 'handoffs', label: 'Active handoffs', value: active.length }, { name: 'check', label: 'Tasks completed', value: tasks.length - openTasks.length }]
  return <>
    <PageHeading eyebrow="YOUR WORK, IN SYNC" title={`Welcome back, ${session.user.name.split(' ')[0]}.`} description="A little less friction. A lot more continuity."/>
    <section className="ws-welcome"><div><span className="ws-eyebrow">A CLEAR START. A CONFIDENT HANDOFF.</span><h2>Keep the work moving.<br/><em>Keep the context with it.</em></h2><p>{projects.length ? 'Your projects, priorities, and people — all in one place.' : 'Your workspace is ready. Create your first project and bring your team together.'}</p><button className="ws-button ws-button-primary" onClick={() => setModal('project')}><Icon name="plus" size={16}/>{projects.length ? 'New project' : 'Create your first project'}</button></div><div className="ws-welcome-art" aria-hidden="true"><img src="/images/dashboard-continuity.png" alt="" /></div></section>
    <div className="ws-stats">{stats.map(stat => <Link to={stat.name === 'check' ? '/tasks?status=completed' : `/${stat.name}`} className="ws-stat" key={stat.name}><span className="ws-stat-icon"><Icon name={stat.name}/></span><span>{stat.label}</span><strong>{stat.value}</strong></Link>)}</div>
    <div className="ws-section-heading"><div><h2>Your projects</h2><p>Pick up where your team left off.</p></div><Link to="/projects">View all <Icon name="arrow" size={16}/></Link></div>
    {projects.length ? <div className="ws-project-grid">{projects.slice(0, 3).map(project => <ProjectCard project={project} key={project.id}/>)}</div> : <EmptyState title="Good work starts with a project." description="Give your work a home. Add tasks, invite teammates, and keep the important context together." action="Create project" onAction={() => setModal('project')}/>}
    <div className="ws-dashboard-columns"><section className="ws-panel"><div className="ws-section-heading"><h2>Next on your list</h2><Link to="/tasks">All tasks →</Link></div>{openTasks.length ? <TaskList tasks={openTasks.slice(0, 4)}/> : <p className="ws-panel-empty">No open tasks. A little breathing room.</p>}</section><section className="ws-panel"><div className="ws-section-heading"><h2>Coming your way</h2><Link to="/handoffs">All handoffs →</Link></div>{incoming.length ? incoming.slice(0, 4).map(handoff => <HandoffCard key={handoff.id} handoff={handoff} compact/>) : <p className="ws-panel-empty">Handoffs assigned to you will appear here.</p>}</section></div>
    {modal && <WorkspaceModal kind={modal} onClose={() => setModal(null)}/>}
  </>
}

export function ProjectsPage() {
  const { projects } = useWorkspace()
  const [search, setSearch] = useState('')
  const [params, setParams] = useSearchParams()
  // Returning from GitHub authorization reopens the dialog with the saved text.
  const [resume] = useState(() => params.has('newProject') && Boolean(loadProjectDraft()))
  const [modal, setModal] = useState(resume)
  useEffect(() => { if (params.has('newProject')) setParams({}, { replace: true }) }, [params, setParams])
  const filtered = projects.filter(project => `${project.name} ${project.description}`.toLowerCase().includes(search.toLowerCase()))
  return <><PageHeading eyebrow="ONE SHARED SOURCE OF TRUTH" title="Projects" description="Bring people, priorities, and context together." action="New project" onAction={() => setModal(true)}/><div className="ws-filters"><label className="ws-search"><Icon name="search" size={18}/><input aria-label="Search projects" placeholder="Search projects…" value={search} onChange={event => setSearch(event.target.value)}/></label><span className="ws-muted">{filtered.length} projects</span></div>{filtered.length ? <div className="ws-project-grid">{filtered.map(project => <ProjectCard project={project} key={project.id}/>)}</div> : <EmptyState title={search ? 'No projects match that search.' : 'Your next chapter starts here.'} description={search ? 'Try another project name.' : 'Create a project to organize your team’s work.'} action={search ? null : 'Create project'} onAction={() => setModal(true)}/ >}{modal && <WorkspaceModal kind="project" resumeDraft={resume} onClose={() => setModal(false)}/>}</>
}

export function TasksPage() {
  const { projects, tasks } = useWorkspace()
  const { session } = useAuth()
  const [filter, setFilter] = useState(new URLSearchParams(window.location.search).get('status') || 'all')
  const [projectId, setProjectId] = useState('all')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(false)
  const filtered = tasks.filter(task => (filter === 'all' || task.status === filter || (filter === 'mine' && task.assignee === session.user.id)) && (projectId === 'all' || task.projectId === projectId) && task.title.toLowerCase().includes(search.toLowerCase()))
  const writable = projects.some(project => project.myRole !== 'viewer')
  return <><PageHeading eyebrow="SMALL STEPS. SHARED PROGRESS." title="Tasks" description="Know what’s next, who owns it, and when it’s due." action={writable ? 'New task' : null} onAction={() => setModal(true)}/><div className="ws-filters"><div className="ws-tabs" aria-label="Task filters">{[['all', 'All tasks'], ['mine', 'Assigned to me'], ['open', 'Open'], ['completed', 'Completed']].map(([value, label]) => <button className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)}>{label}</button>)}</div><select aria-label="Filter by project" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="all">All projects</option>{projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></div><label className="ws-search ws-task-search"><Icon name="search" size={18}/><input aria-label="Search tasks" placeholder="Find a task…" value={search} onChange={event => setSearch(event.target.value)}/></label>{filtered.length ? <section className="ws-panel"><TaskList tasks={filtered}/></section> : <EmptyState title={tasks.length ? 'Nothing in this view.' : 'Give your next step a name.'} description={tasks.length ? 'Try a different filter or search.' : 'Create a project, then add your first task.'} action={writable ? 'Create task' : null} onAction={() => setModal(true)}/>}{modal && <WorkspaceModal kind="task" onClose={() => setModal(false)}/>}</>
}

function HandoffCard({ handoff, compact = false }) {
  const { projects } = useWorkspace()
  const project = projects.find(project => project.id === handoff.projectId)
  return <Link className={`ws-handoff-card ${compact ? 'ws-handoff-compact' : ''}`} to={`/handoffs/${handoff.id}`}><div className="ws-handoff-card-top"><span className="ws-project-symbol"><Icon name="handoffs"/></span><Badge value={handoff.state}/></div><h3>{project?.name || 'Project handoff'}</h3><p>{handoff.currentStatus || 'A fresh draft. Add the context your teammate needs.'}</p><div className="ws-handoff-people"><span>{memberName(project, handoff.fromUserId)}</span><Icon name="arrow" size={16}/><span>{memberName(project, handoff.toUserId)}</span></div><div className="ws-handoff-card-bottom"><span>{formatDate(handoff.updatedAt)}</span><span>View context →</span></div></Link>
}

export function HandoffsPage() {
  const { projects, handoffs } = useWorkspace()
  const { session } = useAuth()
  const [filter, setFilter] = useState('all')
  const [stateFilter, setStateFilter] = useState('all')
  const [modal, setModal] = useState(false)
  const inbox = filter === 'incoming' || filter === 'outgoing'
  const filtered = handoffs.filter(handoff => filter === 'all' || (filter === 'incoming' && handoff.toUserId === session.user.id) || (filter === 'outgoing' && handoff.fromUserId === session.user.id) || (filter === 'complete' && !handoff.isOpen))
  const canCreate = projects.some(project => project.ownerId === session.user.id && !project.handoffs.some(h => h.isOpen))
  return <><PageHeading eyebrow="CONTEXT GOES WITH YOU" title="Handoffs" description="Pass the work forward, without leaving the important things behind." action={canCreate ? 'New handoff' : null} onAction={() => setModal(true)}/><div className="ws-filters"><div className="ws-tabs">{[['all', 'All handoffs'], ['incoming', 'Incoming'], ['outgoing', 'Outgoing'], ['complete', 'Closed']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><span className="ws-muted">{filtered.length} handoffs</span></div>{inbox && <div className="ws-tabs wt-state-filters" aria-label="Filter by status">{[['all', 'All'], ['open', 'Awaiting acceptance'], ['changes', 'Changes requested'], ['accepted', 'Accepted'], ['rejected', 'Rejected']].map(([value, label]) => <button key={value} className={stateFilter === value ? 'active' : ''} onClick={() => setStateFilter(value)}>{label}</button>)}</div>}{inbox ? <HandoffInboxView handoffs={handoffs} projects={projects} userId={session.user.id} direction={filter} stateFilter={stateFilter}/> : filtered.length ? <div className="ws-project-grid">{filtered.map(handoff => <HandoffCard handoff={handoff} key={handoff.id}/>)}</div> : <EmptyState title="Make the next handoff a clear one." description={projects.length ? 'Project owners can start a handoff after adding a teammate.' : 'Create a project and add a teammate before starting a handoff.'} action={canCreate ? 'Create handoff' : null} onAction={() => setModal(true)}/>}{modal && <WorkspaceModal kind="handoff" onClose={() => setModal(false)}/>}</>
}

const projectSections = [
  ['overview', 'Overview', 'dashboard'],
  ['team', 'Tasks & team', 'tasks'],
  ['connections', 'Sources', 'connections'],
  ['ask', 'Chat', 'chat'],
  ['handoff', 'Handoffs', 'handoffs'],
  ['tree', 'Working tree', 'sparkles'],
  ['teams', 'Teams & members', 'users'],
  ['review', 'Conflicts', 'search'],
  ['onboarding', 'Onboarding', 'users'],
  ['history', 'Troubleshooting history', 'clock'],
]

export function ProjectDetailPage() {
  const { projectId } = useParams()
  const { projects } = useWorkspace()
  const { session } = useAuth()
  const [modal, setModal] = useState(null)
  const [repoKey, setRepoKey] = useState(0)
  const [activityKey, setActivityKey] = useState(0)
  const [linkedIds, setLinkedIds] = useState([])
  const [connections, setConnections] = useState([])
  const [repositoryResult, setRepositoryResult] = useState(null)
  const [myOnboarding, setMyOnboarding] = useState(null)
  const [onboardingKey, setOnboardingKey] = useState(0)
  const [searchParams, setSearchParams] = useSearchParams()
  const project = projects.find(project => project.id === projectId)
  const section = projectSections.some(([key]) => key === searchParams.get('section')) ? searchParams.get('section') : 'overview'

  useEffect(() => {
    if (!projectId) return
    const controller = new AbortController()
    getMyOnboarding(projectId, controller.signal)
      .then(res => setMyOnboarding(res?.assignment || null))
      .catch(() => setMyOnboarding(null))
    return () => controller.abort()
  }, [projectId, onboardingKey])

  useEffect(() => {
    const controller = new AbortController()
    listProjectRepositories(projectId, controller.signal).then(data => {
      const rows = data.integrations?.github || []
      setConnections(rows)
      setLinkedIds(rows.map(row => row.repository.id))
      setRepositoryResult({ projectId, error: '' })
    }).catch(failure => {
      if (failure.name !== 'AbortError') setRepositoryResult({ projectId, error: failure.message })
    })
    return () => controller.abort()
  }, [projectId, repoKey, activityKey])

  if (!project) return <EmptyState title="Project not found." description="This project may not be available to your account."/>
  if (project.loadError) return <p className="ws-error">{project.loadError}</p>
  const owner = project.ownerId === session.user.id
  const writable = project.myRole !== 'viewer'
  const selectSection = key => setSearchParams(current => {
    const next = new URLSearchParams(current)
    if (key === 'overview') next.delete('section')
    else next.set('section', key)
    return next
  })
  return <div className="project-overview-page">
    <header className="ws-project-head"><div className="ws-ph-crumbs"><Link to="/projects">Projects</Link><span aria-hidden="true">/</span><strong>{project.name}</strong></div><div className="ws-ph-main"><span className="ws-ph-mark" aria-hidden="true">{project.name.charAt(0).toUpperCase()}</span><div className="ws-ph-title"><div><h1>{project.name}</h1><Badge value={project.myRole || 'member'}/></div><p>{project.description || 'A shared place for your work and its context.'}</p></div><div className="po-header-actions"><Link className="ws-button" to={`/calls?project=${project.id}&channel=project-${project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}><Icon name="calls" size={16}/>Start meeting</Link>{owner && <button className="ws-button" onClick={() => setModal('editProject')}><Icon name="edit" size={16}/>Edit project</button>}</div></div></header>
    <div className="ws-project-layout"><nav className="ws-project-nav" aria-label="Project sections">{projectSections.slice(0, 5).map(([key, label, icon]) => <Link key={key} className={section === key ? 'active' : ''} aria-current={section === key ? 'page' : undefined} to={key === 'overview' ? `/projects/${project.id}` : `/projects/${project.id}?section=${key}`}><Icon name={icon} size={18}/><span>{label}</span></Link>)}<details className={`po-more-nav ${projectSections.slice(5).some(([key]) => key === section) ? 'active' : ''}`}><summary>More <span aria-hidden="true">⌄</span></summary><div>{projectSections.slice(5).map(([key, label, icon]) => <Link key={key} aria-current={section === key ? 'page' : undefined} to={`/projects/${project.id}?section=${key}`} onClick={event => event.currentTarget.closest('details').removeAttribute('open')}><Icon name={icon} size={16}/>{label}</Link>)}</div></details></nav><div className="ws-project-section">{section === 'overview' && <><ProjectOverview project={project} writable={writable} onSection={selectSection} onTask={() => setModal('task')}/>{myOnboarding && myOnboarding.status !== 'completed' && <Link className="po-onboarding-link" to={`/projects/${project.id}/onboarding`}>Your onboarding briefing is ready. Open briefing →</Link>}</>}{section === 'review' && <ConflictDetectionPanel projectId={project.id} canManage={writable}/>} {section === 'onboarding' && <ProjectOnboardingSection projectId={project.id} projectName={project.name} isOwner={owner} refreshKey={onboardingKey}/>} {section === 'history' && <TroubleshootingHistory project={project}/>}{section === 'ask' && <><ProjectChat key={`chat:${project.id}`} projectId={project.id}/></>}{section === 'tree' && <><ProjectWorkTree key={project.id} projectId={project.id}/></>}{section === 'connections' && <><ConnectedRepositories projectId={project.id} canManage={owner} canSync={writable} refreshKey={repoKey} onLoaded={setLinkedIds} onConnections={setConnections} onSynced={() => setActivityKey(key => key + 1)} onAdd={() => setModal('repository')}/>{linkedIds.length > 0 && <RepositoryActivity projectId={project.id} refreshKey={`${repoKey}:${activityKey}`}/>}<ConnectedSlackChannels projectId={project.id} canManage={owner} canSync={writable}/><ConnectedJiraProjects projectId={project.id} canManage={owner} canSync={writable}/><ConnectedNotionPages projectId={project.id} canManage={owner} canSync={writable}/><ProjectDocuments projectId={project.id} canUpload={writable} isOwner={owner} userId={session.user.id}/></>}{section === 'teams' && <TeamsSection project={project} canManage={owner}/>}{section === 'handoff' && <><OwnershipTimeline projectId={project.id} refreshKey={project.ownerId}/>{repositoryResult?.projectId !== projectId ? <p className="ws-muted" role="status">Loading project sources…</p> : repositoryResult.error ? <div className="ws-error" role="alert">{repositoryResult.error} <button className="ws-text-button" onClick={() => setRepoKey(key => key + 1)}>Retry loading sources</button></div> : <AiProjectContext project={project} userId={session.user.id} connections={connections}/>}<section className="ws-panel"><div className="ws-section-heading"><div><h2>Handoff history</h2><p>A clear record of who’s taking the work forward.</p></div>{owner && !project.handoffs.some(h => h.isOpen) && <button className="ws-text-button" onClick={() => setModal('handoff')}>+ New handoff</button>}</div>{project.handoffs.length ? <div className="ws-project-grid">{project.handoffs.map(handoff => <HandoffCard key={handoff.id} handoff={handoff}/>)}</div> : <p className="ws-panel-empty">No handoffs yet. Add a teammate when you’re ready to transfer ownership.</p>}</section></>}{section === 'team' && <><div className="ws-project-detail-grid"><section className="ws-panel"><div className="ws-section-heading"><h2>Tasks <span className="ws-count">{project.tasks.length}</span></h2>{writable && <button className="ws-text-button" onClick={() => setModal('task')}>+ New task</button>}</div>{project.tasks.length ? <TaskList tasks={project.tasks}/> : <p className="ws-panel-empty">Add the first task to start moving forward.</p>}</section><section className="ws-panel"><div className="ws-section-heading"><h2>Your team</h2>{owner && <button className="ws-text-button" onClick={() => setModal('member')}>+ Add teammate</button>}</div><div className="ws-members">{project.context.members.map(member => <div key={member.userId}><span className="ws-user-avatar">{member.name.charAt(0).toUpperCase()}</span><span><strong>{member.name}</strong><small>{member.email}</small></span><Badge value={member.role}/></div>)}</div>{owner && <ProjectInvitations key={`${String(modal)}:${onboardingKey}`} projectId={project.id}/>}</section></div></>}</div></div>{modal && <WorkspaceModal kind={modal} projectId={project.id} excludeRepositoryIds={linkedIds} onClose={() => { setRepoKey(key => key + 1); setOnboardingKey(key => key + 1); setModal(null) }}/>}</div>

}
