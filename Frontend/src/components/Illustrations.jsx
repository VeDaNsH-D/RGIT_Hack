import { useEffect, useRef } from 'react'
import './Illustrations.css'

// Reveal each drawing once it enters the viewport, including on small screens.
function useDrawingReveal() {
  const ref = useRef(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (!('IntersectionObserver' in window)) {
      element.classList.add('is-drawn')
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        element.classList.add('is-drawn')
        observer.disconnect()
      }
    }, { threshold: 0.2 })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return ref
}

// These are DOM elements styled with CSS, rather than a screenshot of the UI.
function OutlineBar({ className = '' }) {
  return <span className={`outline-bar ${className}`} />
}

function Avatar({ variant }) {
  return (
    <span className={`avatar avatar-${variant}`}>
      <span className="avatar-body" />
      <span className="avatar-hair" />
      <span className="avatar-face">
        <span className="avatar-eyes" />
        <span className="avatar-smile" />
      </span>
    </span>
  )
}

export function TeamIllustration() {
  const drawingRef = useDrawingReveal()
  return (
    <div ref={drawingRef} className="team-art drawing-art" aria-hidden="true">
      <div className="team-rail" />
      <span className="team-node team-node-top" />
      <span className="team-node team-node-bottom" />
      <div className="team-panel">
        <div className="team-panel-toolbar">
          <OutlineBar />
          <OutlineBar className="short-bar" />
        </div>
        <div className="avatars">
          <Avatar variant="yellow" />
          <Avatar variant="green" />
          <Avatar variant="blue" />
        </div>
        <div className="team-task-panel">
          <div className="team-task-toolbar">
            <OutlineBar />
            <OutlineBar className="short-bar" />
          </div>
          <OutlineBar className="task-line-one" />
          <OutlineBar className="task-line-two" />
        </div>
      </div>
      {/* Only the freeform decorative ribbon uses a vector path. */}
      <svg className="team-ribbon" viewBox="0 0 570 310" fill="none">
        <defs>
          <linearGradient id="team-ribbon-color" x1="70" y1="90" x2="535" y2="225" gradientUnits="userSpaceOnUse">
            <stop stopColor="#ffd2a6" />
            <stop offset=".5" stopColor="#ff3c0a" />
            <stop offset="1" stopColor="#8c210b" />
          </linearGradient>
        </defs>
        <path className="ribbon-draw-stroke" pathLength="1" d="M21 84C170 -24 237 -10 153 199L112 275C195 183 302 132 343 173C377 207 306 261 366 247C439 233 470 209 542 206" stroke="url(#team-ribbon-color)" strokeWidth="37" strokeLinejoin="round" />
      </svg>
      <span className="team-start-node"><span className="asterisk">✳</span></span>
    </div>
  )
}

export function GoalIllustration() {
  const drawingRef = useDrawingReveal()
  return (
    <div ref={drawingRef} className="path-art drawing-art" aria-hidden="true">
      <span className="goal-node goal-node-one" />
      <span className="goal-node goal-node-two" />
      <span className="goal-node goal-node-three" />
      <span className="goal-node goal-node-four" />
      <div className="goal-rail"><span className="goal-check"><span /></span></div>
      <svg className="goal-curve" viewBox="0 0 400 255" fill="none">
        <defs>
          <linearGradient id="goal-curve-color" x1="70" y1="180" x2="212" y2="43" gradientUnits="userSpaceOnUse">
            <stop stopColor="#ffd2a6" /><stop offset=".55" stopColor="#ff3c0a" /><stop offset="1" stopColor="#8c210b" />
          </linearGradient>
        </defs>
        <path className="ribbon-draw-stroke" pathLength="1" d="M35 219C115 208 102 161 117 120C132 80 159 44 214 44" stroke="url(#goal-curve-color)" strokeWidth="36" />
      </svg>
      <span className="goal-gradient-line" />
    </div>
  )
}

function TaskIcon({ type }) {
  return <span className={`task-icon task-icon-${type}`}>
    {type === 'code' ? <span>‹/›</span> : type === 'search' ? <><span className="document-lines" /><span className="search-lens" /></> : <><span className="flow-square" /><span className="flow-square" /></>}
  </span>
}

const workflowTasks = [
  { color: 'yellow', icon: 'search', lines: 1 },
  { color: 'green', icon: 'flow', lines: 2 },
  { color: 'blue', icon: 'code', lines: 1 },
]

export function WorkflowIllustration() {
  const drawingRef = useDrawingReveal()
  return (
    <div ref={drawingRef} className="workflow-art drawing-art" aria-hidden="true">
      <div className="workflow-panel">
        <div className="workflow-toolbar">
          <OutlineBar /><OutlineBar /><OutlineBar />
        </div>
        <span className="workflow-connector connector-right" />
        <span className="workflow-connector connector-left" />
        {workflowTasks.map(task => (
          <div className={`workflow-task workflow-task-${task.color}`} key={task.color}>
            <TaskIcon type={task.icon} />
            <span className="task-bars">
              {Array.from({ length: task.lines }, (_, index) => <OutlineBar key={index} />)}
            </span>
            <OutlineBar className="task-status" />
          </div>
        ))}
      </div>
    </div>
  )
}
