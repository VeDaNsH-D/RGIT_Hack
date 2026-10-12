import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { TeamIllustration, GoalIllustration, WorkflowIllustration } from '../components/Illustrations'
import Features from '../components/Features'
import Integrations from '../components/Integrations'
import TestimonialsFaq from '../components/TestimonialsFaq'
import ClosingSection from '../components/ClosingSection'
import '../App.css'

const details = {
  Product: {
    title: 'Make room for great teamwork.',
    body: 'Set goals, prioritize your work, and bring everyone together in one shared space.',
  },
  Features: {
    title: 'Everything moves together.',
    body: 'Organize tasks, assign teammates, and follow your team’s progress from the first idea to the final checkmark.',
  },
  Pricing: {
    title: 'Start with your team.',
    body: 'Try Selecto for free. Plan details will be available when Selecto launches.',
  },
  Company: {
    title: 'Selecto is all about the team.',
    body: 'A simpler way to bring people, priorities, and projects together.',
  },
}

function Header({ onOpen }) {
  const [menu, setMenu] = useState(null)

  function openPanel(name) {
    setMenu(null)
    onOpen(name)
  }

  return (
    <header className="header">
      <Link className="brand" to="/" aria-label="Selecto home">
        <span className="brand-symbol" aria-hidden="true"><span>✳</span></span>
        <span>selecto</span>
      </Link>
      <nav className="navigation" aria-label="Main navigation">
        {['Product', 'Features'].map(name => (
          <div className="nav-item" key={name}>
            <button
              className="nav-link"
              aria-expanded={menu === name}
              aria-controls={`menu-${name.toLowerCase()}`}
              onClick={() => setMenu(menu === name ? null : name)}
              onKeyDown={event => { if (event.key === 'Escape') setMenu(null) }}
            >
              {name}<span className="nav-chevron" aria-hidden="true" />
            </button>
            {menu === name && (
              <div className="dropdown" id={`menu-${name.toLowerCase()}`}>
                <strong>{details[name].title}</strong>
                <p>{details[name].body}</p>
                <button onClick={() => openPanel(name)}>
                  Explore {name.toLowerCase()} <span aria-hidden="true">↗</span>
                </button>
              </div>
            )}
          </div>
        ))}
        {['Pricing', 'Company'].map(name => (
          <button className="nav-link" key={name} onClick={() => openPanel(name)}>{name}</button>
        ))}
      </nav>
      <div className="header-actions">
        <Link className="signup" to="/signup">Sign up</Link>
        <Link className="button button-black" to="/signup">Get started</Link>
      </div>
    </header>
  )
}

export default function LandingPage() {
  const [panel, setPanel] = useState(null)
  const dialog = useRef(null)

  function openPanel(name) {
    setPanel(name)
    if (!dialog.current.open) dialog.current.showModal()
  }

  function closeOnBackdrop(event) {
    if (event.target === event.currentTarget) dialog.current.close()
  }

  return (
    <main className="landing">
      <Header onOpen={openPanel} />
      <section className="hero" aria-labelledby="hero-title">
        <TeamIllustration />
        <h1 id="hero-title">
          <span>the handiest</span>
          <span>way to organize</span>
          <span>teamwork</span>
        </h1>
      </section>
      <section className="bottom" aria-label="Organize your team with Selecto">
        <div className="intro">
          <p>
            Selecto is all about the team.<br />
            Set goals and prioritize them,<br />
            assign people to tasks, and<br />
            get things done in time.
          </p>
          <Link className="button button-blue button-orange" to="/signup">
            Try Selecto for free
          </Link>
        </div>
        <GoalIllustration />
        <WorkflowIllustration />
      </section>
      <Features />
      <Integrations />
      <TestimonialsFaq />
      <ClosingSection />
      <dialog ref={dialog} className="modal" aria-labelledby="dialog-title" onClick={closeOnBackdrop}>
        <button className="close-modal" aria-label="Close dialog" onClick={() => dialog.current.close()}>×</button>
        {details[panel] ? (
          <>
            <span className="eyebrow">selecto / {panel.toLowerCase()}</span>
            <h2 id="dialog-title">{details[panel].title}</h2>
            <p>{details[panel].body}</p>
            <Link className="button button-blue" to="/signup">Get started</Link>
          </>
        ) : null}
      </dialog>
    </main>
  )
}

