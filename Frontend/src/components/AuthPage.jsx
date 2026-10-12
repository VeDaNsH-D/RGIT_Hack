import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import AuthForm from './AuthForm'
import Workflow from './Workflow'
import ContinuityBranch from './ContinuityBranch'
import BrandIcon from './BrandIcon'
import './AuthPage.css'

export default function AuthPage({ mode }) {
  const { session, acceptSession, checking, error } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const signup = mode === 'register'
  const requestedDestination = location.state?.from
  const destination = /^\/(?:dashboard|projects|tasks|handoffs|emails|invite|mcp)(?:\/|\?|#|$)/.test(requestedDestination || '') ? requestedDestination : '/dashboard'

  if (checking) return <div className="ws-loading ws-full-screen" role="status"><span className="ws-spinner"/>Checking your session…</div>
  if (session && !error) return <Navigate to={destination} replace />

  function authenticated(value) {
    acceptSession(value)
    navigate(destination, { replace: true })
  }

  function switchMode(next) {
    navigate(next === 'login' ? '/signin' : '/signup', { state: location.state })
  }

  return (
    <div className="auth-page">
      <div className="page-shell">
        <header>
          <Link className="brand" to="/" aria-label="Over2u home">
            <BrandIcon />Over2u<span className="brand-dot">.</span>
          </Link>
          <span className="header-note">Good work deserves a seamless handoff.</span>
          <Link className="header-signin" to={signup ? '/signin' : '/signup'} state={location.state}>
            {signup ? 'Sign in' : 'Create an account'} ↗
          </Link>
        </header>
        <main className="signup-layout">
          <section className="hero-copy">
            <div className="eyebrow"><i /> CONTEXT GOES WITH YOU</div>
            <h1>Never lose context.<br />Never miss<br className="desktop-break" /> a handoff<span>.</span></h1>
            <p className="hero-description">Over2u brings cases, decisions, tasks, and AI-powered insights together so every handoff starts with the context your team needs.</p>
            <div className="continuity-section">
              <ContinuityBranch />
              <div className="feature">
                <span className="feature-icon" aria-hidden="true">⇄</span>
                <div>
                  <h2>Built for Team Continuity</h2>
                  <p>Keep ownership clear, preserve critical knowledge, and move work forward without starting from scratch.</p>
                  <Link to="/#features">Discover how Over2u works →</Link>
                </div>
              </div>
            </div>
          </section>
          <Workflow />
          <section className="form-panel" aria-label="Over2u account">
            <AuthForm key={mode} mode={mode} onSwitch={switchMode} onAuthenticated={authenticated} />
          </section>
        </main>
        <footer>
          <span>© {new Date().getFullYear()} Over2u</span>
          <span>A little less friction. A lot more continuity.</span>
          <span className="footer-status">● Built to keep work moving</span>
        </footer>
      </div>
    </div>
  )
}
