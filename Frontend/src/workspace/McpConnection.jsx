import IntegrationLogo from './IntegrationLogo'
import { useEffect, useState } from 'react'
import { request } from '../api/client'
import { useWorkspace } from './WorkspaceContext'
import './mcp.css'
export default function McpConnection(){
  const {projects}=useWorkspace()
  const [keys,setKeys]=useState([])
  const [endpoint,setEndpoint]=useState('')
  const [name,setName]=useState('My AI client')
  const [selected,setSelected]=useState([])
  const [access,setAccess]=useState('read')
  const [days,setDays]=useState('30')
  const [token,setToken]=useState('')
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const available=projects.filter(project=>!project.loadError)
  useEffect(()=>{const controller=new AbortController();Promise.all([request('/mcp/keys',{signal:controller.signal}),request('/mcp/info',{signal:controller.signal})]).then(([data,info])=>{if(!controller.signal.aborted){setKeys(data.keys);setEndpoint(info.url)}}).catch(failure=>{if(!controller.signal.aborted)setError(failure.message)});return()=>controller.abort()},[])
  async function create(event){
    event.preventDefault();setBusy(true);setError('');setNotice('');setToken('')
    try{const data=await request('/mcp/keys',{method:'POST',body:{name,projectIds:selected,access,expiresInDays:Number(days)}});setKeys(previous=>[data.key,...previous]);setToken(data.token)}catch(failure){setError(failure.message)}finally{setBusy(false)}
  }
  async function revoke(id){setBusy(true);setError('');try{await request(`/mcp/keys/${id}`,{method:'DELETE'});setKeys(previous=>previous.map(key=>key.id===id?{...key,revokedAt:new Date().toISOString()}:key));setToken('');setNotice('Access key revoked. It can no longer access your projects.')}catch(failure){setError(failure.message)}finally{setBusy(false)}}
  return <article className="ws-connection-card ws-mcp-card"><div className="ws-project-card-top"><span className="ws-project-symbol"><IntegrationLogo name="mcp"/></span><span className="ws-badge ws-badge-pending">Available</span></div><h3>Work from your AI</h3><p>Connect an MCP-compatible client to live project context. Each key has your permissions and access only to the projects you select.</p>
    <div className="ws-mcp-secret"><strong>Connect from any computer</strong><p>Add this MCP server URL in your AI client. Sign in when prompted and choose projects to authorize.</p><input aria-label="MCP server URL" readOnly value={endpoint} placeholder="Loading server URL…"/><p className="ws-muted">No local repository or Node installation is required for clients that support remote MCP OAuth.</p></div>
    <details className="ws-mcp-setup"><summary>Use an access key instead</summary><form className="ws-mcp-form" onSubmit={create}><label>Key name<input value={name} onChange={event=>setName(event.target.value)} maxLength={80} required disabled={busy}/></label><fieldset disabled={busy}><legend>Projects this AI can access</legend>{available.map(project=><label className="ws-mcp-project" key={project.id}><input type="checkbox" checked={selected.includes(project.id)} onChange={event=>setSelected(event.target.checked?[...selected,project.id]:selected.filter(id=>id!==project.id))}/>{project.name}<span>{project.myRole}</span></label>)}{!available.length&&<p>Create or join a project first.</p>}</fieldset><div className="ws-form-grid"><label>Access<select value={access} onChange={event=>setAccess(event.target.value)} disabled={busy}><option value="read">Read only</option><option value="write">Read and write</option></select></label><label>Expires after<select value={days} onChange={event=>setDays(event.target.value)} disabled={busy}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label></div><p className="ws-muted">Write access allows tasks, notes and draft handoffs. Your project role still applies. Configure your AI client to ask before changes.</p><button className="ws-button ws-button-primary" disabled={busy||!selected.length}>{busy?'Saving…':'Create access key'}</button></form></details>
    {token&&<div className="ws-mcp-secret"><strong>Copy your key now</strong><p>It is shown once. Store it in your private client configuration or .mcp.env.</p><input aria-label="New MCP access key" value={token} readOnly onFocus={event=>event.target.select()}/><div className="email-proposal-actions"><button className="ws-button" onClick={async()=>{try{await navigator.clipboard.writeText(token);setNotice('Access key copied.')}catch{setNotice('Select the key and copy it manually.')}}}>Copy key</button><button className="ws-text-button" onClick={()=>setToken('')}>Hide key</button></div></div>}
    <details className="ws-mcp-setup"><summary>Client setup steps</summary><ol><li>Use the server address shown above.</li><li>Create a key for the project you want to work on.</li><li>For Codex, use the HTTP MCP endpoint with your key as a bearer token. For Claude Desktop, launch Backend/scripts/mcp-stdio.js with Node.</li><li>Follow the full examples in Backend/MCP_SETUP.md.</li><li>Ask your AI to list projects, load project context, and summarize the next steps.</li></ol><p>Connect your AI client to the HTTPS server address shown above. OAuth sign-in and access keys are both supported. Configure your deployed backend and frontend URLs before sharing this address.</p></details>
    {keys.length>0&&<div className="ws-mcp-keys"><h4>Your access keys</h4>{keys.map(key=><div key={key.id}><span><strong>{key.name}</strong><small>{key.prefix}… · {key.access==='read'?'Read only':'Read and write'} · {key.projectIds.length} project(s)</small><small>{key.revokedAt?'Revoked':`Expires ${new Date(key.expiresAt).toLocaleDateString()}`}</small></span>{!key.revokedAt&&<button className="ws-text-button" disabled={busy} onClick={()=>revoke(key.id)}>Revoke</button>}</div>)}</div>}
    {error&&<p className="ws-error" role="alert">{error}</p>}{notice&&<p className="ws-notice" role="status">{notice}</p>}
  </article>
}
