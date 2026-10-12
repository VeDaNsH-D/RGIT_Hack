import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMongo, stopMongo } from './harness.js';
let server,origin,userToken,otherToken,projectId,otherProject,clientInfo,config,oauthTokens,keyId,McpAccessKey,McpOAuthRequest;
const clients=[];
const json=(url,body,token)=>fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
const tokenCall=body=>fetch(`${origin}/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientInfo.client_id,...body})});
async function authorize(scope='projects:read projects:write'){
  const verifier=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const url=new URL('/authorize',origin);for(const [key,value] of Object.entries({client_id:clientInfo.client_id,redirect_uri:'https://ai.example.test/callback',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope,state:'test-state',resource:`${origin}/mcp`}))url.searchParams.set(key,value);
  const response=await fetch(url,{redirect:'manual'});assert.equal(response.status,302);
  const redirect=new URL(response.headers.get('location'));assert.equal(redirect.origin,'http://localhost:5173');
  return {requestId:redirect.searchParams.get('request'),verifier};
}
before(async()=>{
  await startMongo();({config}=await import('../../src/config.js'));
  const {User}=await import('../../src/models/User.js'); const {signAuthToken}=await import('../../src/middleware/auth.js');
  ;({McpAccessKey}=await import('../../src/models/McpAccessKey.js'));({McpOAuthRequest}=await import('../../src/models/McpOAuth.js'));
  userToken=signAuthToken(await User.create({name:'OAuth User',email:'oauth-mcp@example.test'}));otherToken=signAuthToken(await User.create({name:'Other',email:'oauth-other@example.test'}));
  server=await new Promise(resolve=>{const value=createServer().listen(0,'127.0.0.1',()=>resolve(value));});origin=`http://127.0.0.1:${server.address().port}`;config.apiBaseUrl=origin;config.frontendUrl='http://localhost:5173';const {app}=await import('../../src/app.js');server.on('request',app);
  projectId=(await (await json(`${origin}/api/projects`,{name:'OAuth launch'},userToken)).json()).project.id;
  otherProject=(await (await json(`${origin}/api/projects`,{name:'Other project'},otherToken)).json()).project.id;
  const registration=await json(`${origin}/register`,{client_name:'Test AI',redirect_uris:['https://ai.example.test/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});assert.equal(registration.status,201);clientInfo=await registration.json();
});
after(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await new Promise(resolve=>server?.close(resolve));await stopMongo();});
test('OAuth discovery advertises deployment URL and MCP 401 points clients to metadata',async()=>{
  const metadata=await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();assert.equal(metadata.resource,`${origin}/mcp`);assert.equal(metadata.authorization_servers[0],`${origin}/`);
  const auth=await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();assert.equal(auth.registration_endpoint,`${origin}/register`);
  const response=await json(`${origin}/mcp`,{jsonrpc:'2.0',id:1,method:'tools/list',params:{}});assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/resource_metadata/);
  assert.equal((await (await fetch(`${origin}/api/mcp/info`)).json()).url,`${origin}/mcp`);
});
test('sign-in and explicit consent bind selected projects to a PKCE-protected code',async()=>{
  const {requestId,verifier}=await authorize();
  const previewUrl=`${origin}/api/mcp/oauth/requests/${requestId}`;
  assert.equal((await json(previewUrl)).status,401);
  const preview=await (await json(previewUrl,undefined,userToken)).json();assert.equal(preview.clientName,'Test AI');
  const deniedScope=await json(previewUrl,{decision:'allow',projectIds:[otherProject],access:'write'},userToken);assert.equal(deniedScope.status,403);
  const approval=await json(previewUrl,{decision:'allow',projectIds:[projectId],access:'read'},userToken);assert.equal(approval.status,200,JSON.stringify(await approval.clone().json()));
  const returnUrl=new URL((await approval.json()).redirectUrl);assert.equal(returnUrl.searchParams.get('state'),'test-state');const code=returnUrl.searchParams.get('code');assert.ok(code);
  let response=await tokenCall({grant_type:'authorization_code',code,code_verifier:'wrong-verifier',redirect_uri:'https://ai.example.test/callback',resource:`${origin}/mcp`});assert.equal(response.status,400);
  response=await tokenCall({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:'https://ai.example.test/callback',resource:'https://other.example/mcp'});assert.equal(response.status,400);
  response=await tokenCall({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:'https://ai.example.test/callback',resource:`${origin}/mcp`});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));oauthTokens=await response.json();assert.equal(oauthTokens.scope,'projects:read');
  assert.equal((await tokenCall({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:'https://ai.example.test/callback'})).status,400);
  const client=new Client({name:'oauth-client',version:'1.0.0'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${oauthTokens.access_token}`}}}));
  const projects=JSON.parse((await client.callTool({name:'list_projects',arguments:{}})).content[0].text).projects;assert.deepEqual(projects.map(project=>project.id),[projectId]);assert.ok(!(await client.listTools()).tools.some(tool=>tool.name==='create_task'));
  keyId=(await McpAccessKey.findOne({oauthClientId:clientInfo.client_id})).id;
});
test('refresh tokens rotate, cannot increase scopes, and revocation invalidates all access',async()=>{
  let response=await tokenCall({grant_type:'refresh_token',refresh_token:oauthTokens.refresh_token,scope:'projects:read projects:write',resource:`${origin}/mcp`});assert.equal(response.status,400);
  response=await tokenCall({grant_type:'refresh_token',refresh_token:oauthTokens.refresh_token,resource:`${origin}/mcp`});assert.equal(response.status,200);const refreshed=await response.json();assert.notEqual(refreshed.refresh_token,oauthTokens.refresh_token);
  assert.equal((await tokenCall({grant_type:'refresh_token',refresh_token:oauthTokens.refresh_token})).status,400);
  await fetch(`${origin}/api/mcp/keys/${keyId}`,{method:'DELETE',headers:{Authorization:`Bearer ${userToken}`}});
  const responseMcp=await fetch(`${origin}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${refreshed.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})});assert.equal(responseMcp.status,401);
  assert.equal((await tokenCall({grant_type:'refresh_token',refresh_token:refreshed.refresh_token})).status,400);
});
test('denial, expired requests and unregistered redirects never grant access',async()=>{
  const {requestId}=await authorize('projects:read');
  const deny=await json(`${origin}/api/mcp/oauth/requests/${requestId}`,{decision:'deny'},userToken);assert.equal(deny.status,200);assert.equal(new URL((await deny.json()).redirectUrl).searchParams.get('error'),'access_denied');
  assert.equal((await json(`${origin}/api/mcp/oauth/requests/${requestId}`,{decision:'allow',projectIds:[projectId]},userToken)).status,410);
  const next=await authorize();await McpOAuthRequest.updateOne({requestHash:createHash('sha256').update(next.requestId).digest('hex')},{$set:{expiresAt:new Date(0)}});
  assert.equal((await json(`${origin}/api/mcp/oauth/requests/${next.requestId}`,undefined,userToken)).status,410);
  const url=new URL('/authorize',origin);url.searchParams.set('client_id',clientInfo.client_id);url.searchParams.set('redirect_uri','https://evil.example/callback');assert.equal((await fetch(url,{redirect:'manual'})).status,400);
});

test('a real MCP client completes discovery, registration and browser-style OAuth without manual keys',async()=>{
  let info,savedTokens,verifier,authorizationUrl;
  const provider={
    get redirectUrl(){return new URL('https://ai.example.test/callback');},
    get clientMetadata(){return {client_name:'Hosted AI',redirect_uris:['https://ai.example.test/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']};},
    clientInformation(){return info;},saveClientInformation(value){info=value;},tokens(){return savedTokens;},saveTokens(value){savedTokens=value;},saveCodeVerifier(value){verifier=value;},codeVerifier(){return verifier;},redirectToAuthorization(url){authorizationUrl=url;},
  };
  const transport=new StreamableHTTPClientTransport(new URL(`${origin}/mcp`),{authProvider:provider});
  const initial=new Client({name:'hosted-ai-initial',version:'1.0.0'});clients.push(initial);
  await assert.rejects(initial.connect(transport));assert.ok(authorizationUrl);
  const response=await fetch(authorizationUrl,{redirect:'manual'});assert.equal(response.status,302);
  const requestId=new URL(response.headers.get('location')).searchParams.get('request');
  const spoofed=await fetch(`${origin}/api/mcp/oauth/requests/${requestId}`,{headers:{'x-user-id':'000000000000000000000001'}});assert.equal(spoofed.status,401);
  const approved=await json(`${origin}/api/mcp/oauth/requests/${requestId}`,{decision:'allow',projectIds:[projectId],access:'read'},userToken);assert.equal(approved.status,200);
  const code=new URL((await approved.json()).redirectUrl).searchParams.get('code');
  await transport.finishAuth(code);assert.ok(savedTokens.access_token);
  const ready=new Client({name:'hosted-ai',version:'1.0.0'});clients.push(ready);await ready.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`),{authProvider:provider}));
  assert.ok((await ready.listTools()).tools.some(tool=>tool.name==='get_project_context'));
});
test('confidential clients keep their generated secrets encrypted in storage',async()=>{
  const response=await json(`${origin}/register`,{client_name:'Confidential AI',redirect_uris:['https://ai.example.test/callback'],token_endpoint_auth_method:'client_secret_post'});assert.equal(response.status,201);const client=await response.json();assert.ok(client.client_secret);
  const {McpOAuthClient}=await import('../../src/models/McpOAuth.js');const stored=await McpOAuthClient.findOne({clientId:client.client_id}).select('+sealedSecret').lean();assert.ok(stored.sealedSecret);assert.notEqual(stored.sealedSecret,client.client_secret);assert.equal(stored.metadata.client_secret,undefined);
  const {oauthProvider}=await import('../../src/mcp/oauth.js');assert.equal((await oauthProvider.clientsStore.getClient(client.client_id)).client_secret,client.client_secret);
});
