import { useState } from 'react';
import AuthForm from './components/AuthForm';
import Workflow from './components/Workflow';
import ContinuityBranch from './components/ContinuityBranch';
import BrandIcon from './components/BrandIcon';
import { AgoraRoom } from './components/AgoraRoom';
import './App.css';

export default function App() {
  const [mode, setMode] = useState(window.location.hash === '#signin' ? 'login' : 'register');
  const [session, setSession] = useState(null);
  const [view, setView] = useState('agora'); // Default to 'agora' so Agora communication is immediately visible/testable

  function switchMode(next) {
    setMode(next);
    window.history.replaceState(null, '', next === 'login' ? '#signin' : '#signup');
  }

  return (
    <div className="page-shell">
      <header>
        <a className="brand" href="#signup" onClick={() => switchMode('register')}>
          <BrandIcon />Over2u<span className="brand-dot">.</span>
        </a>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            className="header-signin"
            style={{
              background: view === 'agora' ? '#2563eb' : 'transparent',
              color: view === 'agora' ? '#ffffff' : 'inherit',
              border: '1px solid #3b82f6',
              padding: '0.4rem 0.9rem',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
            onClick={() => setView('agora')}
          >
            📹 Agora Live Call & Chat
          </button>
          <button
            className="header-signin"
            style={{
              background: view === 'auth' ? '#2563eb' : 'transparent',
              color: view === 'auth' ? '#ffffff' : 'inherit',
              border: '1px solid #4b5563',
              padding: '0.4rem 0.9rem',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
            onClick={() => setView('auth')}
          >
            👤 Account & Workflow
          </button>
        </div>
      </header>

      {view === 'agora' ? (
        <main style={{ minHeight: '80vh', padding: '1rem 0' }}>
          <AgoraRoom defaultUserName={session?.user?.name} />
        </main>
      ) : (
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
                  <a href="#workflow">Discover how Over2u works →</a>
                </div>
              </div>
            </div>
          </section>
          <Workflow />
          <section className="form-panel" aria-label="Over2u account">
            {session ? (
              <div className="success-state" role="status">
                <span>✓</span>
                <h2>{mode === 'register' ? 'Your account is ready.' : 'Welcome back.'}</h2>
                <p>You’re signed in as <strong>{session.user.name}</strong>. Your Over2u session is active.</p>
                <button
                  style={{
                    marginTop: '1rem',
                    background: '#2563eb',
                    color: '#fff',
                    border: 'none',
                    padding: '0.6rem 1.2rem',
                    borderRadius: '8px',
                    cursor: 'pointer',
                  }}
                  onClick={() => setView('agora')}
                >
                  Launch Agora Communication Room →
                </button>
              </div>
            ) : (
              <AuthForm key={mode} mode={mode} onSwitch={switchMode} onAuthenticated={setSession} />
            )}
          </section>
        </main>
      )}

      <footer>
        <span>© {new Date().getFullYear()} Over2u</span>
        <span>A little less friction. A lot more continuity.</span>
        <span className="footer-status">● Built to keep work moving</span>
      </footer>
    </div>
  );
}
