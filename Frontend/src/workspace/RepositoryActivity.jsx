import { useEffect, useState } from 'react'
import { listGitHubActivity } from '../api/connections'
import { formatDate } from './utils'

const TABS = [{ id: 'issues', label: 'Open issues', state: 'open' }, { id: 'pulls', label: 'Open pull requests', state: 'open' }, { id: 'commits', label: 'Recent commits', state: 'all' }]

function ActivityRow({ item }) {
  const heading = item.kind === 'commit' ? item.sha : `#${item.number}`
  const meta = [item.repository, item.author && `by ${item.author}`, item.updatedAt && formatDate(item.updatedAt)].filter(Boolean)
  const people = item.kind === 'pull_request' ? item.reviewers : item.assignees
  return <li className="ws-activity-row">
    <div><strong>{item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a> : item.title}</strong><small className="ws-muted">{`${heading} · ${meta.join(' · ')}`}</small></div>
    <span className="ws-activity-tags">{item.draft && <span className="ws-badge">Draft</span>}{item.labels?.slice(0, 3).map(label => <span className="ws-badge" key={label}>{label}</span>)}{people?.length > 0 && <small className="ws-muted">{`${item.kind === 'pull_request' ? 'Review: ' : ''}${people.join(', ')}`}</small>}</span>
  </li>
}

// Presentational so loading / empty / error / list states render without network access.
export function RepositoryActivityView({ tab, onTab, state, data, error, onRetry, onPage }) {
  return <section className="ws-panel" aria-labelledby="repository-activity">
    <div className="ws-section-heading"><div><h2 id="repository-activity">Repository activity</h2><p>Straight from your synchronized repositories, with links back to GitHub.</p></div></div>
    <div className="ws-tabs" role="tablist">{TABS.map(item => <button type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} key={item.id} onClick={() => onTab(item.id)}>{item.label}</button>)}</div>
    {state === 'loading' && <div className="ws-skeleton ws-skeleton-list" role="status" aria-label="Loading activity"/>}
    {state === 'error' && <div className="ws-integration-body"><p className="ws-error" role="alert">{error}</p><button type="button" className="ws-button" onClick={onRetry}>Try again</button></div>}
    {state === 'ready' && (data.items.length
      ? <><ul className="ws-activity-list">{data.items.map(item => <ActivityRow item={item} key={item.id}/>)}</ul>
        <div className="ws-activity-pager"><span className="ws-muted">{`${data.total} total`}</span><span><button type="button" className="ws-button" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</button> <button type="button" className="ws-button" disabled={!data.hasMore} onClick={() => onPage(data.page + 1)}>Next</button></span></div></>
      : <p className="ws-panel-empty">Nothing here yet. Activity appears after a repository has been synchronized.</p>)}
  </section>
}

export default function RepositoryActivity({ projectId, refreshKey }) {
  const [tab, setTab] = useState('issues')
  const [page, setPage] = useState(1)
  const [tick, setTick] = useState(0)
  const [result, setResult] = useState(null)
  const wanted = `${projectId}:${tab}:${page}`
  useEffect(() => {
    const controller = new AbortController()
    const current = TABS.find(item => item.id === tab)
    listGitHubActivity(projectId, { kind: tab, state: current.state, page, signal: controller.signal })
      .then(data => setResult({ key: wanted, data }))
      .catch(error => { if (error.name !== 'AbortError') setResult({ key: wanted, error: error.message }) })
    return () => controller.abort()
  }, [projectId, tab, page, tick, refreshKey, wanted])
  const state = result?.key !== wanted ? 'loading' : result.error ? 'error' : 'ready'
  return <RepositoryActivityView tab={tab} onTab={id => { setTab(id); setPage(1) }} state={state} data={result?.data} error={result?.error} onRetry={() => { setResult(null); setTick(count => count + 1) }} onPage={setPage}/>
}
