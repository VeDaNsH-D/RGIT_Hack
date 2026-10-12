import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { startMongo, stopMongo } from './harness.js';
let server,origin,ownerToken,outsiderToken,owner,outsider,projectId,otherId,readKey,writeKey,readClient,writeClient,Task,ProjectMembership,McpAccessKey;
const clients=[];
const call=(path,method='GET',body,token=ownerToken)=>fetch(`${origin}/api${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
async function connect(key){const client=new Client({name:'mcp-integration-test',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${key}`}}}));clients.push(client);return client;}
async function createKey(access='read',userToken=ownerToken,projectIds=[projectId]){const response=await call('/mcp/keys','POST',{name:'Test AI',projectIds,access},userToken);assert.equal(response.status,201,JSON.stringify(await response.clone().json()));return response.json();}
const args=result=>JSON.parse(result.content[0].text);
before(async()=>{
  await startMongo();
  const {User}=await import('../../src/models/User.js');
  ;({Task}=await import('../../src/models/Task.js'));
  ;({ProjectMembership}=await import('../../src/models/ProjectMembership.js'));
  ;({McpAccessKey}=await import('../../src/models/McpAccessKey.js'));
  const {signAuthToken}=await import('../../src/middleware/auth.js');
  owner=await User.create({name:'MCP Owner',email:'mcp-owner@example.test'});outsider=await User.create({name:'Other User',email:'mcp-other@example.test'});
  ownerToken=signAuthToken(owner);outsiderToken=signAuthToken(outsider);
  const {app}=await import('../../src/app.js');
  server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});origin=`http://127.0.0.1:${server.address().port}`;
  projectId=(await (await call('/projects','POST',{name:'MCP launch'})).json()).project.id;
  otherId=(await (await call('/projects','POST',{name:'Unscoped project'})).json()).project.id;
  readKey=await createKey();writeKey=await createKey('write');
  readClient=await connect(readKey.token);writeClient=await connect(writeKey.token);
});
after(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await new Promise(resolve=>server?.close(resolve));await stopMongo();});
test('real HTTP client discovers read tools, resources and prompts; only scoped projects appear',async()=>{
  const tools=await readClient.listTools();assert.ok(tools.tools.some(tool=>tool.name==='get_project_context'));assert.ok(!tools.tools.some(tool=>tool.name==='create_task'));
  const result=await readClient.callTool({name:'list_projects',arguments:{}});assert.deepEqual(args(result).projects.map(project=>project.id),[projectId]);
  const context=await readClient.callTool({name:'get_project_context',arguments:{projectId}});assert.equal(context.isError,undefined);assert.equal(args(context).project.name,'MCP launch');
  const tree=await readClient.callTool({name:'get_project_work_tree',arguments:{projectId}});assert.equal(args(tree).project.id,projectId);
  const resources=await readClient.listResourceTemplates();assert.match(resources.resourceTemplates[0].uriTemplate,/over2u/);
  const resource=await readClient.readResource({uri:`over2u://projects/${projectId}/context`});assert.equal(JSON.parse(resource.contents[0].text).project.name,'MCP launch');
  assert.ok((await readClient.listPrompts()).prompts.some(prompt=>prompt.name==='project_brief'));
});
test('project scope and read-only tools prevent unintended writes and cross-project reads',async()=>{
  const response=await readClient.callTool({name:'get_project_context',arguments:{projectId:otherId}});assert.equal(response.isError,true);
  const write=await readClient.callTool({name:'create_task',arguments:{projectId,title:'Blocked task',confirmed:true}});assert.equal(write.isError,true);
  assert.equal(await Task.countDocuments({projectId}),0);
  const rejected=await call('/mcp/keys','POST',{name:'Other key',projectIds:[projectId]},outsiderToken);assert.equal(rejected.status,403);
});
test('confirmed writes go through existing APIs, preserve roles and produce live context',async()=>{
  let result=await writeClient.callTool({name:'create_task',arguments:{projectId,title:'Review docs',confirmed:false}});assert.equal(result.isError,true);
  result=await writeClient.callTool({name:'create_task',arguments:{projectId,title:'Review docs',confirmed:true}});assert.equal(result.isError,undefined,JSON.stringify(result));
  const taskId=args(result).task.id;
  result=await writeClient.callTool({name:'update_task',arguments:{projectId,taskId,status:'completed',confirmed:true}});assert.equal(args(result).task.status,'completed');
  result=await writeClient.callTool({name:'add_project_note',arguments:{projectId,title:'Launch decision',content:'Launch after docs review.',recordType:'decision',confirmed:true}});assert.equal(result.isError,undefined);
  const notes=await readClient.callTool({name:'list_project_notes',arguments:{projectId}});assert.match(JSON.stringify(args(notes)),/Launch decision/);
  const foreign=(await (await call(`/projects/${otherId}/tasks`,'POST',{title:'Other task'})).json()).task;
  const blocked=await writeClient.callTool({name:'update_task',arguments:{projectId,taskId:foreign.id,title:'Wrong scope',confirmed:true}});assert.equal(blocked.isError,true);
});
test('keys are hashed, listed without secrets, authenticated and host/origin protected',async()=>{
  const stored=await McpAccessKey.findById(readKey.key.id).select('+tokenHash').lean();assert.notEqual(stored.tokenHash,readKey.token);
  const list=await (await call('/mcp/keys')).json();assert.doesNotMatch(JSON.stringify(list),new RegExp(readKey.token));assert.equal(JSON.stringify(list).includes('tokenHash'),false);
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
  const unauth=await fetch(`${origin}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body});assert.equal(unauth.status,401);
  const originBlocked=await fetch(`${origin}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${readKey.token}`,Origin:'https://evil.example'},body});assert.equal(originBlocked.status,403);
});
test('stdio bridge works with a real client and preserves server tools',async()=>{
  const client=new Client({name:'stdio-test',version:'1.0.0'});clients.push(client);
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../scripts/mcp-stdio.js',import.meta.url))],env:{...process.env,OVER2U_MCP_URL:`${origin}/mcp`,OVER2U_MCP_TOKEN:readKey.token}}));
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='get_project_context'));
  assert.equal(args(await client.callTool({name:'list_projects',arguments:{}})).projects[0].id,projectId);
});
test('lost project membership, expiration and revocation take effect on subsequent calls',async()=>{
  await ProjectMembership.create({projectId,userId:outsider._id,role:'member',invitedBy:owner._id});
  const key=await createKey('write',outsiderToken);const client=await connect(key.token);
  await ProjectMembership.updateOne({projectId,userId:outsider._id},{$set:{role:'viewer'}});
  const blocked=await client.callTool({name:'create_task',arguments:{projectId,title:'Role blocked',confirmed:true}});assert.equal(blocked.isError,true);
  await ProjectMembership.deleteOne({projectId,userId:outsider._id});
  assert.equal((await client.callTool({name:'get_project_context',arguments:{projectId}})).isError,true);
  await McpAccessKey.updateOne({_id:key.key.id},{$set:{expiresAt:new Date(0)}});
  await assert.rejects(client.callTool({name:'list_projects',arguments:{}}));
  assert.equal((await call(`/mcp/keys/${readKey.key.id}`,'DELETE')).status,200);
  await assert.rejects(readClient.callTool({name:'list_projects',arguments:{}}));
});
