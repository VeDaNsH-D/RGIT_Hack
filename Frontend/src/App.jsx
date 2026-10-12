import { useRef, useState } from 'react'
import { TeamIllustration, GoalIllustration, WorkflowIllustration } from './components/Illustrations'
import Features from './components/Features'
import Integrations from './components/Integrations'
import TestimonialsFaq from './components/TestimonialsFaq'
import ClosingSection from './components/ClosingSection'
import './App.css'

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
      <a className="brand" href="/" aria-label="Selecto home">
        <span className="brand-symbol" aria-hidden="true"><span>✳</span></span>
        <span>selecto</span>
      </a>
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
        <button className="signup" onClick={() => openPanel('Sign up')}>Sign up</button>
        <button className="button button-black" onClick={() => openPanel('Get started')}>Get started</button>
      </div>
    </header>
  )
}

function SignupForm() {
  const [submitted, setSubmitted] = useState(false)

  function handleSubmit(event) {
    event.preventDefault()
    const email = new FormData(event.currentTarget).get('email')
    localStorage.setItem('selecto-interest', email)
    setSubmitted(true)
  }

  if (submitted) {
    return (
      <>
        <span className="eyebrow">YOU’RE ON THE LIST</span>
        <h2 id="dialog-title">Thanks for joining.</h2>
        <p>Your interest is saved on this device. Selecto’s signup service isn’t connected yet.</p>
      </>
    )
  }

  return (
    <>
      <span className="eyebrow">LET’S WORK TOGETHER</span>
      <h2 id="dialog-title">Your team’s next chapter.</h2>
      <p>Leave your email to register your interest in Selecto.</p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="email">Work email</label>
        <input id="email" name="email" type="email" placeholder="you@company.com" required autoComplete="email" />
        <button className="button button-blue" type="submit">Join the interest list</button>
      </form>
    </>
  )
}

function App() {
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
          <button className="button button-blue button-orange" onClick={() => openPanel('Try Selecto for free')}>
            Try Selecto for free
          </button>
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
            <button className="button button-blue" onClick={() => openPanel('Get started')}>Get started</button>
          </>
        ) : <SignupForm key={panel} />}
      </dialog>
    </main>
  )
}

export default App
