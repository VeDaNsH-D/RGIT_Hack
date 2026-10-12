import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  getGitHubStatus,
  startGitHubInstall,
  getWhatsAppStatus,
  connectWhatsApp,
  disconnectWhatsApp,
} from '../api/connections'
import { formatDate } from './utils'
import { Icon, PageHeading } from './ui'

const CATEGORIES = [
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
      { id: 'whatsapp', name: 'WhatsApp', description: 'Receive automatic notifications when warnings, critical conflicts, or SLA breaches occur.', available: true },
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
      { id: 'jira', name: 'Jira', description: 'Bring issues and project tracking into Relay.' },
    ],
  },
]

const RETURN_MESSAGES = {
  cancelled: 'GitHub installation was cancelled. Nothing was connected.',
  pending: 'Your GitHub organization needs to approve the installation before it can be connected.',
  error: 'We couldn’t verify the GitHub installation. Nothing was connected. Please try again.',
}

function ConnectionCard({ integration, github, whatsapp }) {
  const { id, name, description, available } = integration

  if (id === 'whatsapp') {
    const connected = Boolean(whatsapp.status?.connected)
    const badge = connected ? 'Connected' : 'Available'
    return (
      <article className="ws-connection-card" aria-labelledby={`connection-${id}`}>
        <div className="ws-project-card-top">
          <span className="ws-project-symbol"><Icon name={id}/></span>
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

  const connected = available && github.status?.connected
  const badge = connected ? 'Connected' : available ? 'Available' : 'Coming soon'
  const notice = available && (github.error || github.message)
  return (
    <article className="ws-connection-card" aria-labelledby={`connection-${id}`}>
      <div className="ws-project-card-top">
        <span className="ws-project-symbol"><Icon name={id}/></span>
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

export function ConnectionsView({ github, whatsapp }) {
  const loading = (github.loading || !github.status) && (whatsapp.loading || !whatsapp.status)
  return (
    <>
      <PageHeading eyebrow="WORKSPACE" title="Connections" description="Connect your tools to bring your team’s work and context together."/>
      {loading && (
        <div className="ws-loading" role="status">
          <span className="ws-spinner"/>Checking your connections…
        </div>
      )}
      {!loading && CATEGORIES.map(category => (
        <section className="ws-connection-group" key={category.title} aria-labelledby={`group-${category.id}`}>
          <div className="ws-section-heading">
            <h2 id={`group-${category.id}`}>{category.title}</h2>
          </div>
          <div className="ws-connection-grid">
            {category.items.map(item => (
              <ConnectionCard key={item.id} integration={item} github={github} whatsapp={whatsapp}/>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

export default function ConnectionsPage() {
  const [params, setParams] = useSearchParams()
  const returned = params.get('github')
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

  // Read once so the notice survives the URL cleanup below.
  const [message] = useState(() => (returned && returned !== 'connected' ? (RETURN_MESSAGES[returned] || RETURN_MESSAGES.error) + (params.get('reason') ? ` (${params.get('reason')})` : '') : ''))

  useEffect(() => {
    const controller = new AbortController()
    getGitHubStatus(controller.signal)
      .then(data => { setStatus(data); setLoading(false) })
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

    return () => controller.abort()
  }, [])

  // Drop the non-sensitive return markers from the URL once read.
  useEffect(() => {
    if (returned) setParams(current => { current.delete('github'); current.delete('reason'); return current }, { replace: true })
  }, [returned, setParams])

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

  return (
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
    />
  )
}
