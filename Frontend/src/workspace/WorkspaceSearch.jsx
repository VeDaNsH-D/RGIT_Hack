import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './ui'
import { useWorkspace } from './WorkspaceContext'
export default function WorkspaceSearch() {
  const { projects, tasks } = useWorkspace()
  const dialog = useRef(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    const open = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (!dialog.current.open) dialog.current.showModal()
      }
    }
    window.addEventListener('keydown', open)
    return () => window.removeEventListener('keydown', open)
  }, [])
  const term = query.trim().toLowerCase()
  const results = [
    ...projects.filter(project => !term || project.name.toLowerCase().includes(term)).map(project => ({ id: `p:${project.id}`, title: project.name, type: 'Project', url: `/projects/${project.id}` })),
    ...(term ? tasks.filter(task => task.title.toLowerCase().includes(term)).map(task => ({ id: `t:${task.id}`, title: task.title, type: 'Task', url: `/projects/${task.projectId}?section=team` })) : []),
  ].slice(0, 12)
  return <><button className="ws-search-trigger" aria-label="Search projects and tasks" onClick={() => dialog.current.showModal()}><Icon name="search" size={18}/><span>Search projects & tasks…</span><kbd>⌘ K</kbd></button><dialog ref={dialog} className="ws-search-dialog" aria-labelledby="ws-search-title"><div className="ws-search-dialog-heading"><h2 id="ws-search-title">Search your workspace</h2><button aria-label="Close search" onClick={() => dialog.current.close()}>×</button></div><label className="pd-sr-only" htmlFor="ws-search-input">Search projects and tasks</label><input id="ws-search-input" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a project or task…"/><div className="ws-search-results">{results.length ? results.map(result => <Link key={result.id} to={result.url} onClick={() => dialog.current.close()}><strong>{result.title}</strong><small>{result.type}</small></Link>) : <p>No matching projects or tasks.</p>}</div></dialog></>
}
