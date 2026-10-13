import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  getGitHubStatus,
  startGitHubInstall,
  getWhatsAppStatus,
  connectWhatsApp,
  disconnectWhatsApp,
  getJiraStatus,
  startJiraInstall,
  disconnectJira,
  syncJira,
  getSlackStatus,
  startSlackInstall,
  disconnectSlack,
  syncSlack,
  getNotionStatus,
  startNotionInstall,
  connectNotion,
  disconnectNotion,
  syncNotion,
} from '../api/connections'
import { formatDate } from './utils'
import { loadProjectDraft } from './projectDraft'
import { PageHeading } from './ui'
import NotionConnection from './NotionConnection'
import McpConnection from './McpConnection'
import './email.css'
import IntegrationLogo from './IntegrationLogo'
import './connections.css'

const AI_CATEGORY = { id: 'ai', title: 'AI & MCP', items: [{ id: 'mcp', name: 'Over2u MCP' }] }
const DEFAULT_CATEGORIES = [
  {
    id: 'development',
    title: 'Development',
    items: [
      { id: 'github', name: 'GitHub', description: 'Bring repositories, issues, pull requests, and commits into Relay.', available: true },
    ],
  },
  {
    id: 'communication',
    title: 'Communication',
    items: [
      { id: 'slack', name: 'Slack', description: 'Bring team discussions and decisions into Relay.' },
      { id: 'mail', name: 'Email', description: 'Keep important conversations and decisions connected to your projects.' },
    ],
  },
  {
    id: 'knowledge',
    title: 'Knowledge & documentation',
    items: [
      { id: 'notion', name: 'Notion', description: 'Connect documentation and shared project knowledge.' },
    ],
  },
  {
    id: 'management',
    title: 'Project management',
    items: [
      { id: 'jira', name: 'Jira', description: 'Bring issues, epics, and sprint tracking into Relay.' },
    ],
  },
]

function getCategories({ whatsapp, jira, slack, notion } = {}) {
  if (!whatsapp && !jira && !slack && !notion) return DEFAULT_CATEGORIES
  return [
    {
      id: 'development',
      title: 'Development',
      items: [
        { id: 'github', name: 'GitHub', description: 'Bring repositories, issues, pull requests, and commits into Relay.', available: true },
      ],
    },
    {
      id: 'communication',
      title: 'Communication',
      items: [
        ...(whatsapp ? [{ id: 'whatsapp', name: 'WhatsApp', description: 'Receive automatic notifications when warnings, critical conflicts, or SLA breaches occur.', available: true }] : []),
        { id: 'slack', name: 'Slack', description: 'Bring team discussions and decisions into Relay.', available: Boolean(slack) },
        { id: 'mail', name: 'Email', description: 'Keep important conversations and decisions connected to your projects.' },
      ],
    },
    {
      id: 'knowledge',
      title: 'Knowledge & documentation',
      items: [
        { id: 'notion', name: 'Notion', description: 'Connect documentation and shared project knowledge.', available: Boolean(notion) },
      ],
    },
    {
      id: 'management',
      title: 'Project management',
      items: [
        { id: 'jira', name: 'Jira', description: 'Bring issues, epics, and sprint tracking into Relay.', available: Boolean(jira) },
      ],
    },
  ]
}

const RETURN_MESSAGES = {
  cancelled: 'GitHub installation was cancelled. Nothing was connected.',
  pending: 'Your GitHub organization needs to approve the installation before it can be connected.',
  error: 'We couldn’t verify the GitHub installation. Nothing was connected. Please try again.',
}

function ConnectionCard({ integration, github = {}, whatsapp, jira, slack, notion }) {
  const { id, name, description, available } = integration

  if (id === 'whatsapp' && whatsapp) {
    const connected = Boolean(whatsapp.status?.connected)
    const badge = connected ? 'Connected' : 'Available'
    return (
      <article className="ws-connection-card" aria-labelledby={`connection-${id}`}>
        <div className="ws-project-card-top">
          <span className="ws-project-symbol"><IntegrationLogo name={id}/></span>
          <span className={`ws-badge ${connected ? 'ws-badge-completed' : 'ws-badge-pending'}`}>{badge}</span>
        </div>
        <h3 id={`connection-${id}`}>{name}</h3>
        <p>{description}</p>

        {connected ? (
          <>
            <p className="ws-muted" style={{ marginTop: '8px' }}>
              Connected to {whatsapp.status.phone} · {formatDate(whatsapp.status.connectedAt)}
            </p>
            <div className="ws-connection-action" style={{ display: 'grid', gap: '10px' }}>
              <span className="ws-muted">Critical alerts and conflict warnings will be dispatched to this number.</span>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <a
                  className="ws-button"
                  href={whatsapp.status.whatsappUrl || 'https://wa.me/14155238886?text=join%20fear-company'}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in WhatsApp
                </a>
                <button
                  className="ws-button"
                  onClick={whatsapp.onDisconnect}
                  disabled={whatsapp.disconnecting}
                >
                  {whatsapp.disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="ws-connection-action" style={{ display: 'grid', gap: '12px' }}>
            <div style={{ display: 'grid', gap: '6px' }}>
              <label htmlFor="wa-phone-input" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                WhatsApp phone number (with country code)
              </label>
              <input
                id="wa-phone-input"
                type="tel"
                placeholder="+919021875564"
                value={whatsapp.phone}
                onChange={e => whatsapp.setPhone(e.target.value)}
                disabled={whatsapp.connecting}
                style={{
                  border: '1px solid var(--ws-border)',
                  borderRadius: '7px',
                  padding: '9px 12px',
                  fontSize: '12px',
                  color: 'var(--ws-ink)',
                  background: '#fff',
                  outline: 'none',
                  width: '100%',
                }}
              />
            </div>
            <button
              className="ws-button ws-button-primary"
              onClick={whatsapp.onConnect}
              disabled={whatsapp.loading || whatsapp.connecting || !whatsapp.phone.trim()}
            >
              {whatsapp.connecting ? 'Connecting…' : 'Connect WhatsApp'}
            </button>
            <span className="ws-muted" style={{ fontSize: '11px' }}>
              Sends secret code <strong>join fear-company</strong> to <strong>+1 415 523 8886</strong>
            </span>
          </div>
        )}

        {whatsapp.error && <p className="ws-error" role="alert" style={{ marginTop: '12px' }}>{whatsapp.error}</p>}
      </article>
    )
  }

  if (id === 'jira' && jira) {
    const connected = Boolean(jira.status?.connected)
    const badge = connected ? 'Connected' : 'Available'
    return (
      <article className="ws-connection-card" aria-labelledby={`connection-${id}`}>
        <div className="ws-project-card-top">
          <span className="ws-project-symbol"><IntegrationLogo name={id}/></span>
          <span className={`ws-badge ${connected ? 'ws-badge-completed' : 'ws-badge-pending'}`}>{badge}</span>
        </div>
        <h3 id={`connection-${id}`}>{name}</h3>
        <p>{description}</p>

        {connected ? (
          <>
            <p className="ws-muted" style={{ marginTop: '8px' }}>
              Connected to {jira.status.siteName || jira.status.host || 'Jira Cloud'} {jira.status.siteUrl ? `(${jira.status.siteUrl})` : ''} · {formatDate(jira.status.connectedAt)}
            </p>
            <div className="ws-connection-action" style={{ display: 'grid', gap: '10px' }}>
              <span className="ws-muted">
                {jira.status.lastSyncAt
                  ? `Synced ${jira.status.syncedIssueCount || 0} issues · Last sync ${formatDate(jira.status.lastSyncAt)}`
                  : 'Issues, epics, and sprint tracking are ready to sync.'}
              </span>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className="ws-button ws-button-primary"
                  onClick={jira.onSync}
                  disabled={jira.syncing || jira.disconnecting}
                >
                  {jira.syncing ? 'Syncing issues…' : 'Sync issues'}
                </button>
                <button
                  className="ws-button"
                  onClick={jira.onDisconnect}
                  disabled={jira.syncing || jira.disconnecting}
                >
                  {jira.disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="ws-connection-action" style={{ display: 'grid', gap: '10px' }}>
            <button
              className="ws-button ws-button-primary"
              onClick={jira.onConnect}
              disabled={jira.connecting || jira.status?.configured === false}
            >
              {jira.connecting ? 'Opening Atlassian…' : 'Connect Jira'}
            </button>
            <span className="ws-muted" style={{ fontSize: '11px' }}>
              Instantly authorizes your Atlassian account and connects your Jira projects.
            </span>
          </div>
        )}

        {jira.status?.configured === false && !connected && (
          <p className="ws-notice" role="status" style={{ marginTop: '12px' }}>
            Jira OAuth credentials not configured on this server.
          </p>
        )}
        {jira.syncNotice && <p className="ws-notice" role="status" style={{ marginTop: '12px' }}>{jira.syncNotice}</p>}
        {jira.error && <p className="ws-error" role="alert" style={{ marginTop: '12px' }}>{jira.error}</p>}
      </article>
    )
  }

  if (id === 'slack' && slack) {
    const connected = Boolean(slack.status?.connected)
    const badge = connected ? 'Connected' : 'Available'

    return (
      <article className="ws-connection-card" aria-labelledby={`connection-${id}`}>
        <div className="ws-project-card-top">
          <span className="ws-project-symbol"><IntegrationLogo name={id}/></span>
          <span className={`ws-badge ${connected ? 'ws-badge-completed' : 'ws-badge-pending'}`}>{badge}</span>
        </div>
        <h3 id={`connection-${id}`}>{name}</h3>
        <p>{description}</p>

        {connected ? (
          <>
            <p className="ws-muted" style={{ marginTop: '8px' }}>
              Connected to {slack.status.teamName || slack.status.teamDomain || 'Slack Workspace'} {slack.status.channelId ? `(#${slack.status.channelId})` : ''} · {formatDate(slack.status.connectedAt)}
            </p>
            <div className="ws-connection-action" style={{ display: 'grid', gap: '10px' }}>
              <span className="ws-muted">
                {slack.status.lastSyncAt
                  ? `Synced ${slack.status.syncedMessageCount || 0} messages · Last sync ${formatDate(slack.status.lastSyncAt)}`
                  : 'Workspace connected. Channels can be linked directly inside projects.'}
              </span>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className="ws-button ws-button-primary"
                  onClick={slack.onSync}
                  disabled={slack.syncing || slack.disconnecting}
                >
                  {slack.syncing ? 'Syncing messages…' : 'Sync messages'}
                </button>
                <button
                  className="ws-button"
                  onClick={slack.onDisconnect}
                  disabled={slack.syncing || slack.disconnecting}
                >
                  {slack.disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="ws-connection-action">
            <button
              className="ws-button ws-button-primary"
              onClick={slack.onInstall}
              disabled={slack.loading || slack.starting || slack.status?.configured === false}
            >
              {slack.starting ? 'Opening Slack…' : 'Connect Slack'}
            </button>
          </div>
        )}

        {!connected && slack.status?.configured === false && (
          <p className="ws-notice" role="status">Slack App integration isn’t configured on this server yet.</p>
        )}
        {slack.syncNotice && <p className="ws-notice" role="status" style={{ marginTop: '12px' }}>{slack.syncNotice}</p>}
        {slack.error && <p className="ws-error" role="alert" style={{ marginTop: '12px' }}>{slack.error}</p>}
      </article>
    )
  }

  if (id === 'notion' && notion) {
    const connected = Boolean(notion.status?.connected)
    const badge = connected ? 'Connected' : 'Available'
    return (
      <article className="ws-connection-card" aria-labelledby={`connection-${id}`}>
        <div className="ws-project-card-top">
          <span className="ws-project-symbol"><IntegrationLogo name={id}/></span>
          <span className={`ws-badge ${connected ? 'ws-badge-completed' : 'ws-badge-pending'}`}>{badge}</span>
        </div>
        <h3 id={`connection-${id}`}>{name}</h3>
        <p>{description}</p>

        {connected ? (
          <>
            <p className="ws-muted" style={{ marginTop: '8px' }}>
              Connected to {notion.status.workspaceName || 'Notion Workspace'} · {formatDate(notion.status.connectedAt)}
            </p>
            <div className="ws-connection-action" style={{ display: 'grid', gap: '10px' }}>
              <span className="ws-muted">
                {notion.status.lastSyncAt
                  ? `Synced ${notion.status.syncedPageCount || 0} pages · Last sync ${formatDate(notion.status.lastSyncAt)}`
                  : 'Pages and shared documentation are ready to sync.'}
              </span>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className="ws-button ws-button-primary"
                  onClick={notion.onSync}
                  disabled={notion.syncing || notion.disconnecting}
                >
                  {notion.syncing ? 'Syncing pages…' : 'Sync pages'}
                </button>
                <button
                  className="ws-button"
                  onClick={notion.onDisconnect}
                  disabled={notion.syncing || notion.disconnecting}
                >
                  {notion.disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="ws-connection-action" style={{ display: 'grid', gap: '10px' }}>
            {notion.status?.configured && <button className="ws-button ws-button-primary" onClick={notion.onInstall} disabled={notion.connecting}>{notion.connecting ? 'Opening Notion…' : 'Authorize with Notion'}</button>}
            {!notion.status?.configured && <p className="ws-muted">Notion OAuth credentials are not configured on this server.</p>}
            <details><summary>Use an integration token instead</summary>
            <div style={{ display: 'grid', gap: '4px' }}>
              <label htmlFor="notion-token-input" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                Internal Integration Secret
              </label>
              <input
                id="notion-token-input"
                type="password"
                placeholder="secret_your_notion_integration_token"
                value={notion.form.apiKey}
                onChange={e => notion.setForm(f => ({ ...f, apiKey: e.target.value }))}
                disabled={notion.connecting}
                style={{
                  border: '1px solid var(--ws-border)',
                  borderRadius: '7px',
                  padding: '8px 10px',
                  fontSize: '12px',
                  color: 'var(--ws-ink)',
                  background: '#fff',
                  outline: 'none',
                  width: '100%',
                }}
              />
            </div>
            <div style={{ display: 'grid', gap: '4px' }}>
              <label htmlFor="notion-database-input" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                Database or Page ID (optional)
              </label>
              <input
                id="notion-database-input"
                type="text"
                placeholder="e.g. 4d036e052d4e4b7192b55d9c792167c1"
                value={notion.form.databaseId}
                onChange={e => notion.setForm(f => ({ ...f, databaseId: e.target.value }))}
                disabled={notion.connecting}
                style={{
                  border: '1px solid var(--ws-border)',
                  borderRadius: '7px',
                  padding: '8px 10px',
                  fontSize: '12px',
                  color: 'var(--ws-ink)',
                  background: '#fff',
                  outline: 'none',
                  width: '100%',
                }}
              />
            </div>
            <button
              className="ws-button ws-button-primary"
              onClick={notion.onConnect}
              disabled={notion.connecting || !notion.form.apiKey.trim()}
            >
              {notion.connecting ? 'Connecting…' : 'Connect Notion'}
            </button>
            <span className="ws-muted" style={{ fontSize: '11px' }}>
              Connects to pages explicitly shared with your integration.
            </span>
            </details>
          </div>
        )}

        {notion.syncNotice && <p className="ws-notice" role="status" style={{ marginTop: '12px' }}>{notion.syncNotice}</p>}
        {notion.error && <p className="ws-error" role="alert" style={{ marginTop: '12px' }}>{notion.error}</p>}
      </article>
    )
  }

  const connected = available && github.status?.connected
  const badge = connected ? 'Connected' : available ? 'Available' : 'Coming soon'
  const notice = available && (github.error || github.message)
  return (
    <article className="ws-connection-card" aria-labelledby={`connection-${id}`}>
      <div className="ws-project-card-top">
        <span className="ws-project-symbol"><IntegrationLogo name={id}/></span>
        <span className={`ws-badge ${connected ? 'ws-badge-completed' : available ? 'ws-badge-pending' : ''}`}>{badge}</span>
      </div>
      <h3 id={`connection-${id}`}>{name}</h3>
      <p>{description}</p>
      {connected && github.status.accounts?.map(account => (
        <p className="ws-muted" key={account.id}>{`Connected to ${account.login} · ${formatDate(account.connectedAt)}`}</p>
      ))}
      <div className="ws-connection-action">
        {!available ? (
          <span className="ws-muted">Not available yet</span>
        ) : connected ? (
          <span className="ws-muted">Repositories can be linked to projects once project setup is available.</span>
        ) : (
          <button
            className="ws-button ws-button-primary"
            onClick={github.onConnect}
            disabled={github.loading || github.starting || github.status?.configured === false}
          >
            {github.starting ? 'Opening GitHub…' : 'Connect GitHub'}
          </button>
        )}
      </div>
      {available && !connected && github.status?.configured === false && (
        <p className="ws-notice" role="status">GitHub integration isn’t configured on this server yet.</p>
      )}
      {notice && (
        <p className={github.error ? 'ws-error' : 'ws-notice'} role={github.error ? 'alert' : 'status'}>{notice}</p>
      )}
    </article>
  )
}

export function ConnectionsView({ github = {}, whatsapp, jira, slack, notion }) {
  const loading = Boolean(
    github.loading ||
    (whatsapp && whatsapp.loading) ||
    (jira && jira.loading) ||
    (slack && slack.loading) ||
    (notion && notion.loading)
  )
  const categories = [AI_CATEGORY, ...getCategories({ whatsapp, jira, slack, notion })]
  const dialogs = useRef({})
  return <div className="connections-page">
    <PageHeading eyebrow="YOUR CONNECTED WORKSPACE" title="Connections" description="Bring your tools into one place. Choose a service to connect or manage it."/>
    {loading && <p className="connections-loading" role="status">Checking your connections…</p>}
    <div className="connections-catalog">
      {categories.flatMap(category => category.items.map(item => {
        const service = { github, whatsapp, jira, slack, notion }[item.id]
        const connected = Boolean(service?.status?.connected)
        return <article className="connection-tile" key={item.id}>
          <div className="connection-tile-top"><IntegrationLogo name={item.id}/><span className={`ws-badge ${connected ? 'ws-badge-completed' : ''}`}>{connected ? 'Connected' : item.id === 'mcp' ? 'Available' : 'Not connected'}</span></div>
          <small>{category.title}</small><h2>{item.name}</h2>
          <p>{item.description || 'Work with your project context directly from your AI client.'}</p>
          {item.id === 'github' && github.status?.accounts?.map(account => <span className="connection-account" key={account.id}>Connected to {account.login}</span>)}
          {service?.error && <p className="connection-tile-error" role="alert">{service.error}</p>}
          {service?.message && <p className="connection-tile-message" role="status">{service.message}</p>}
          <button className="ws-button" aria-haspopup="dialog" onClick={()=>dialogs.current[item.id]?.showModal()}>Manage {item.name}<span aria-hidden="true">↗</span></button>
          <dialog className="connection-dialog" ref={el=>{dialogs.current[item.id]=el}} aria-label={`${item.name} connection setup`}>
            <form method="dialog" className="connection-dialog-close"><button aria-label="Close connection setup">×</button></form>
            {!loading && (item.id === 'mcp' ? <McpConnection/> : item.id === 'notion' && !notion ? <NotionConnection/> : <ConnectionCard integration={item} github={github} whatsapp={whatsapp} jira={jira} slack={slack} notion={notion}/>)}
            {!loading && item.id === 'notion' && notion && <NotionConnection/>}
          </dialog>
        </article>
      }))}
    </div>
  </div>
}

export default function ConnectionsPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const returned = params.get('github')
  const returnedSlack = params.get('slack')
  const returnedJira = params.get('jira')
  const returnedNotion = params.get('notion')
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  // WhatsApp state
  const [waStatus, setWaStatus] = useState(null)
  const [waLoading, setWaLoading] = useState(true)
  const [waPhone, setWaPhone] = useState('+919021875564')
  const [waConnecting, setWaConnecting] = useState(false)
  const [waDisconnecting, setWaDisconnecting] = useState(false)
  const [waError, setWaError] = useState('')

  // Jira state
  const [jiraStatus, setJiraStatus] = useState(null)
  const [jiraLoading, setJiraLoading] = useState(true)
  const [jiraForm, setJiraForm] = useState({
    host: '',
    email: '',
    apiToken: '',
    projectKey: '',
  })
  const [jiraConnecting, setJiraConnecting] = useState(false)
  const [jiraDisconnecting, setJiraDisconnecting] = useState(false)
  const [jiraSyncing, setJiraSyncing] = useState(false)
  const [jiraError, setJiraError] = useState(() => returnedJira === 'error' ? 'Could not complete Jira authorization.' : '')
  const [jiraSyncNotice, setJiraSyncNotice] = useState(() => returnedJira === 'connected' ? 'Jira connected successfully.' : '')

  // Slack state
  const [slackStatus, setSlackStatus] = useState(null)
  const [slackLoading, setSlackLoading] = useState(true)
  const [slackStarting, setSlackStarting] = useState(false)
  const [slackDisconnecting, setSlackDisconnecting] = useState(false)
  const [slackSyncing, setSlackSyncing] = useState(false)
  const [slackError, setSlackError] = useState('')
  const [slackSyncNotice, setSlackSyncNotice] = useState(() => returnedSlack === 'connected' ? 'Slack workspace connected successfully.' : '')

  // Notion state
  const [notionStatus, setNotionStatus] = useState(null)
  const [notionLoading, setNotionLoading] = useState(true)
  const [notionForm, setNotionForm] = useState({
    apiKey: '',
    pageId: '',
    databaseId: '',
  })
  const [notionConnecting, setNotionConnecting] = useState(false)
  const [notionDisconnecting, setNotionDisconnecting] = useState(false)
  const [notionSyncing, setNotionSyncing] = useState(false)
  const [notionError, setNotionError] = useState(() => returnedNotion === 'error' ? 'Could not authorize Notion. Check the OAuth configuration and try again.' : returnedNotion === 'cancelled' ? 'Notion authorization was cancelled.' : '')
  const [notionSyncNotice, setNotionSyncNotice] = useState(() => returnedNotion === 'connected' ? 'Notion workspace connected successfully.' : '')

  // Read once so the notice survives the URL cleanup below.
  const [message] = useState(() => (returned && returned !== 'connected' ? (RETURN_MESSAGES[returned] || RETURN_MESSAGES.error) + (params.get('reason') ? ` (${params.get('reason')})` : '') : ''))

  useEffect(() => {
    const controller = new AbortController()
    getGitHubStatus(controller.signal)
      .then(data => {
        setStatus(data)
        setLoading(false)
        // Only a backend-confirmed connection resumes an in-progress project.
        if (returned === 'connected' && data.connected && loadProjectDraft()) navigate('/projects?newProject=1', { replace: true })
      })
      .catch(failure => { if (failure.name !== 'AbortError') { setError(failure.message); setLoading(false) } })

    getWhatsAppStatus(controller.signal)
      .then(data => {
        setWaStatus(data)
        if (data.phone) setWaPhone(data.phone)
        setWaLoading(false)
      })
      .catch(failure => {
        if (failure.name !== 'AbortError') {
          setWaStatus({ connected: false })
          setWaLoading(false)
        }
      })

    getJiraStatus(controller.signal)
      .then(data => {
        setJiraStatus(data)
        setJiraLoading(false)
      })
      .catch(failure => {
        if (failure.name !== 'AbortError') {
          setJiraStatus({ connected: false })
          setJiraLoading(false)
        }
      })

    getSlackStatus(controller.signal)
      .then(data => {
        setSlackStatus(data)
        setSlackLoading(false)
      })
      .catch(failure => {
        if (failure.name !== 'AbortError') {
          setSlackStatus({ connected: false })
          setSlackLoading(false)
        }
      })

    getNotionStatus(controller.signal)
      .then(data => {
        setNotionStatus(data)
        setNotionLoading(false)
      })
      .catch(failure => {
        if (failure.name !== 'AbortError') {
          setNotionStatus({ connected: false })
          setNotionLoading(false)
        }
      })

    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on arrival
  }, [])

  // Drop the non-sensitive return markers from the URL once read.
  useEffect(() => {
    if (returned || returnedSlack || returnedJira || returnedNotion) {
      setParams(current => {
        current.delete('github')
        current.delete('slack')
        current.delete('jira')
        current.delete('notion')
        current.delete('reason')
        return current
      }, { replace: true })
    }
  }, [returned, returnedSlack, returnedJira, returnedNotion, setParams, params])

  async function onConnectGitHub() {
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

  async function onConnectWhatsApp() {
    setWaConnecting(true)
    setWaError('')
    try {
      const data = await connectWhatsApp(waPhone)
      setWaStatus(data)
      setWaConnecting(false)
      const targetUrl = data.whatsappUrl || 'https://wa.me/14155238886?text=join%20fear-company'
      window.open(targetUrl, '_blank')
    } catch (failure) {
      setWaError(failure.message)
      setWaConnecting(false)
    }
  }

  async function onDisconnectWhatsApp() {
    setWaDisconnecting(true)
    setWaError('')
    try {
      const data = await disconnectWhatsApp()
      setWaStatus(data)
      setWaDisconnecting(false)
    } catch (failure) {
      setWaError(failure.message)
      setWaDisconnecting(false)
    }
  }

  async function onConnectJira() {
    setJiraConnecting(true)
    setJiraError('')
    setJiraSyncNotice('')
    try {
      const { url } = await startJiraInstall()
      if (!url?.startsWith('https://auth.atlassian.com/')) {
        throw new Error('Jira returned an unexpected authorization address.')
      }
      window.location.assign(url)
    } catch (failure) {
      setJiraError(failure.message)
      setJiraConnecting(false)
    }
  }

  async function onDisconnectJira() {
    setJiraDisconnecting(true)
    setJiraError('')
    setJiraSyncNotice('')
    try {
      const data = await disconnectJira()
      setJiraStatus(data)
      setJiraDisconnecting(false)
    } catch (failure) {
      setJiraError(failure.message)
      setJiraDisconnecting(false)
    }
  }

  async function onSyncJira() {
    setJiraSyncing(true)
    setJiraError('')
    setJiraSyncNotice('')
    try {
      const data = await syncJira()
      setJiraStatus(prev => ({
        ...prev,
        lastSyncAt: data.lastSyncAt,
        syncedIssueCount: data.syncedIssueCount,
      }))
      setJiraSyncNotice(`Successfully synced ${data.syncedIssueCount} Jira issues.`)
      setJiraSyncing(false)
    } catch (failure) {
      setJiraError(failure.message)
      setJiraSyncing(false)
    }
  }

  async function onInstallSlack() {
    setSlackStarting(true)
    setSlackError('')
    try {
      const { url } = await startSlackInstall()
      if (!url?.startsWith('https://slack.com/oauth/')) throw new Error('Slack returned an unexpected installation address.')
      window.location.assign(url)
    } catch (failure) {
      setSlackError(failure.message)
      setSlackStarting(false)
    }
  }

  async function onDisconnectSlack() {
    setSlackDisconnecting(true)
    setSlackError('')
    setSlackSyncNotice('')
    try {
      const data = await disconnectSlack()
      setSlackStatus(data)
      setSlackDisconnecting(false)
    } catch (failure) {
      setSlackError(failure.message)
      setSlackDisconnecting(false)
    }
  }

  async function onSyncSlack() {
    setSlackSyncing(true)
    setSlackError('')
    setSlackSyncNotice('')
    try {
      const data = await syncSlack()
      setSlackStatus(prev => ({
        ...prev,
        lastSyncAt: data.lastSyncAt,
        syncedMessageCount: data.syncedMessageCount,
      }))
      setSlackSyncNotice(`Successfully synced ${data.syncedMessageCount} Slack messages.`)
      setSlackSyncing(false)
    } catch (failure) {
      setSlackError(failure.message)
      setSlackSyncing(false)
    }
  }

  async function onInstallNotion() {
    setNotionConnecting(true)
    setNotionError('')
    try {
      const { url } = await startNotionInstall()
      window.location.assign(url)
    } catch (failure) {
      setNotionError(failure.message)
      setNotionConnecting(false)
    }
  }

  async function onConnectNotion() {
    setNotionConnecting(true)
    setNotionError('')
    setNotionSyncNotice('')
    try {
      const data = await connectNotion(notionForm)
      setNotionStatus(data)
      setNotionConnecting(false)
    } catch (failure) {
      setNotionError(failure.message)
      setNotionConnecting(false)
    }
  }

  async function onDisconnectNotion() {
    setNotionDisconnecting(true)
    setNotionError('')
    setNotionSyncNotice('')
    try {
      const data = await disconnectNotion()
      setNotionStatus(data)
      setNotionDisconnecting(false)
    } catch (failure) {
      setNotionError(failure.message)
      setNotionDisconnecting(false)
    }
  }

  async function onSyncNotion() {
    setNotionSyncing(true)
    setNotionError('')
    setNotionSyncNotice('')
    try {
      const data = await syncNotion()
      setNotionStatus(prev => ({
        ...prev,
        lastSyncAt: data.lastSyncAt,
        syncedPageCount: data.syncedPageCount,
      }))
      setNotionSyncNotice(`Successfully synced ${data.syncedPageCount} Notion pages.`)
      setNotionSyncing(false)
    } catch (failure) {
      setNotionError(failure.message)
      setNotionSyncing(false)
    }
  }

  return (
    <>
      <ConnectionsView
      github={{ status, loading, starting, error, message, onConnect: onConnectGitHub }}
      whatsapp={{
        status: waStatus,
        loading: waLoading,
        phone: waPhone,
        setPhone: setWaPhone,
        connecting: waConnecting,
        disconnecting: waDisconnecting,
        error: waError,
        onConnect: onConnectWhatsApp,
        onDisconnect: onDisconnectWhatsApp,
      }}
      jira={{
        status: jiraStatus,
        loading: jiraLoading,
        form: jiraForm,
        setForm: setJiraForm,
        connecting: jiraConnecting,
        disconnecting: jiraDisconnecting,
        syncing: jiraSyncing,
        error: jiraError,
        syncNotice: jiraSyncNotice,
        onConnect: onConnectJira,
        onDisconnect: onDisconnectJira,
        onSync: onSyncJira,
      }}
      slack={{
        status: slackStatus,
        loading: slackLoading,
        starting: slackStarting,
        disconnecting: slackDisconnecting,
        syncing: slackSyncing,
        error: slackError,
        syncNotice: slackSyncNotice,
        onInstall: onInstallSlack,
        onDisconnect: onDisconnectSlack,
        onSync: onSyncSlack,
      }}
      notion={{
        status: notionStatus,
        loading: notionLoading,
        form: notionForm,
        setForm: setNotionForm,
        connecting: notionConnecting,
        disconnecting: notionDisconnecting,
        syncing: notionSyncing,
        error: notionError,
        syncNotice: notionSyncNotice,
        onInstall: onInstallNotion,
        onConnect: onConnectNotion,
        onDisconnect: onDisconnectNotion,
        onSync: onSyncNotion,
      }}
    />
  </>
  )
}
