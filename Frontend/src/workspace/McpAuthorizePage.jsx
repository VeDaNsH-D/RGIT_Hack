import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { request } from '../api/client'
import { useWorkspace } from './WorkspaceContext'
import { useAuth } from '../auth/AuthContext'
import { PageHeading } from './ui'
import './mcp.css'
export default function McpAuthorizePage(){
  const [params]=useSearchParams()
  const requestId=params.get('request')||''
  const {projects}=useWorkspace()
  const {session}=useAuth()
  const [details,setDetails]=useState(null)
  const [selected,setSelected]=useState([])
  const [access,setAccess]=useState('read')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  useEffect(()=>{const controller=new AbortController();request(`/mcp/oauth/requests/${encodeURIComponent(requestId)}`,{signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setDetails(data)}).catch(failure=>{if(!controller.signal.aborted)setError(failure.message)});return()=>controller.abort()},[requestId])
  async function decide(decision){
    setBusy(true);setError('')
    try{const data=await request(`/mcp/oauth/requests/${encodeURIComponent(requestId)}`,{method:'POST',body:{decision,projectIds:selected,access}});window.location.assign(data.redirectUrl)}catch(failure){setError(failure.message);setBusy(false)}
  }
  const eligible=projects.filter(project=>!project.loadError&&(access!=='write'||project.myRole!=='viewer'))
  return <><PageHeading eyebrow="AI CONNECTION" title="Connect your projects" description="Choose what this AI client can access. You can revoke the connection at any time."/><section className="ws-panel ws-mcp-card">
    {details?<><h2>{details.clientName} wants to connect</h2><p>Signed in as <strong>{session.user.email}</strong>.</p><p>Requested access: <strong>{details.requestedAccess==='write'?'Read and write':'Read only'}</strong></p><p className="ws-muted">Only selected projects are shared. Read access includes project members, tasks, notes, and imported emails, Notion pages and documents. Write access allows tasks, notes and draft handoffs within your project role.</p><p className="ws-muted">Return address: {details.redirectUri}</p><form className="ws-mcp-form" onSubmit={event=>{event.preventDefault();decide('allow')}}><label>Access to grant<select value={access} disabled={busy} onChange={event=>{setAccess(event.target.value);setSelected([])}}><option value="read">Read only</option>{details.requestedAccess==='write'&&<option value="write">Read and write</option>}</select></label><fieldset disabled={busy}><legend>Projects to connect</legend>{eligible.map(project=><label className="ws-mcp-project" key={project.id}><input type="checkbox" checked={selected.includes(project.id)} onChange={event=>setSelected(event.target.checked?[...selected,project.id]:selected.filter(id=>id!==project.id))}/>{project.name}<span>{project.myRole}</span></label>)}{!eligible.length&&<p>Create or join a project with the required permissions first.</p>}</fieldset><div className="email-proposal-actions"><button className="ws-button" type="button" disabled={busy} onClick={()=>decide('deny')}>Deny</button><button className="ws-button ws-button-primary" disabled={busy||!selected.length}>{busy?'Connecting…':'Allow connection'}</button></div></form></>:!error&&<p role="status">Loading connection request…</p>}
    {error&&<p className="ws-error" role="alert">{error}</p>}<p style={{marginTop:24}}><Link to="/connections">Manage AI connections</Link></p>
  </section></>
}
