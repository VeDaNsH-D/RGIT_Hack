import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { startMongo, stopMongo } from '../../Backend/tests/mongo-integration/harness.js'
let server, origin, token, outsider, projectId, otherProjectId, records, review, User, Task, SourceRecord, EmailConnection, ActivityEvent, tools
const originalFetch = globalThis.fetch
let refreshed = false
let profileDisabled = false
let exchangeExpired = false
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type':'application/json' } })
const gmail = id => ({ id, messages:[{ id:`${id}-message`, internalDate:'1791806400000', snippet:'Prepare release notes.', payload:{ mimeType:'text/plain', headers:[{name:'Subject',value:`Project ${id}`},{name:'From',value:'sam@example.test'}], body:{ data:Buffer.from('Please prepare the release notes by October 20, 2026.').toString('base64url') } } }] })
before(async () => {
  process.env.MICROSOFT_CLIENT_ID='test-outlook-client'; process.env.MICROSOFT_CLIENT_SECRET='test-outlook-secret'
  await startMongo()
  const { config } = await import('../../Backend/src/config.js')
  config.oauth.google={enabled:true,clientId:'test-client',clientSecret:'test-secret'}; config.frontendUrl='http://localhost:5173'
  ;({ User }=await import('../../Backend/src/models/User.js'))
  ;({ Task }=await import('../../Backend/src/models/Task.js'))
  ;({ SourceRecord }=await import('../../Backend/src/models/SourceRecord.js'))
  ;({ EmailConnection }=await import('../../Backend/src/models/EmailConnection.js'))
  ;({ ActivityEvent }=await import('../../Backend/src/models/ActivityEvent.js'))
  tools=await import('../../Backend/src/email/providers.js')
  const { signAuthToken }=await import('../../Backend/src/middleware/auth.js')
  token=signAuthToken(await User.create({name:'Owner',email:'owner@example.test'}))
  outsider=signAuthToken(await User.create({name:'Other',email:'other@example.test'}))
  const { app }=await import('../../Backend/src/app.js')
  server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value))})
  origin=`http://127.0.0.1:${server.address().port}`; config.apiBaseUrl=origin
  globalThis.fetch=async(url,options={})=> {
    const address=String(url)
    if(address==='https://oauth2.googleapis.com/token') {
      if (exchangeExpired) return new Response(JSON.stringify({error:'invalid_grant'}), {status:400,headers:{'Content-Type':'application/json'}})
      if(options.body.get('grant_type')==='refresh_token') refreshed=true
      else assert.ok(options.body.get('code_verifier'))
      return json({access_token:'gmail-test-token',refresh_token:'test-refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/gmail.readonly'})
    }
    if(address.startsWith('https://login.microsoftonline.com/')&&address.endsWith('/token')) return json({access_token:'outlook-test-token',refresh_token:'test-refresh',expires_in:3600,scope:'Mail.Read User.Read offline_access'})
    if(address==='https://gmail.googleapis.com/gmail/v1/users/me/profile') return profileDisabled ? new Response(JSON.stringify({error:{details:[{reason:'SERVICE_DISABLED'}]}}),{status:403,headers:{'Content-Type':'application/json'}}) : json({emailAddress:'mailbox@example.test'})
    if(address.includes('gmail/v1/users/me/threads?')) return json({threads:[{id:'t1'},{id:'t2'}]})
    if(address.includes('gmail/v1/users/me/threads/')) return json(gmail(new URL(address).pathname.split('/').at(-1)))
    if(address.startsWith('https://graph.microsoft.com/v1.0/me?')) return json({mail:'outlook@example.test'})
    if(address.startsWith('https://graph.microsoft.com/v1.0/me/messages')) return json({value:[{id:'m1',conversationId:'c1',subject:'Outlook planning',from:{emailAddress:{address:'sam@example.test'}},receivedDateTime:'2026-10-12T12:00:00Z',bodyPreview:'Review the API.',body:{contentType:'text',content:'Review the API.'}}]})
    if(address.startsWith('http://127.0.0.1:8001/')) {const pack=JSON.parse(options.body);return json({case_id:pack.case_id,summary:'Release notes requested.',proposed_tasks:[{title:'Prepare release notes',description:'Launch notes',priority:'high',source_ids:[pack.sources[0].id]}],missing_information:[],decisions:[],blockers:[]})}
    return originalFetch(url,options)
  }
  projectId=(await api('/api/projects','POST',{name:'Email project'})).body.project.id
  otherProjectId=(await api('/api/projects','POST',{name:'Other project'},outsider)).body.project.id
})
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await stopMongo();globalThis.fetch=originalFetch})
async function api(path,method='GET',body,auth=token){const result=await originalFetch(`${origin}${path}`,{method,headers:{Authorization:`Bearer ${auth}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:result.status,body:await result.json()}}
async function connect(provider){
  const start=await originalFetch(`${origin}/api/email/oauth/${provider}/start`,{method:'POST',headers:{Authorization:`Bearer ${token}`}})
  assert.equal(start.status,200);const url=new URL((await start.json()).authorizationUrl)
  const result=await originalFetch(`${origin}/api/email/oauth/${provider}/callback?${new URLSearchParams({state:url.searchParams.get('state'),code:'test-code'})}`,{redirect:'manual',headers:{Cookie:start.headers.get('set-cookie').split(';')[0]}})
  assert.equal(new URL(result.headers.get('location')).searchParams.get('connected'),provider)
}
test('Gmail consent stores encrypted tokens and mailbox responses do not expose them',async()=>{
  await connect('gmail');const saved=await EmailConnection.findOne({provider:'gmail'}).select('+encryptedTokens')
  assert.ok(!saved.encryptedTokens.includes('gmail-test-token'));assert.equal(tools.decryptTokens(saved.encryptedTokens).refresh_token,'test-refresh')
  assert.ok(!JSON.stringify((await api('/api/email/connections')).body).includes('gmail-test-token'))
})
test('Outlook consent, conversation listing, and full message reading work',async()=>{
  await connect('outlook');assert.equal((await api('/api/email/outlook/threads')).body.threads[0].id,'c1')
  assert.equal((await api('/api/email/outlook/threads/c1')).body.thread.messages[0].body,'Review the API.')
})
test('each user can access only their connected mailbox',async()=>{
  assert.equal((await api('/api/email/gmail/threads','GET',undefined,outsider)).status,400)
  assert.deepEqual((await api('/api/email/connections','GET',undefined,outsider)).body.connections,[])
})
test('selected threads are logged and repeated imports are idempotent',async()=>{
  assert.equal((await api('/api/email/gmail/threads')).body.threads.length,2)
  const result=await api(`/api/email/projects/${projectId}/import`,'POST',{provider:'gmail',threadIds:['t1']})
  assert.equal(result.status,201);records=result.body.records.map(record=>record.id)
  await api(`/api/email/projects/${projectId}/import`,'POST',{provider:'gmail',threadIds:['t1']})
  assert.equal(await SourceRecord.countDocuments({projectId,provider:'gmail'}),1)
  assert.equal(await SourceRecord.countDocuments({projectId,'metadata.threadId':'t2'}),0)
  assert.ok(await ActivityEvent.findOne({projectId,action:'EMAIL_CONVERSATION_IMPORTED'}))
})
test('cross-project access and foreign email records are rejected',async()=>{
  assert.ok([403,404].includes((await api(`/api/email/projects/${otherProjectId}/import`,'POST',{provider:'gmail',threadIds:['t1']})).status))
  assert.equal((await api(`/api/email/projects/${otherProjectId}/analyze`,'POST',{recordIds:records},outsider)).status,400)
})
test('AI proposals do not change tasks until approved and approval is idempotent',async()=>{
  const result=await api(`/api/email/projects/${projectId}/analyze`,'POST',{recordIds:records});assert.equal(result.status,201);review=result.body.review
  assert.equal(await Task.countDocuments({projectId}),0)
  const path=`/api/email/projects/${projectId}/reviews/${review.id}/items/${review.items[0].id}`
  assert.equal((await api(path,'POST',{action:'apply'})).status,200)
  assert.equal((await api(path,'POST',{action:'apply'})).body.alreadyReviewed,true)
  assert.equal(await Task.countDocuments({projectId}),1)
  assert.equal(String((await Task.findOne({projectId})).sourceRecordId),records[0])
  assert.ok(await ActivityEvent.findOne({projectId,action:'EMAIL_WORKFLOW_CHANGE_APPLIED'}))
})
test('approved updates modify existing project tasks but reject foreign tasks',async()=>{
  const next=(await api(`/api/email/projects/${projectId}/analyze`,'POST',{recordIds:records})).body.review
  const foreign=(await api(`/api/projects/${otherProjectId}/tasks`,'POST',{title:'Foreign task'},outsider)).body.task
  const path=`/api/email/projects/${projectId}/reviews/${next.id}/items/${next.items[0].id}`
  assert.equal((await api(path,'POST',{action:'apply',targetTaskId:foreign.id})).status,400)
  const task=await Task.findOne({projectId})
  assert.equal((await api(path,'POST',{action:'apply',targetTaskId:String(task._id),taskStatus:'completed'})).status,200)
  assert.equal((await Task.findById(task._id)).status,'completed');assert.equal(await Task.countDocuments({projectId}),1)
})
test('expired credentials refresh and disconnect preserves imported logs',async()=>{
  const saved=await EmailConnection.findOne({provider:'gmail'}).select('+encryptedTokens');const value=tools.decryptTokens(saved.encryptedTokens);value.expiresAt=0;saved.encryptedTokens=tools.encryptTokens(value);await saved.save()
  assert.equal((await api('/api/email/gmail/threads')).status,200);assert.equal(refreshed,true)
  assert.equal((await api('/api/email/connections/gmail','DELETE')).status,200);assert.equal((await api('/api/email/gmail/threads')).status,400)
  assert.equal((await api(`/api/email/projects/${projectId}/log`)).body.records.length,1)
})
test('mailbox callbacks reject state without the originating browser cookie',async()=>{
  const start=await originalFetch(`${origin}/api/email/oauth/gmail/start`,{method:'POST',headers:{Authorization:`Bearer ${token}`}})
  const url=new URL((await start.json()).authorizationUrl)
  const result=await originalFetch(`${origin}/api/email/oauth/gmail/callback?${new URLSearchParams({state:url.searchParams.get('state'),code:'test-code'})}`,{redirect:'manual'})
  assert.equal(new URL(result.headers.get('location')).searchParams.get('emailError'),'invalid_state')
})
test('Outlook pagination cannot be used to request another host',async()=>{
  const pageToken=Buffer.from('https://attacker.example/v1.0/me/messages').toString('base64url')
  assert.equal((await api(`/api/email/outlook/threads?pageToken=${pageToken}`)).status,400)
})

async function failedConnection() {
  const start=await originalFetch(`${origin}/api/email/oauth/gmail/start`,{method:'POST',headers:{Authorization:`Bearer ${token}`}})
  const url=new URL((await start.json()).authorizationUrl)
  const result=await originalFetch(`${origin}/api/email/oauth/gmail/callback?${new URLSearchParams({state:url.searchParams.get('state'),code:'test-code'})}`,{redirect:'manual',headers:{Cookie:start.headers.get('set-cookie').split(';')[0]}})
  return new URL(result.headers.get('location')).searchParams.get('emailError')
}
test('disabled Gmail API produces a specific setup error without storing tokens',async()=>{
  profileDisabled=true
  try { assert.equal(await failedConnection(),'gmail_api_disabled'); assert.equal(await EmailConnection.countDocuments({provider:'gmail'}),0) }
  finally { profileDisabled=false }
})
test('expired authorization code produces a fresh-connection error',async()=>{
  exchangeExpired=true
  try { assert.equal(await failedConnection(),'oauth_code_expired') }
  finally { exchangeExpired=false }
})
