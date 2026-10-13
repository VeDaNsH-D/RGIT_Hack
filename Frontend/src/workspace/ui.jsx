import { Link } from 'react-router-dom'

export function Icon({ name, size = 20 }) {
  const paths = {
    emails: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></>,
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    projects: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>,
    tasks: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 9 2 2 5-5m-7 10h8"/></>,
    handoffs: <><path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
    logout: <><path d="M9 4H4v16h5M9 12h12m-5-5 5 5-5 5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    connections: <path d="M9 3v5m6-5v5M7 8h10v4a5 5 0 0 1-10 0V8Zm5 9v4"/>,
    github: <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a13.4 13.4 0 0 0-6.2 0C6.6 2.8 5.5 3.1 5.5 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.1 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>,
    slack: <path d="M9 3v8M3 9h8M15 21v-8M21 15h-8M3 15h8v6M21 9h-8V3"/>,
    whatsapp: <><path d="m3 21 1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z"/><path d="M9.5 9.5c.3 1.5 1.5 2.7 3 3l1.5-1.5"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></>,
    notion: <><path d="M5 5a2 2 0 0 1 2-2h8l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5Z"/><path d="M9 16V8l6 8V8"/></>,
    jira: <><path d="m12 3 8 8-8 8-8-8 8-8Z"/><path d="m12 8 3 3-3 3-3-3 3-3Z"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
    calls: <><path d="m15 10 5-3v10l-5-3v-4Z"/><rect x="2" y="6" width="13" height="12" rx="2"/></>,
    mic: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></>,
    micOff: <><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 11.22 5.56M15 9.34V5a3 3 0 0 0-5.68-1.33M9 9v3a3 3 0 0 0 5.12 2.12M12 19v3M8 22h8"/></>,
    camera: <><path d="m15 10 5-3v10l-5-3v-4Z"/><rect x="2" y="6" width="13" height="12" rx="2"/></>,
    cameraOff: <><line x1="2" y1="2" x2="22" y2="22"/><path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 7v10l-3.34-2M2 9.34V16a2 2 0 0 0 2 2h10.66"/></>,
    screenShare: <><rect x="2" y="3" width="20" height="14" rx="2"/><path d="m8 21 4-4 4 4M12 17v4M12 7v6m-3-3 3-3 3 3"/></>,
    endCall: <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.8 19.8 0 0 1-3.12-8.69 2 2 0 0 1 2-2.18h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.09 9.91"/>,
    captions: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></>,
    sparkles: <path d="m12 3 1.9 4.8L19 9.7l-4.1 3.5 1.3 5.3-4.2-2.8-4.2 2.8 1.3-5.3L5 9.7l5.1-1.9L12 3Z"/>,
    chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.projects}</svg>
}

export function Badge({ value }) { return <span className={`ws-badge ws-badge-${value?.toLowerCase()}`}>{value?.replaceAll('_', ' ').toLowerCase()}</span> }
export function EmptyState({ title, description, action, onAction }) {
  return <div className="ws-empty"><span className="ws-empty-icon"><Icon name="projects" size={28}/></span><h3>{title}</h3><p>{description}</p>{action && <button className="ws-button ws-button-primary" onClick={onAction}><Icon name="plus" size={16}/>{action}</button>}</div>
}
export function PageHeading({ eyebrow, title, description, action, actionIcon = 'plus', onAction, children }) {
  return <div className="ws-page-heading"><div><span className="ws-eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div><div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>{children}{action && <button className="ws-button ws-button-primary" onClick={onAction}><Icon name={actionIcon} size={17}/>{action}</button>}</div></div>
}

export function ProjectCard({ project }) {
  const completed = project.tasks.filter(task => task.status === 'completed').length
  const progress = project.tasks.length ? Math.round(completed / project.tasks.length * 100) : 0
  return <Link className="ws-project-card" to={`/projects/${project.id}`}><div className="ws-project-card-top"><span className="ws-project-symbol"><Icon name="projects"/></span><Badge value={project.myRole}/></div><h3>{project.name}</h3><p>{project.description || 'Bring your team’s context, tasks, and next steps together.'}</p><div className="ws-project-progress"><span>Task progress</span><strong>{progress}%</strong></div><div className="ws-progress-track"><span style={{ width: `${progress}%` }}/></div><div className="ws-project-card-bottom"><span>{project.tasks.length} tasks · {project.context?.members.length || 0} members</span><Icon name="arrow" size={18}/></div>{project.loadError && <span className="ws-inline-error">Project details couldn’t load.</span>}</Link>
}
