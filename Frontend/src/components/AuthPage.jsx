import { useState } from 'react';
import AuthForm from './AuthForm';
import Workflow from './Workflow';
import ContinuityBranch from './ContinuityBranch';
import BrandIcon from './BrandIcon';
import './AuthPage.css';
export default function AuthPage() {
  const [mode, setMode] = useState(window.location.hash === '#signin' || ['/signin', '/login'].includes(window.location.pathname) ? 'login' : 'register');
  const [session, setSession] = useState(null);
  function switchMode(next) {
    setMode(next);
    window.history.replaceState(null, '', next === 'login' ? '#signin' : '#signup');
  }
  return <div className="auth-page"><div className="page-shell"><header><a className="brand" href="#signup" onClick={() => switchMode('register')}><BrandIcon />Over2u<span className="brand-dot">.</span></a><span className="header-note">Good work deserves a seamless handoff.</span><button className="header-signin" onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create an account' : 'Sign in'} ↗</button></header><main className="signup-layout"><section className="hero-copy"><div className="eyebrow"><i /> CONTEXT GOES WITH YOU</div><h1>Never lose context.<br />Never miss<br className="desktop-break" /> a handoff<span>.</span></h1><p className="hero-description">Over2u brings cases, decisions, tasks, and AI-powered insights together so every handoff starts with the context your team needs.</p><div className="continuity-section"><ContinuityBranch /><div className="feature"><span className="feature-icon" aria-hidden="true">⇄</span><div><h2>Built for Team Continuity</h2><p>Keep ownership clear, preserve critical knowledge, and move work forward without starting from scratch.</p><a href="#workflow">Discover how Over2u works →</a></div></div></div></section><Workflow /><section className="form-panel" aria-label="Over2u account">{session ? <div className="success-state" role="status"><span>✓</span><h2>{mode === 'register' ? 'Your account is ready.' : 'Welcome back.'}</h2><p>You’re signed in as <strong>{session.user.name}</strong>. Your Over2u session is active.</p></div> : <AuthForm key={mode} mode={mode} onSwitch={switchMode} onAuthenticated={setSession} />}</section></main><footer><span>© {new Date().getFullYear()} Over2u</span><span>A little less friction. A lot more continuity.</span><span className="footer-status">● Built to keep work moving</span></footer></div></div>;
}
