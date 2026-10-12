import { NavLink, Outlet, Link, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import WorkspaceProvider from './WorkspaceProvider'
import { useWorkspace } from './WorkspaceContext'
import { Icon } from './ui'
import NotificationBell from './NotificationBell'
import './workspace.css'

function Shell() {
  const { session, signOut } = useAuth()
  const { loading, error, reload, projects } = useWorkspace()
  const { pathname } = useLocation()
  const section = pathname.split('/')[1]
  const name = session.user.name || 'Teammate'
  return <div className="ws-app">
    <aside className="ws-sidebar">
      <Link className="ws-brand" to="/dashboard"><span>↗</span>Over2u<span className="ws-brand-dot">.</span></Link>
      <div className="ws-workspace-name"><span className="ws-workspace-avatar">{name.charAt(0).toUpperCase()}</span><div><strong>Your workspace</strong><span>Make work flow.</span></div></div>
      <span className="ws-nav-label">WORKSPACE</span>
      <nav aria-label="Workspace navigation">{['dashboard', 'projects', 'tasks', 'handoffs', 'emails', 'calls', 'connections'].map(route => <NavLink className={({ isActive }) => `ws-nav-link ${isActive ? 'active' : ''}`} to={`/${route}`} key={route}><Icon name={route}/><span>{route === 'dashboard' ? 'Overview' : route.charAt(0).toUpperCase() + route.slice(1)}</span>{route === 'projects' && projects.length > 0 && <small>{projects.length}</small>}</NavLink>)}</nav>

      <div className="ws-sidebar-note"><span>✳</span><h3>Good work carries on.</h3><p>Keep the next person in the loop, before you pass the baton.</p><Link to="/handoffs">Explore handoffs <Icon name="arrow" size={16}/></Link></div>
      <div className="ws-sidebar-bottom"><Link to="/">← Back to website</Link><button onClick={signOut}><Icon name="logout" size={17}/>Sign out</button></div>
    </aside>
    <div className="ws-main">
      <header className="ws-topbar"><span>Workspace <span className="ws-breadcrumb-slash">/</span> <strong>{section === 'dashboard' ? 'Overview' : section.charAt(0).toUpperCase() + section.slice(1)}</strong></span><div><span className="ws-topbar-status"><i/>Connected workspace</span><NotificationBell/><span className="ws-user-avatar" title={name}>{name.charAt(0).toUpperCase()}</span></div></header>
      <main className="ws-content">
        {loading ? <div className="ws-loading" role="status"><span className="ws-spinner"/>Bringing your workspace together…</div> : error ? <div className="ws-error-panel" role="alert"><h2>Let’s reconnect.</h2><p>{error}</p><button className="ws-button ws-button-primary" onClick={() => reload()}>Try again</button></div> : <>{projects.some(project => project.loadError) && <div className="ws-warning" role="status">Some project details couldn’t load. <button onClick={() => reload()}>Retry</button></div>}<Outlet/></>}
      </main>
    </div>
  </div>
}

export default function WorkspaceLayout() {
  const { session, checking, error, retry } = useAuth()
  const location = useLocation()
  if (checking) return <div className="ws-loading ws-full-screen" role="status"><span className="ws-spinner"/>Checking your session…</div>
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }}/>
  if (error) return <div className="ws-error-panel ws-full-screen"><h2>Couldn’t verify your session.</h2><p>{error}</p><button className="ws-button ws-button-primary" onClick={retry}>Try again</button></div>
  return <WorkspaceProvider key={session.user.id}><Shell/></WorkspaceProvider>
}
