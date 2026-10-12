import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getGitHubStatus, startGitHubInstall } from '../api/connections'
import { formatDate } from './utils'
import { Icon, PageHeading } from './ui'
import NotionConnection from './NotionConnection'
import McpConnection from './McpConnection'
import './email.css'

const CATEGORIES = [
  { id: 'ai', title: 'AI & MCP', items: [{ id: 'mcp', name: 'Over2u MCP' }] },
  { id: 'development', title: 'Development', items: [{ id: 'github', name: 'GitHub', description: 'Bring repositories, issues, pull requests, and commits into Relay.', available: true }] },
  { id: 'communication', title: 'Communication', items: [
    { id: 'slack', name: 'Slack', description: 'Bring team discussions and decisions into Relay.' },
    { id: 'mail', name: 'Email', description: 'Keep important conversations and decisions connected to your projects.' },
  ] },
  { id: 'knowledge', title: 'Knowledge & documentation', items: [{ id: 'notion', name: 'Notion', description: 'Connect documentation and shared project knowledge.' }] },
  { id: 'management', title: 'Project management', items: [{ id: 'jira', name: 'Jira', description: 'Bring issues and project tracking into Relay.' }] },
]

const RETURN_MESSAGES = {
  cancelled: 'GitHub installation was cancelled. Nothing was connected.',
  pending: 'Your GitHub organization needs to approve the installation before it can be connected.',
  error: 'We couldn’t verify the GitHub installation. Nothing was connected. Please try again.',
}

function ConnectionCard({ integration, github }) {
  const { id, name, description, available } = integration
  const connected = available && github.status?.connected
  const badge = connected ? 'Connected' : available ? 'Available' : 'Coming soon'
  const notice = available && (github.error || github.message)
  return <article className="ws-connection-card" aria-labelledby={`connection-${id}`}>
    <div className="ws-project-card-top"><span className="ws-project-symbol"><Icon name={id}/></span><span className={`ws-badge ${connected ? 'ws-badge-completed' : available ? 'ws-badge-pending' : ''}`}>{badge}</span></div>
    <h3 id={`connection-${id}`}>{name}</h3>
    <p>{description}</p>
    {connected && github.status.accounts.map(account => <p className="ws-muted" key={account.id}>{`Connected to ${account.login} · ${formatDate(account.connectedAt)}`}</p>)}
    <div className="ws-connection-action">
      {!available ? <span className="ws-muted">Not available yet</span>
        : connected ? <span className="ws-muted">Repositories can be linked to projects once project setup is available.</span>
        : <button className="ws-button ws-button-primary" onClick={github.onConnect} disabled={github.loading || github.starting || github.status?.configured === false}>{github.starting ? 'Opening GitHub…' : 'Connect GitHub'}</button>}
    </div>
    {available && !connected && github.status?.configured === false && <p className="ws-notice" role="status">GitHub integration isn’t configured on this server yet.</p>}
    {notice && <p className={github.error ? 'ws-error' : 'ws-notice'} role={github.error ? 'alert' : 'status'}>{notice}</p>}
  </article>
}

export function ConnectionsView({ github }) {
  return <>
    <PageHeading eyebrow="WORKSPACE" title="Connections" description="Connect your tools to bring your team’s work and context together."/>
    {github.loading && <div className="ws-loading" role="status"><span className="ws-spinner"/>Checking your connections…</div>}
    {!github.loading && CATEGORIES.map(category => <section className="ws-connection-group" key={category.title} aria-labelledby={`group-${category.id}`}>
      <div className="ws-section-heading"><h2 id={`group-${category.id}`}>{category.title}</h2></div>
      <div className="ws-connection-grid">{category.items.map(item => item.id === 'mcp' ? <McpConnection key={item.id}/> : item.id === 'notion' ? <NotionConnection key={item.id}/> : <ConnectionCard key={item.id} integration={item} github={github}/>)}</div>
    </section>)}
  </>
}

export default function ConnectionsPage() {
  const [params, setParams] = useSearchParams()
  const returned = params.get('github')
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  // Read once so the notice survives the URL cleanup below.
  const [message] = useState(() => (returned && returned !== 'connected' ? (RETURN_MESSAGES[returned] || RETURN_MESSAGES.error) + (params.get('reason') ? ` (${params.get('reason')})` : '') : ''))

  useEffect(() => {
    const controller = new AbortController()
    getGitHubStatus(controller.signal)
      .then(data => { setStatus(data); setLoading(false) })
      .catch(failure => { if (failure.name !== 'AbortError') { setError(failure.message); setLoading(false) } })
    return () => controller.abort()
  }, [])
  // Drop the non-sensitive return markers from the URL once read.
  useEffect(() => {
    if (returned) setParams(current => { current.delete('github'); current.delete('reason'); return current }, { replace: true })
  }, [returned, setParams])

  async function onConnect() {
    setStarting(true)
    setError('')
    try {
      const { url } = await startGitHubInstall()
      if (!url?.startsWith('https://github.com/')) throw new Error('GitHub returned an unexpected installation address.')
      window.location.assign(url)
    } catch (failure) {
      setError(failure.message)
      setStarting(false)
    }
  }

  // Success is only ever shown from the backend's status, never from the URL.
  return <ConnectionsView github={{ status, loading, starting, error, message, onConnect }}/>
}
