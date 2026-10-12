import { Link } from 'react-router-dom'

export function Icon({ name, size = 20 }) {
  const paths = {
    emails: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></>,
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    projects: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>,
    tasks: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 9 2 2 5-5m-7 10h8"/></>,
    handoffs: <><path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
    logout: <><path d="M9 4H4v16h5M9 12h12m-5-5 5 5-5 5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.projects}</svg>
}

export function Badge({ value }) { return <span className={`ws-badge ws-badge-${value?.toLowerCase()}`}>{value?.replaceAll('_', ' ').toLowerCase()}</span> }
export function EmptyState({ title, description, action, onAction }) {
  return <div className="ws-empty"><span className="ws-empty-icon"><Icon name="projects" size={28}/></span><h3>{title}</h3><p>{description}</p>{action && <button className="ws-button ws-button-primary" onClick={onAction}><Icon name="plus" size={16}/>{action}</button>}</div>
}
export function PageHeading({ eyebrow, title, description, action, onAction }) {
  return <div className="ws-page-heading"><div><span className="ws-eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action && <button className="ws-button ws-button-primary" onClick={onAction}><Icon name="plus" size={17}/>{action}</button>}</div>
}
export function ProjectCard({ project }) {
  const completed = project.tasks.filter(task => task.status === 'completed').length
  const progress = project.tasks.length ? Math.round(completed / project.tasks.length * 100) : 0
  return <Link className="ws-project-card" to={`/projects/${project.id}`}><div className="ws-project-card-top"><span className="ws-project-symbol"><Icon name="projects"/></span><Badge value={project.myRole}/></div><h3>{project.name}</h3><p>{project.description || 'Bring your team’s context, tasks, and next steps together.'}</p><div className="ws-project-progress"><span>Task progress</span><strong>{progress}%</strong></div><div className="ws-progress-track"><span style={{ width: `${progress}%` }}/></div><div className="ws-project-card-bottom"><span>{project.tasks.length} tasks · {project.context?.members.length || 0} members</span><Icon name="arrow" size={18}/></div>{project.loadError && <span className="ws-inline-error">Project details couldn’t load.</span>}</Link>
}
