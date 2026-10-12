import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  getGitHubStatus,
  startGitHubInstall,
  getWhatsAppStatus,
  connectWhatsApp,
  disconnectWhatsApp,
  getJiraStatus,
  connectJira,
  disconnectJira,
  syncJira,
  getSlackStatus,
  connectSlack,
  disconnectSlack,
  syncSlack,
  getNotionStatus,
  connectNotion,
  disconnectNotion,
  syncNotion,
} from '../api/connections'
import { formatDate } from './utils'
import { loadProjectDraft } from './projectDraft'
import { Icon, PageHeading } from './ui'

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

function SlackInstructionsModal({ isOpen, onClose }) {
  const dialogRef = useRef(null)

  useEffect(() => {
    const node = dialogRef.current
    if (!node) return
    if (isOpen) {
      if (!node.open) node.showModal()
    } else {
      if (node.open) node.close()
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <dialog
      ref={dialogRef}
      className="ws-modal"
      onCancel={onClose}
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{ maxWidth: '520px' }}
    >
      <button className="ws-modal-close" aria-label="Close dialog" onClick={onClose}>
        ×
      </button>
      <span className="ws-eyebrow">SLACK SETUP GUIDE</span>
      <h2>How to connect your Slack workspace</h2>
      <p className="ws-muted" style={{ marginBottom: '16px', fontSize: '13px' }}>
        Follow these steps to obtain a Bot User OAuth Token for your personal or team workspace:
      </p>

      <div style={{ display: 'grid', gap: '12px', fontSize: '13px', color: 'var(--ws-ink)', lineHeight: '1.5' }}>
        <div style={{ background: '#fdf8f4', border: '1px solid #f2dfd0', borderRadius: '8px', padding: '12px' }}>
          <strong>Step 1: Create a Slack App</strong>
          <p style={{ margin: '4px 0 0', color: 'var(--ws-muted)', fontSize: '12px' }}>
            Go to{' '}
            <a
              href="https://api.slack.com/apps"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#c14e16', textDecoration: 'underline', fontWeight: '500' }}
            >
              api.slack.com/apps ↗
            </a>
            , click <strong>Create New App</strong> → <strong>From scratch</strong>, name your app (e.g. <em>Relay</em>), and select your personal workspace.
          </p>
        </div>

        <div style={{ background: '#fdf8f4', border: '1px solid #f2dfd0', borderRadius: '8px', padding: '12px' }}>
          <strong>Step 2: Add Bot Token Scopes</strong>
          <p style={{ margin: '4px 0 0', color: 'var(--ws-muted)', fontSize: '12px' }}>
            In the left sidebar, click <strong>OAuth & Permissions</strong>. Scroll down to <strong>Bot Token Scopes</strong> and add:
          </p>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
            <code style={{ background: '#f5e8dc', padding: '2px 6px', borderRadius: '4px', fontSize: '11.5px' }}>channels:history</code>
            <code style={{ background: '#f5e8dc', padding: '2px 6px', borderRadius: '4px', fontSize: '11.5px' }}>channels:read</code>
            <code style={{ background: '#f5e8dc', padding: '2px 6px', borderRadius: '4px', fontSize: '11.5px' }}>groups:history</code>
            <code style={{ background: '#f5e8dc', padding: '2px 6px', borderRadius: '4px', fontSize: '11.5px' }}>groups:read</code>
          </div>
        </div>

        <div style={{ background: '#fdf8f4', border: '1px solid #f2dfd0', borderRadius: '8px', padding: '12px' }}>
          <strong>Step 3: Install & Copy Token</strong>
          <p style={{ margin: '4px 0 0', color: 'var(--ws-muted)', fontSize: '12px' }}>
            Scroll to the top of <strong>OAuth & Permissions</strong> and click <strong>Install to Workspace</strong> → <strong>Allow</strong>. Copy the <strong>Bot User OAuth Token</strong> (starts with <code>xoxb-</code>) and paste it into the Slack card.
          </p>
        </div>

        <div style={{ background: '#fdf8f4', border: '1px solid #f2dfd0', borderRadius: '8px', padding: '12px' }}>
          <strong>Step 4: Invite Bot to Your Channel</strong>
          <p style={{ margin: '4px 0 0', color: 'var(--ws-muted)', fontSize: '12px' }}>
            In your Slack client, go to the channel you want to sync and run:
          </p>
          <div style={{ marginTop: '4px' }}>
            <code style={{ background: '#f5e8dc', padding: '2px 6px', borderRadius: '4px', fontSize: '11.5px' }}>/invite @YourBotName</code>
          </div>
        </div>
      </div>

      <div className="ws-modal-actions" style={{ marginTop: '20px' }}>
        <button type="button" className="ws-button ws-button-primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </dialog>
  )
}

function ConnectionCard({ integration, github = {}, whatsapp, jira, slack, notion }) {
  const { id, name, description, available } = integration

  if (id === 'whatsapp' && whatsapp) {
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

  if (id === 'jira' && jira) {
    const connected = Boolean(jira.status?.connected)
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
              Connected to {jira.status.host} {jira.status.projectKey ? `(${jira.status.projectKey})` : ''} · {formatDate(jira.status.connectedAt)}
            </p>
            <div className="ws-connection-action" style={{ display: 'grid', gap: '10px' }}>
              <span className="ws-muted">
                {jira.status.lastSyncAt
                  ? `Synced ${jira.status.syncedIssueCount || 0} issues · Last sync ${formatDate(jira.status.lastSyncAt)}`
                  : 'Issues and project context are ready to sync.'}
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
            <div style={{ display: 'grid', gap: '4px' }}>
              <label htmlFor="jira-host-input" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                Your Jira Cloud Domain
              </label>
              <input
                id="jira-host-input"
                type="url"
                placeholder="https://your-domain.atlassian.net"
                value={jira.form.host}
                onChange={e => jira.setForm(f => ({ ...f, host: e.target.value }))}
                disabled={jira.connecting}
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
              <label htmlFor="jira-email-input" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                Your Atlassian Email
              </label>
              <input
                id="jira-email-input"
                type="email"
                placeholder="developer@example.com"
                value={jira.form.email}
                onChange={e => jira.setForm(f => ({ ...f, email: e.target.value }))}
                disabled={jira.connecting}
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
              <label htmlFor="jira-token-input" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                Your API Token
              </label>
              <input
                id="jira-token-input"
                type="password"
                placeholder="Atlassian API token"
                value={jira.form.apiToken}
                onChange={e => jira.setForm(f => ({ ...f, apiToken: e.target.value }))}
                disabled={jira.connecting}
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
              <label htmlFor="jira-proj-input" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                Project Key (optional)
              </label>
              <input
                id="jira-proj-input"
                type="text"
                placeholder="e.g. RELAY"
                value={jira.form.projectKey}
                onChange={e => jira.setForm(f => ({ ...f, projectKey: e.target.value }))}
                disabled={jira.connecting}
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
              onClick={jira.onConnect}
              disabled={jira.connecting || !jira.form.host.trim() || !jira.form.apiToken.trim()}
            >
              {jira.connecting ? 'Connecting…' : 'Connect Jira'}
            </button>
            <span className="ws-muted" style={{ fontSize: '11px' }}>
              Connects to your personal/team Jira instance.
            </span>
          </div>
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
          <span className="ws-project-symbol"><Icon name={id}/></span>
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
                  : 'Team messages and thread context are ready to sync.'}
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
          <div className="ws-connection-action" style={{ display: 'grid', gap: '10px' }}>
            <div style={{ display: 'grid', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label htmlFor="slack-token-input" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                  Your Bot User OAuth Token
                </label>
                <button
                  type="button"
                  onClick={slack.onOpenGuide}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#c14e16',
                    fontSize: '11px',
                    cursor: 'pointer',
                    padding: 0,
                    textDecoration: 'underline',
                    fontWeight: '500',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px',
                  }}
                >
                  💡 Instructions
                </button>
              </div>
              <input
                id="slack-token-input"
                type="password"
                placeholder="xoxb-your-slack-bot-token"
                value={slack.form.botToken}
                onChange={e => slack.setForm(f => ({ ...f, botToken: e.target.value }))}
                disabled={slack.connecting}
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
              <label htmlFor="slack-workspace-input" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                Workspace Domain or Name (optional)
              </label>
              <input
                id="slack-workspace-input"
                type="text"
                placeholder="e.g. your-team or acme-workspace"
                value={slack.form.teamDomain || ''}
                onChange={e => slack.setForm(f => ({ ...f, teamDomain: e.target.value }))}
                disabled={slack.connecting}
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
              <label htmlFor="slack-channel-input" style={{ fontSize: '11px', color: 'var(--ws-muted)' }}>
                Channel ID (optional)
              </label>
              <input
                id="slack-channel-input"
                type="text"
                placeholder="e.g. C0123456789"
                value={slack.form.channelId}
                onChange={e => slack.setForm(f => ({ ...f, channelId: e.target.value }))}
                disabled={slack.connecting}
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
              onClick={slack.onConnect}
              disabled={slack.connecting || (!slack.form.botToken.trim() && !slack.form.teamDomain?.trim())}
            >
              {slack.connecting ? 'Connecting…' : 'Connect Slack'}
            </button>
            <span className="ws-muted" style={{ fontSize: '11px' }}>
              Connects to your team workspace channel.
            </span>
          </div>
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
          <span className="ws-project-symbol"><Icon name={id}/></span>
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

export function ConnectionsView({ github = {}, whatsapp, jira, slack, notion }) {
  const loading = Boolean(
    github.loading ||
    (whatsapp && whatsapp.loading) ||
    (jira && jira.loading) ||
    (slack && slack.loading) ||
    (notion && notion.loading)
  )
  const categories = getCategories({ whatsapp, jira, slack, notion })
  return (
    <>
      <PageHeading eyebrow="WORKSPACE" title="Connections" description="Connect your tools to bring your team’s work and context together."/>
      {loading && (
        <div className="ws-loading" role="status">
          <span className="ws-spinner"/>Checking your connections…
        </div>
      )}
      {!loading && categories.map(category => (
        <section className="ws-connection-group" key={category.title} aria-labelledby={`group-${category.id}`}>
          <div className="ws-section-heading">
            <h2 id={`group-${category.id}`}>{category.title}</h2>
          </div>
          <div className="ws-connection-grid">
            {category.items.map(item => (
              <ConnectionCard
                key={item.id}
                integration={item}
                github={github}
                whatsapp={whatsapp}
                jira={jira}
                slack={slack}
                notion={notion}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

export default function ConnectionsPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
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
  const [jiraError, setJiraError] = useState('')
  const [jiraSyncNotice, setJiraSyncNotice] = useState('')

  // Slack state
  const [slackStatus, setSlackStatus] = useState(null)
  const [slackLoading, setSlackLoading] = useState(true)
  const [slackForm, setSlackForm] = useState({
    botToken: '',
    teamDomain: '',
    channelId: '',
  })
  const [slackConnecting, setSlackConnecting] = useState(false)
  const [slackDisconnecting, setSlackDisconnecting] = useState(false)
  const [slackSyncing, setSlackSyncing] = useState(false)
  const [slackError, setSlackError] = useState('')
  const [slackSyncNotice, setSlackSyncNotice] = useState('')
  const [showSlackGuide, setShowSlackGuide] = useState(false)

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
  const [notionError, setNotionError] = useState('')
  const [notionSyncNotice, setNotionSyncNotice] = useState('')

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

  async function onConnectJira() {
    setJiraConnecting(true)
    setJiraError('')
    setJiraSyncNotice('')
    try {
      const data = await connectJira(jiraForm)
      setJiraStatus(data)
      setJiraConnecting(false)
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

  async function onConnectSlack() {
    setSlackConnecting(true)
    setSlackError('')
    setSlackSyncNotice('')
    try {
      const data = await connectSlack(slackForm)
      setSlackStatus(data)
      setSlackConnecting(false)
    } catch (failure) {
      setSlackError(failure.message)
      setSlackConnecting(false)
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
        form: slackForm,
        setForm: setSlackForm,
        connecting: slackConnecting,
        disconnecting: slackDisconnecting,
        syncing: slackSyncing,
        error: slackError,
        syncNotice: slackSyncNotice,
        onConnect: onConnectSlack,
        onDisconnect: onDisconnectSlack,
        onSync: onSyncSlack,
        onOpenGuide: () => setShowSlackGuide(true),
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
        onConnect: onConnectNotion,
        onDisconnect: onDisconnectNotion,
        onSync: onSyncNotion,
      }}
    />
    <SlackInstructionsModal
      isOpen={showSlackGuide}
      onClose={() => setShowSlackGuide(false)}
    />
  </>
  )
}
