import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  function latest(){const node=graph?.nodes.find(node=>node.id===filtered.at(-1)?.id);if(node&&viewport.current){setSelected(node.id);viewport.current.scrollTo({top:Math.max(0,node.y*zoom-100),left:Math.max(0,node.x*zoom-viewport.current.clientWidth/2+node.width*zoom/2),behavior:'smooth'})}}
  return <section className="wt-panel" aria-label="Live project work tree">
    <div className="wt-heading"><div><span className="wt-eyebrow">PROJECT ACTIVITY, CONNECTED</span><h2>Working tree <span className={`wt-live ${error?'offline':''}`}><i/>{error?'Reconnecting':'Live'}</span></h2><p>Real events form the tree automatically as your project moves forward.</p></div><div className="wt-controls"><label><span className="wt-sr-only">Activity branch</span><select value={category} onChange={event=>{setCategory(event.target.value);setSelected('')}}><option value="all">All branches</option>{data?.lanes.map(lane=><option key={lane.id} value={lane.id}>{lane.label}</option>)}</select></label><button onClick={()=>refresh()}>Refresh</button></div></div>
    <div className="wt-toolbar"><span>READ ONLY · Connectors show activity order</span><div><button onClick={latest} disabled={!filtered.length}>Latest event</button><button aria-label="Zoom out" onClick={()=>setZoom(value=>Math.max(0.3,value-0.1))}>−</button><span>{Math.round(zoom*100)}%</span><button aria-label="Zoom in" onClick={()=>setZoom(value=>Math.min(1.4,value+0.1))}>+</button><button onClick={fit}>Fit width</button></div></div>
    {error&&<p className="wt-error" role="alert">{error} <button onClick={()=>refresh()}>Retry</button></p>}
    <div className="wt-viewport" ref={viewport} tabIndex={0} aria-label="Project activity graph. Scroll or drag the background to explore." onPointerDown={event=>{if(event.button!==0||event.target.closest('button'))return;drag.current={x:event.clientX,y:event.clientY,left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop};event.currentTarget.setPointerCapture(event.pointerId)}} onPointerMove={event=>{if(!drag.current)return;event.currentTarget.scrollLeft=drag.current.left-(event.clientX-drag.current.x);event.currentTarget.scrollTop=drag.current.top-(event.clientY-drag.current.y)}} onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}}>
      {loading&&!data?<div className="wt-empty" role="status">Loading project events…</div>:graph?<div style={{width:graph.width*zoom,height:graph.height*zoom}}><div style={{transform:`scale(${zoom})`,transformOrigin:'top left'}}><WorkTreeCanvas graph={graph} selected={selected} onSelect={setSelected}/></div></div>:!error&&<div className="wt-empty">Your project activity will appear here.</div>}
    </div>
    {selectedNode&&<div className="wt-details"><div><span className="wt-eyebrow">EVENT DETAILS</span><h3>{selectedNode.label}</h3><p>{selectedNode.description||'Recorded project activity'}</p><small>{selectedNode.actor} · {new Date(selectedNode.occurredAt).toLocaleString()} · {selectedNode.status}</small>{Object.entries(selectedNode.details||{}).map(([key,value])=><p key={key}><strong>{key}:</strong> {String(value)}</p>)}</div><button onClick={()=>setSelected('')}>Close</button></div>}
    <div className="wt-footer"><span>{data?`${data.nodes.length} events loaded`:'Waiting for events'} · Updates every 5 seconds{checkedAt&&` · Checked ${checkedAt.toLocaleTimeString()}`}</span>{data?.hasOlder&&limit<300&&<button onClick={()=>{revision.current='';setLimit(value=>Math.min(300,value+100))}}>Load older events</button>}{data?.hasOlder&&limit>=300&&<span>Showing the latest 300 audit events</span>}</div>
  </section>
}
