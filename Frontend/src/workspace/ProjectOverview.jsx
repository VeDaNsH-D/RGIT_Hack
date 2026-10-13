import { Badge, Icon } from './ui'
import { formatDate } from './utils'
import './projectOverview.css'
export default function ProjectOverview({ project, writable, onSection, onTask }) {
  const open = project.tasks.filter(task => task.status === 'open')
  const completed = project.tasks.filter(task => task.status === 'completed').length
  const overdue = open.filter(task => task.deadline && new Date(task.deadline) < new Date()).length
  const activeHandoffs = project.handoffs.filter(handoff => handoff.isOpen)
  const priority = { critical: 4, high: 3, medium: 2, low: 1 }
  const nextTasks = [...open].sort((a, b) => {
    const late = task => Boolean(task.deadline && new Date(task.deadline) < new Date())
    return Number(late(b)) - Number(late(a)) || (priority[b.priority] || 0) - (priority[a.priority] || 0)
  }).slice(0, 3)
  return <div className="po-simple">
    <div className="po-status-line"><span><strong>{open.length}</strong> open tasks</span><span><strong>{completed}</strong> completed</span><button onClick={() => onSection('team')}><strong>{project.context.members.length}</strong> team members</button>{overdue > 0 && <button className="po-status-warning" onClick={() => onSection('team')}>{overdue} overdue</button>}</div>
    <section className="po-task-panel" aria-labelledby="po-next-tasks"><div className="po-task-heading"><div><h2 id="po-next-tasks">What’s next</h2><p>Your top priorities, starting with overdue work.</p></div>{writable && <button className="ws-button ws-button-primary" onClick={onTask}><Icon name="plus" size={16}/>Add task</button>}</div>
      {nextTasks.length ? <ul className="po-task-preview">{nextTasks.map(task => <li key={task.id}><button onClick={() => onSection('team')} aria-label={`Open tasks to view ${task.title}`}><span className="po-task-dot" aria-hidden="true"/><span className="po-task-preview-title">{task.title}</span><Badge value={task.priority}/><span className="po-task-preview-date">{task.deadline ? formatDate(task.deadline) : 'No due date'}</span><Icon name="arrow" size={16}/></button></li>)}</ul> : <div className="po-simple-empty"><Icon name={project.tasks.length ? 'check' : 'tasks'} size={24}/><strong>{project.tasks.length ? 'All tasks completed.' : 'No tasks yet.'}</strong><p>{project.tasks.length ? 'You’re ready for the next step.' : 'Add a task to get started.'}</p></div>}
      {project.tasks.length > 0 && <button className="ws-text-button po-all-tasks" onClick={() => onSection('team')}>View all {project.tasks.length} tasks →</button>}
    </section>
    <section className="po-quick-access" aria-labelledby="po-quick-access"><h2 id="po-quick-access">Explore your project</h2><div className="po-launchpad">{[{ section: 'ask', icon: 'chat', title: 'Ask your project' }, { section: 'connections', icon: 'connections', title: 'Connect sources' }, { section: 'handoff', icon: 'handoffs', title: 'Prepare a handoff' }].map(action => <button key={action.section} onClick={() => onSection(action.section)}><span className="po-launchpad-icon"><Icon name={action.icon} size={20}/></span><span><strong>{action.title}</strong></span><Icon name="arrow" size={16}/></button>)}</div></section>
    {activeHandoffs.length > 0 && <div className="po-simple-handoff"><Icon name="handoffs" size={18}/><span>A handoff is in progress.</span><button className="ws-text-button" onClick={() => onSection('handoff')}>Review →</button></div>}
  </div>
}
