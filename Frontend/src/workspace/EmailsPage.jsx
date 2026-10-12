import { useCallback, useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { request } from '../api/client'
import { useWorkspace } from './WorkspaceContext'
import { Badge, PageHeading, Icon } from './ui'
import './email.css'

function Proposal({ item, reviewId, project, onReviewed }) {
  const [targetId, setTargetId] = useState(item.targetTaskId || '')
  const target = project.tasks.find(task => task.id === targetId)
  const [title, setTitle] = useState(item.title)
  const [description, setDescription] = useState(item.description || '')
  const [priority, setPriority] = useState(item.priority || 'medium')
  const [deadline, setDeadline] = useState(item.deadline?.slice(0,10) || '')
  const [assignee, setAssignee] = useState(target?.assignee || '')
  const [status, setStatus] = useState(target?.status || 'open')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = item.status === 'pending'
  async function decide(action) {
    setBusy(true); setError('')
    try {
      const body = action === 'dismiss' ? { action } : { action, title, description, priority, deadline: deadline ? new Date(`${deadline}T23:59:00`).toISOString() : null, assignee: assignee || null, taskStatus: status, targetTaskId: targetId || null }
      const result = await request(`/email/projects/${project.id}/reviews/${reviewId}/items/${item.id}`, { method:'POST', body })
      await onReviewed(result.review)
    } catch(err) { setError(err.message) }
    finally { setBusy(false) }
  }
  return <div className="email-proposal"><div className="ws-section-heading"><h3>{item.title}</h3><Badge value={item.status}/></div><p className="ws-muted">{item.rationale || 'A proposed next step from the selected conversations.'}</p><fieldset disabled={!pending || busy}>
    <label>Workflow change<select value={targetId} onChange={event => { const task = project.tasks.find(task => task.id === event.target.value); setTargetId(event.target.value); setAssignee(task?.assignee || ''); setStatus(task?.status || 'open') }}><option value="">Create a new task</option>{project.tasks.map(task => <option key={task.id} value={task.id}>Update: {task.title}</option>)}</select></label>
    <label>Task title<input required maxLength={300} value={title} onChange={event => setTitle(event.target.value)}/></label><label>Details<textarea maxLength={5000} rows={2} value={description} onChange={event => setDescription(event.target.value)}/></label>
    <div className="ws-form-grid"><label>Priority<select value={priority} onChange={event => setPriority(event.target.value)}>{['low','medium','high','critical'].map(value => <option key={value}>{value}</option>)}</select></label><label>Due date<input type="date" value={deadline} onChange={event => setDeadline(event.target.value)}/></label><label>Assigned to<select value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">Unassigned</option>{project.context.members.map(member => <option value={member.userId} key={member.userId}>{member.name}</option>)}</select></label><label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="open">Open</option><option value="completed">Completed</option></select></label></div>
  </fieldset><p className="ws-muted">Evidence: {item.sourceIds.length} imported conversation{item.sourceIds.length === 1 ? '' : 's'}.</p>{error && <p className="ws-error" role="alert">{error}</p>}{pending && <div className="email-proposal-actions"><button className="ws-button" disabled={busy} onClick={() => decide('dismiss')}>Dismiss</button><button className="ws-button ws-button-primary" disabled={busy || !title.trim()} onClick={() => decide('apply')}>{busy ? 'Saving…' : targetId ? 'Approve task update' : 'Approve new task'}</button></div>}</div>
}

const callbackErrors = { invalid_state: 'Mailbox connection expired or belongs to another browser. Start again.', access_denied: 'Mailbox connection was cancelled.', permission_denied: 'Email read permission wasn’t granted. Reconnect and allow read access.', gmail_api_disabled: 'Gmail API is not enabled in your Google Cloud project. Enable Gmail API in APIs & Services → Library, then connect again.', oauth_code_expired: 'The authorization code expired or was already used. Click Connect Gmail again to start a fresh request.', oauth_client_invalid: 'Google rejected the OAuth client configuration. Check the backend client ID and secret.', provider_unreachable: 'The backend couldn’t reach the email provider. Check its network connection and retry.', mailbox_access_expired: 'Mailbox authorization expired. Please reconnect.', mailbox_permission_denied: 'The provider blocked mailbox access. Check Gmail read permissions or your organization’s access policy.', connection_save_failed: 'Authorization succeeded, but the mailbox connection could not be saved. Check the backend database connection and retry.', account_unavailable: 'Your app account is no longer available. Sign in again before connecting a mailbox.', token_exchange_failed: 'The backend could not exchange the authorization code. Start a fresh connection and check the OAuth client configuration.', provider_invalid_response: 'The email provider returned an unreadable response. Please reconnect.', connection_failed: 'Couldn’t finish connecting your mailbox. Start a fresh connection; the backend now records the failed step without logging credentials.' }
export default function EmailsPage() {
  const { projects, reload } = useWorkspace()
  const editableProjects = projects.filter(project => project.myRole !== 'viewer' && !project.loadError)
  const [params] = useSearchParams()
  const [connections, setConnections] = useState([])
  const [available, setAvailable] = useState({})
  const [provider, setProvider] = useState('gmail')
  const [projectId, setProjectId] = useState(editableProjects[0]?.id || '')
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState([])
  const [nextPage, setNextPage] = useState(null)
  const [selected, setSelected] = useState([])
  const [preview, setPreview] = useState(null)
  const [records, setRecords] = useState([])
  const [recordIds, setRecordIds] = useState([])
  const [reviews, setReviews] = useState([])
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [connectionError, setConnectionError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(params.get('connected') ? 'Your mailbox is connected. Choose conversations to bring into a project.' : '')
  const project = editableProjects.find(project => project.id === projectId)
  const connected = connections.find(item => item.provider === provider)
  const loadConnections = useCallback(signal => request('/email/connections', { signal }).then(data => {
    if (!signal?.aborted) { setConnections(data.connections); setAvailable(data.available); setConnectionError(''); setLoading(false) }
  }).catch(err => {
    if (!signal?.aborted) { setConnectionError(err.status >= 500 || !err.status ? 'The backend is unavailable. Make sure it is running on port 8000, then retry.' : err.message); setLoading(false) }
  }), [])
  useEffect(() => { const controller = new AbortController(); loadConnections(controller.signal); return () => controller.abort() }, [loadConnections])
  useEffect(() => {
    if (!projectId) return
    const controller = new AbortController()
    request(`/email/projects/${projectId}/log`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) { setRecords(data.records); setReviews(data.reviews) } }).catch(err => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [projectId])
  async function refreshLog() { if (projectId) { const data = await request(`/email/projects/${projectId}/log`); setRecords(data.records); setReviews(data.reviews) } }
  async function action(name, operation) {
    setBusy(name); setError(''); setNotice('')
    try { await operation() } catch(err) { setError(err.message) } finally { setBusy('') }
  }
  async function loadThreads(pageToken = '') {
    const data = await request(`/email/${provider}/threads?${new URLSearchParams({ q:query, ...(pageToken ? { pageToken } : {}) })}`, { signal: AbortSignal.timeout(90000) })
    setThreads(previous => pageToken ? [...new Map([...previous, ...data.threads].map(thread => [thread.id, thread])).values()] : data.threads)
    setNextPage(data.nextPageToken)
    if (!pageToken) setSelected([])
  }
  return <>
    <PageHeading eyebrow="CONVERSATIONS BECOME CONTEXT" title="Project email" description="Bring the right conversations into your project. Review the next steps before changing the workflow."/>
    {params.get('emailError') && <p className="ws-error" role="alert">{callbackErrors[params.get('emailError')] || 'Mailbox connection failed.'}</p>}{error && <p className="ws-error" role="alert">{error}</p>}{notice && <p className="ws-notice" role="status">{notice}</p>}
    {connectionError && <div className="ws-error" role="alert"><p>{connectionError}</p><button className="ws-button" disabled={Boolean(busy)} onClick={() => action('retry', async () => { await loadConnections(); await refreshLog() })}>{busy === 'retry' ? 'Retrying…' : 'Retry connection'}</button></div>}
    <div className="email-connection-grid">{['gmail','outlook'].map(value => { const mailbox = connections.find(item => item.provider === value); return <section className={`email-connection ${provider === value ? 'active' : ''}`} key={value}><div><span className="email-provider-mark">{value === 'gmail' ? 'M' : 'O'}</span><div><h3>{value === 'gmail' ? 'Gmail' : 'Outlook'}</h3><p>{mailbox?.email || (connectionError ? 'Mailbox service unavailable' : available[value] ? 'Connect with read-only email access' : loading ? 'Checking availability…' : 'Provider setup required')}</p></div></div><div>{mailbox ? <><button className="ws-button" disabled={Boolean(busy)} onClick={() => { setProvider(value); setThreads([]); setSelected([]); setPreview(null); setNextPage(null) }}>Browse mailbox</button><button className="ws-text-button" disabled={Boolean(busy)} onClick={() => action('disconnect', async () => { await request(`/email/connections/${value}`, { method:'DELETE' }); await loadConnections(); if (provider === value) { setThreads([]); setSelected([]); setPreview(null) } setNotice('Mailbox disconnected. Previously imported project conversations are retained.') })}>Disconnect</button></> : <button className="ws-button ws-button-primary" disabled={Boolean(busy) || !available[value]} onClick={() => action('connect', async () => { const data = await request(`/email/oauth/${value}/start`, { method:'POST', body:{} }); window.location.assign(data.authorizationUrl) })}>Connect {value === 'gmail' ? 'Gmail' : 'Outlook'}</button>}</div></section> })}</div>
    <section className="ws-panel"><div className="ws-section-heading"><div><h2>Choose project conversations</h2><p>Only selected threads are saved to the project and sent for analysis.</p></div><label className="email-project-select">Project<select aria-label="Destination project" disabled={Boolean(busy)} value={projectId} onChange={event => { setProjectId(event.target.value); setRecords([]); setReviews([]); setRecordIds([]) }}><option value="" disabled>Select a project</option>{editableProjects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label></div>
      {!editableProjects.length && <p className="ws-muted">Create a <Link to="/projects">project</Link> you can contribute to before importing emails.</p>}
      <form className="email-search-row" onSubmit={event => { event.preventDefault(); action('search', () => loadThreads()) }}><label className="ws-search"><Icon name="search" size={18}/><input aria-label="Search email" value={query} onChange={event => setQuery(event.target.value)} maxLength={300} placeholder={provider === 'gmail' ? 'Subject, sender, or Gmail search…' : 'Search Outlook messages…'}/></label><button className="ws-button" disabled={Boolean(busy) || !connected}>{busy === 'search' ? 'Loading…' : 'Load conversations'}</button><span className="ws-muted">{selected.length}/10 selected</span><button type="button" className="ws-button ws-button-primary" disabled={Boolean(busy) || !project || !selected.length} onClick={() => action('import', async () => { const data = await request(`/email/projects/${projectId}/import`, { method:'POST', body:{ provider, threadIds:selected }, signal: AbortSignal.timeout(90000) }); setRecordIds(data.records.map(record => record.id)); await refreshLog(); await reload(); setSelected([]); setNotice(`${data.records.length} conversations logged in ${project.name}. Select Analyze to propose workflow changes.`) })}>{busy === 'import' ? 'Importing…' : 'Import selected'}</button></form>
      {threads.length ? <div className="email-thread-list">{threads.map(thread => <div className="email-thread" key={thread.id}><input type="checkbox" aria-label={`Select ${thread.subject}`} checked={selected.includes(thread.id)} disabled={Boolean(busy) || (!selected.includes(thread.id) && selected.length >= 10)} onChange={event => setSelected(event.target.checked ? [...selected, thread.id] : selected.filter(id => id !== thread.id))}/><button className="email-thread-preview" disabled={Boolean(busy)} onClick={() => action('preview', async () => { const data = await request(`/email/${provider}/threads/${encodeURIComponent(thread.id)}`, { signal: AbortSignal.timeout(30000) }); setPreview(data.thread) })}><strong>{thread.subject}</strong><span>{thread.from} · {thread.messageCount} messages shown in this page</span><p>{thread.snippet}</p></button><time>{thread.date ? new Date(thread.date).toLocaleDateString('en-IN') : ''}</time></div>)}</div> : <p className="ws-panel-empty">{connected ? 'Load conversations to browse your mailbox.' : 'Connect a mailbox to browse conversations.'}</p>}
      {nextPage && <button className="ws-button" disabled={Boolean(busy)} onClick={() => action('search', () => loadThreads(nextPage))}>Load more</button>}
    </section>
    {preview && <section className="ws-panel email-preview"><div className="ws-section-heading"><h2>{preview.subject}</h2><button className="ws-text-button" onClick={() => setPreview(null)}>Close preview</button></div>{preview.messages.map(message => <article key={message.id}><strong>{message.from}</strong><small>To: {message.to} · {message.date ? new Date(message.date).toLocaleString('en-IN') : ''}</small><pre>{message.body || message.snippet || '(No readable text)'}</pre></article>)}</section>}
    <section className="ws-panel"><div className="ws-section-heading"><div><h2>Conversation log</h2><p>Saved email evidence shared with this project’s authorized members.</p></div><button className="ws-button ws-button-primary" disabled={Boolean(busy) || !recordIds.length || !project} onClick={() => action('analyze', async () => { const data = await request(`/email/projects/${projectId}/analyze`, { method:'POST', body:{ recordIds }, signal:AbortSignal.timeout(60000) }); setReviews(previous => [data.review, ...previous]); setNotice('Analysis ready. Review each suggestion below before applying it.') })}>{busy === 'analyze' ? 'Analyzing…' : 'Analyze selected emails'}</button></div>
      {records.length ? records.map(record => <details className="email-log-record" key={record.id}><summary><input type="checkbox" aria-label={`Analyze ${record.title}`} checked={recordIds.includes(record.id)} disabled={!recordIds.includes(record.id) && recordIds.length >= 10} onClick={event => event.stopPropagation()} onChange={event => setRecordIds(event.target.checked ? [...recordIds, record.id] : recordIds.filter(id => id !== record.id))}/><strong>{record.title}</strong><Badge value={record.provider}/><span>{record.messageCount} messages</span></summary><pre>{record.content}</pre>{record.url && <a href={record.url} target="_blank" rel="noreferrer">Open in mailbox ↗</a>}</details>) : <p className="ws-panel-empty">Selected conversations will appear here after import.</p>}
    </section>
    {project && reviews.map(review => <section className="ws-panel email-review" key={review.id}><span className="ws-eyebrow">REVIEW BEFORE APPLYING</span><h2>Suggested workflow changes</h2><p className="email-summary">{review.summary}</p>{review.decisions?.length > 0 && <details><summary>Decisions from the conversations</summary>{review.decisions.map((decision,index) => <p key={index}>{decision.decision || JSON.stringify(decision)}</p>)}</details>}{review.blockers?.length > 0 && <details><summary>Blockers to consider</summary>{review.blockers.map((blocker,index) => <p key={index}>{blocker.description}</p>)}</details>}{review.items.length ? review.items.map(item => <Proposal key={item.id} item={item} reviewId={review.id} project={project} onReviewed={async changed => { setReviews(previous => previous.map(value => value.id === changed.id ? changed : value)); await reload() }}/>) : <p className="ws-muted">No evidence-backed task changes were proposed. The conversations remain available in the project log.</p>}</section>)}
  </>
}
