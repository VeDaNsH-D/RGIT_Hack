import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { request } from '../api/client'
import { layoutWorkTree, treeEdgePath } from './workTreeLayout'
import './worktree.css'

export function WorkTreeCanvas({ graph, selected, onSelect }) {
  return <div className="wt-canvas" style={{ width: graph.width, height: graph.height }}>
    <svg className="wt-wires" width={graph.width} height={graph.height} aria-hidden="true">{graph.edges.map((edge,index) => <g key={edge.id}><path className="wt-wire" d={treeEdgePath(edge)}/><path className="wt-wire-pulse" d={treeEdgePath(edge)} style={{ animationDelay: `${-(index % 8)}s` }}/></g>)}</svg>
    <div className="wt-node wt-root" style={{ left: graph.root.x, top: graph.root.y, width: graph.root.width, height: graph.root.height, '--node-color': graph.root.color }}><span className="wt-node-tag"><i/>PROJECT TRIGGER</span><strong>{graph.root.label}</strong><small>Created {new Date(graph.root.occurredAt).toLocaleDateString()}</small><span className="wt-port wt-port-bottom"/></div>
    {graph.nodes.map(node => node.kind === 'lane' ? <div key={node.id} className="wt-node wt-branch" style={{ left:node.x, top:node.y, width:node.width, height:node.height, '--node-color':node.color }}><span className="wt-port wt-port-top"/><span className="wt-node-tag"><i/>{node.label}</span><span className="wt-port wt-port-right"/></div> : <button key={node.id} className={`wt-node wt-event ${selected===node.id?'selected':''} ${node.status==='failed'?'failed':''}`} style={{ left:node.x, top:node.y, width:node.width, height:node.height, '--node-color':node.color }} onClick={()=>onSelect(node.id)} aria-pressed={selected===node.id}><span className="wt-port wt-port-left"/><span className="wt-node-tag"><i/>{node.kind==='trigger'?'TRIGGER':node.kind==='source'?'SYNCED SOURCE':'ACTION'}<span>{node.status==='failed'?'!':node.status==='running'?'◌':node.status==='partial'?'◐':'✓'}</span></span><strong>{node.label}</strong><small title={node.description}>{node.description||node.actor}</small><time dateTime={node.occurredAt}>{new Date(node.occurredAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time><span className="wt-port wt-port-right"/></button>)}
  </div>
}

const SUMMARIES = {
  INVITATION_SENT: 'An invitation to join this project was sent.',
  INVITATION_ACCEPTED: 'A teammate accepted their invitation and joined the project.',
  INVITATION_REVOKED: 'A pending invitation was cancelled before it was accepted.',
  MEMBER_ADDED: 'A teammate was added to the project.',
  TASK_CREATED: 'A new task was added to the project.',
  TASK_UPDATED: 'A task was changed.',
  TASK_OVERDUE: 'A task passed its due date without being completed.',
  HANDOFF_CREATED: 'A handoff was drafted to transfer ownership.',
  HANDOFF_SUBMITTED: 'The handoff was submitted to the incoming owner for review.',
  HANDOFF_ACKNOWLEDGED: 'The incoming owner accepted the handoff and ownership transferred.',
  HANDOFF_CLARIFICATION_REQUESTED: 'The incoming owner asked for more detail before accepting.',
  HANDOFF_CLARIFICATION_RESPONDED: 'The outgoing owner answered a clarification request.',
  DOCUMENT_UPLOADED: 'A document was added to the project knowledge base.',
  DOCUMENT_REINDEXED: 'A document was re-processed so chat and handoffs can use its latest content.',
  NOTION_PAGE_SYNCED: 'A Notion page was imported into project knowledge.',
  GITHUB_PUSH_RECEIVED: 'New commits were pushed to a connected repository.',
  REPOSITORY_SYNC_COMPLETED: 'A connected repository finished syncing.',
  REPOSITORY_SYNC_PARTIAL: 'A repository sync finished, but some items could not be imported.',
  REPOSITORY_SYNC_FAILED: 'A repository sync failed and nothing new was imported.',
  COMMIT_IMPORTED: 'A commit from a connected repository was imported as project evidence.',
  SOURCE_IMPORTED: 'External content was imported as project evidence.',
}
const FIELD_LABELS = { repository: 'Repository', branch: 'Branch', sha: 'Commit', tool: 'Tool', keyName: 'Access key', status: 'Status', runId: 'Run ID', priority: 'Priority', dueDate: 'Due date', fromStatus: 'Changed from', toStatus: 'Changed to', filename: 'File', fileName: 'File', message: 'Message', provider: 'Source', commits: 'Commits', outcome: 'Outcome' }
const SECTION_FOR = { team: 'team', tasks: 'team', handoffs: 'handoff', development: 'connections', knowledge: 'connections', project: 'overview' }
const OPEN_LABEL = { team: 'Open team', tasks: 'Open tasks', handoffs: 'Open handoffs', development: 'Open connections', knowledge: 'Open connections', project: 'Open overview' }

function relativeTime(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(seconds)) return ''
  const abs = Math.abs(seconds)
  const units = [[86400, 'day'], [3600, 'hour'], [60, 'minute']]
  for (const [size, name] of units) if (abs >= size) { const n = Math.round(abs / size); return `${n} ${name}${n > 1 ? 's' : ''} ago` }
  return 'just now'
}

function EventDetails({ node, lane, projectId, previous, next, onSelect, onClose }) {
  const [copied, setCopied] = useState(false)
  const details = Object.entries(node.details || {}).filter(([, value]) => value !== '' && value != null)
  const summary = SUMMARIES[node.action] || `${node.label}${node.description ? ` — ${node.description}` : ''}.`
  const section = SECTION_FOR[node.category] || 'overview'
  const sha = node.details?.sha
  function copySha() {
    navigator.clipboard?.writeText(sha).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  return <div className="wt-details" style={{ '--node-color': lane?.color || '#ef5a24' }}>
    <div className="wt-details-main">
      <div className="wt-details-top">
        <span className="wt-details-chip"><i/>{lane?.label || 'Activity'}</span>
        <span className={`wt-details-status ${/fail|error/i.test(node.status || '') ? 'bad' : ''}`}>{String(node.status || 'recorded').replace(/_/g, ' ')}</span>
        <span className="wt-details-when" title={new Date(node.occurredAt).toLocaleString()}>{relativeTime(node.occurredAt)}</span>
      </div>
      <h3>{node.label}</h3>
      {node.description && <p className="wt-details-desc">{node.description}</p>}
      <p className="wt-details-summary">{summary}</p>
      <dl className="wt-details-grid">
        <div><dt>Triggered by</dt><dd>{node.actor || 'Unknown'}</dd></div>
        <div><dt>When</dt><dd>{new Date(node.occurredAt).toLocaleString()}</dd></div>
        <div><dt>Activity type</dt><dd>{String(node.action || '').toLowerCase().replace(/_/g, ' ')}</dd></div>
        {details.map(([key, value]) => <div key={key}><dt>{FIELD_LABELS[key] || key}</dt><dd className={key === 'sha' || key === 'runId' ? 'mono' : ''}>{key === 'sha' ? String(value).slice(0, 10) : String(value)}{key === 'sha' && <button type="button" className="wt-copy" onClick={copySha}>{copied ? 'Copied' : 'Copy'}</button>}</dd></div>)}
      </dl>
    </div>
    <div className="wt-details-side">
      <button type="button" className="wt-details-close" onClick={onClose} aria-label="Close details">×</button>
      <Link className="wt-details-open" to={`/projects/${projectId}?section=${section}`}>{OPEN_LABEL[node.category] || 'Open in project'} →</Link>
      <div className="wt-details-nav">
        <button type="button" disabled={!previous} onClick={() => previous && onSelect(previous.id)}><small>Previous in {lane?.label || 'lane'}</small><span>{previous ? previous.label : '—'}</span></button>
        <button type="button" disabled={!next} onClick={() => next && onSelect(next.id)}><small>Next in {lane?.label || 'lane'}</small><span>{next ? next.label : '—'}</span></button>
      </div>
    </div>
  </div>
}
export default function ProjectWorkTree({projectId}){
  const [data,setData]=useState(null)
  const [error,setError]=useState('')
  const [checkedAt,setCheckedAt]=useState(null)
  const [selected,setSelected]=useState('')
  const [category,setCategory]=useState('all')
  const [zoom,setZoom]=useState(0.7)
  const [limit,setLimit]=useState(100)
  const [loading,setLoading]=useState(true)
  const viewport=useRef(null)
  const drag=useRef(null)
  const revision=useRef('')
  const refresh=useCallback(async signal=>{
    try{
      const next=await request(`/projects/${projectId}/work-tree?${new URLSearchParams({limit:String(limit),...(revision.current?{revision:revision.current}:{})})}`,{signal})
      if(signal?.aborted)return
      if(!next.unchanged){revision.current=next.revision;setData(next)}
      setCheckedAt(new Date());setError('');setLoading(false)
    }catch(failure){if(!signal?.aborted){setError(failure.message);setLoading(false)}}
  },[projectId,limit])
  useEffect(()=>{
    const controller=new AbortController();let pending=false
    async function poll(){if(document.hidden||pending)return;pending=true;try{await refresh(controller.signal)}finally{pending=false}}
    poll();const timer=setInterval(poll,5000);window.addEventListener('focus',poll);document.addEventListener('visibilitychange',poll)
    return()=>{clearInterval(timer);controller.abort();window.removeEventListener('focus',poll);document.removeEventListener('visibilitychange',poll)}
  },[refresh])
  const filtered=useMemo(()=>data?.nodes.filter(node=>category==='all'||node.category===category)||[],[data,category])
  const graph=useMemo(()=>data?layoutWorkTree(data.project,filtered,data.lanes):null,[data,filtered])
  const selectedNode=data?.nodes.find(node=>node.id===selected)
  function fit(){if(graph&&viewport.current){setZoom(Math.min(1,(viewport.current.clientWidth-32)/graph.width));viewport.current.scrollTo({top:0,left:0,behavior:'smooth'})}}
  function focus(id){const node=graph?.nodes.find(node=>node.id===id);if(node&&viewport.current){setSelected(node.id);viewport.current.scrollTo({top:Math.max(0,node.y*zoom-100),left:Math.max(0,node.x*zoom-viewport.current.clientWidth/2+node.width*zoom/2),behavior:'smooth'})}}
  function latest(){const node=graph?.nodes.find(node=>node.id===filtered.at(-1)?.id);if(node&&viewport.current){setSelected(node.id);viewport.current.scrollTo({top:Math.max(0,node.y*zoom-100),left:Math.max(0,node.x*zoom-viewport.current.clientWidth/2+node.width*zoom/2),behavior:'smooth'})}}
  return <section className="wt-panel" aria-label="Live project work tree">
    <div className="wt-heading"><div><span className="wt-eyebrow">PROJECT ACTIVITY, CONNECTED</span><h2>Working tree <span className={`wt-live ${error?'offline':''}`}><i/>{error?'Reconnecting':'Live'}</span></h2><p>Real events form the tree automatically as your project moves forward.</p></div><div className="wt-controls"><label><span className="wt-sr-only">Activity branch</span><select value={category} onChange={event=>{setCategory(event.target.value);setSelected('')}}><option value="all">All branches</option>{data?.lanes.map(lane=><option key={lane.id} value={lane.id}>{lane.label}</option>)}</select></label><button onClick={()=>refresh()}>Refresh</button></div></div>
    <div className="wt-toolbar"><span>READ ONLY · Connectors show activity order</span><div><button onClick={latest} disabled={!filtered.length}>Latest event</button><button aria-label="Zoom out" onClick={()=>setZoom(value=>Math.max(0.3,value-0.1))}>−</button><span>{Math.round(zoom*100)}%</span><button aria-label="Zoom in" onClick={()=>setZoom(value=>Math.min(1.4,value+0.1))}>+</button><button onClick={fit}>Fit width</button></div></div>
    {error&&<p className="wt-error" role="alert">{error} <button onClick={()=>refresh()}>Retry</button></p>}
    <div className="wt-viewport" ref={viewport} tabIndex={0} aria-label="Project activity graph. Scroll or drag the background to explore." onPointerDown={event=>{if(event.button!==0||event.target.closest('button'))return;drag.current={x:event.clientX,y:event.clientY,left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop};event.currentTarget.setPointerCapture(event.pointerId)}} onPointerMove={event=>{if(!drag.current)return;event.currentTarget.scrollLeft=drag.current.left-(event.clientX-drag.current.x);event.currentTarget.scrollTop=drag.current.top-(event.clientY-drag.current.y)}} onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}}>
      {loading&&!data?<div className="wt-empty" role="status">Loading project events…</div>:graph?<div style={{width:graph.width*zoom,height:graph.height*zoom}}><div style={{transform:`scale(${zoom})`,transformOrigin:'top left'}}><WorkTreeCanvas graph={graph} selected={selected} onSelect={setSelected}/></div></div>:!error&&<div className="wt-empty">Your project activity will appear here.</div>}
    </div>
    {selectedNode&&(()=>{const sameLane=filtered.filter(node=>node.category===selectedNode.category);const index=sameLane.findIndex(node=>node.id===selectedNode.id);return <EventDetails node={selectedNode} lane={graph?.nodes.find(node=>node.kind==='lane'&&node.category===selectedNode.category)?{...data.lanes.find(lane=>lane.id===selectedNode.category),color:graph.nodes.find(node=>node.kind==='lane'&&node.category===selectedNode.category).color}:data?.lanes.find(lane=>lane.id===selectedNode.category)} projectId={projectId} previous={sameLane[index-1]} next={sameLane[index+1]} onSelect={focus} onClose={()=>setSelected('')}/>})()}
    <div className="wt-footer"><span>{data?`${data.nodes.length} events loaded`:'Waiting for events'} · Updates every 5 seconds{checkedAt&&` · Checked ${checkedAt.toLocaleTimeString()}`}</span>{data?.hasOlder&&limit<300&&<button onClick={()=>{revision.current='';setLimit(value=>Math.min(300,value+100))}}>Load older events</button>}{data?.hasOlder&&limit>=300&&<span>Showing the latest 300 audit events</span>}</div>
  </section>
}
