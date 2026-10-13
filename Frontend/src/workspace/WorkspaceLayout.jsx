import WorkspaceSearch from './WorkspaceSearch'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { NavLink, Outlet, Link, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import WorkspaceProvider from './WorkspaceProvider'
import { useWorkspace } from './WorkspaceContext'
import { Icon } from './ui'
import NotificationBell from './NotificationBell'
import './workspace.css'

function ProfileMenu({ name, onSignOut }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = event => { if (!ref.current?.contains(event.target)) setOpen(false) }
    const esc = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  return <div className="ws-profile" ref={ref}>
    <button className="ws-user-avatar ws-profile-button" title={name} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{name.charAt(0).toUpperCase()}</button>
    {open && <div className="ws-profile-menu" role="menu">
      <span className="ws-profile-card"><span className="ws-user-avatar ws-profile-large">{name.charAt(0).toUpperCase()}</span><strong>{name}</strong></span>
      <Link role="menuitem" to="/settings" onClick={() => setOpen(false)}>Settings</Link>
      <hr />
      <button role="menuitem" onClick={onSignOut}>Sign Out</button>
    </div>}
  </div>
}

function subscribeToPageScroll(onChange) {
  window.addEventListener('scroll', onChange, { passive: true })
  return () => window.removeEventListener('scroll', onChange)
}
const isPageScrolled = () => window.scrollY > 48
const initialScrollState = () => false

function Shell() {
  const scrolled = useSyncExternalStore(subscribeToPageScroll, isPageScrolled, initialScrollState)
  const { session, signOut } = useAuth()
  const { loading, error, reload, projects } = useWorkspace()
  const name = session.user.name || 'Teammate'
  return <div className="ws-app ws-app-top">
    <header className={`ws-topnav${scrolled ? ' ws-topnav-scrolled' : ''}`}>
      <Link className="ws-brand" to="/dashboard"><span>↗</span>Over2u<span className="ws-brand-dot">.</span></Link>
      <nav aria-label="Workspace navigation">{['dashboard', 'projects', 'emails', 'connections'].map(route => <NavLink className={({ isActive }) => `ws-nav-link ${isActive ? 'active' : ''}`} to={`/${route}`} key={route}><Icon name={route}/><span>{route === 'dashboard' ? 'Overview' : route.charAt(0).toUpperCase() + route.slice(1)}</span>{route === 'projects' && projects.length > 0 && <small>{projects.length}</small>}</NavLink>)}</nav>
      <div className="ws-topnav-actions"><WorkspaceSearch/><NotificationBell/><ProfileMenu name={name} onSignOut={signOut}/></div>
    </header>
    <div className="ws-main">
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
