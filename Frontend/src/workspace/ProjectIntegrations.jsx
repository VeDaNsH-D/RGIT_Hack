import { useEffect, useState } from 'react'
import { listGitHubRepositories } from '../api/connections'
import { Icon } from './ui'

function Visibility({ isPrivate }) { return <span className={`ws-badge ${isPrivate ? 'ws-badge-pending' : ''}`}>{isPrivate ? 'Private' : 'Public'}</span> }

// Presentational: every state is a prop so it renders (and tests) without network access.
export function GitHubRepositoryPicker({ state, repos, query, onQuery, selected, onSelect, error, onRetry, onConnect, busy }) {
  return <div className="ws-integration" aria-label="GitHub">
    <div className="ws-integration-head"><span className="ws-project-symbol"><Icon name="github" size={18}/></span><div><strong>GitHub repository</strong><span>Optional — bring issues, pull requests, and commits into this project.</span></div></div>
    {selected && <div className="ws-repo-selected"><span><strong>{selected.fullName}</strong> <Visibility isPrivate={selected.isPrivate}/></span><button type="button" className="ws-text-button" onClick={() => onSelect(null)} disabled={busy}>Clear</button></div>}
    {state === 'not_connected' && <div className="ws-integration-body"><p className="ws-muted">GitHub isn’t connected yet.</p><button type="button" className="ws-button" onClick={onConnect} disabled={busy}>Connect GitHub</button></div>}
    {state === 'loading' && <p className="ws-muted" role="status">Loading repositories…</p>}
    {state === 'error' && <div className="ws-integration-body"><p className="ws-error" role="alert">{error}</p><button type="button" className="ws-button" onClick={onRetry}>Try again</button></div>}
    {['ready', 'loading'].includes(state) && (query || repos.length > 0 || state === 'ready') && !selected && <>
      <label className="ws-search"><Icon name="search" size={16}/><input aria-label="Search repositories" placeholder="Search repositories…" value={query} onChange={event => onQuery(event.target.value)}/></label>
      {state === 'ready' && (repos.length ? <ul className="ws-repo-list">{repos.map(repo => <li key={repo.id}><button type="button" onClick={() => onSelect(repo)} disabled={busy}><span>{repo.fullName}</span><Visibility isPrivate={repo.isPrivate}/></button></li>)}</ul> : <p className="ws-muted">{query ? 'No repositories match that search.' : 'No repositories are shared with Over2u yet. Add some from your GitHub installation settings.'}</p>)}
    </>}
  </div>
}

// Provider cards live here; add Slack, Jira, … beside GitHub later without touching project creation.
export default function ProjectIntegrations({ value, onChange, onConnectGitHub, busy, excludeIds = [] }) {
  const [query, setQuery] = useState('')
  const [fetched, setFetched] = useState(null)
  const [retry, setRetry] = useState(0)
  const pending = !fetched || fetched.query !== query || fetched.retry !== retry

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      listGitHubRepositories({ q: query, signal: controller.signal })
        .then(data => setFetched({ query, retry, data }))
        .catch(error => { if (error.name !== 'AbortError') setFetched({ query, retry, error: error.message }) })
    }, query ? 250 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, retry])

  const state = pending ? 'loading' : fetched.error ? 'error' : fetched.data.connected ? 'ready' : 'not_connected'
  return <fieldset className="ws-integrations">
    <legend>Connect your tools</legend>
    <GitHubRepositoryPicker state={state} repos={(fetched?.data?.repositories || []).filter(repo => !excludeIds.includes(repo.id))} query={query} onQuery={setQuery} selected={value.github} onSelect={repo => onChange({ ...value, github: repo })} error={fetched?.error} onRetry={() => setRetry(count => count + 1)} onConnect={onConnectGitHub} busy={busy}/>
  </fieldset>
}
