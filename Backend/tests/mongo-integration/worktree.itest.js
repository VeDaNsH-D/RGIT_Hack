import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo } from './harness.js';
let server,origin,ownerToken,memberToken,otherToken,projectId,ProjectMembership,ActivityEvent;
const call=(path,method='GET',body,token=ownerToken)=>fetch(`${origin}/api${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
before(async()=>{
  await startMongo();
  const {User}=await import('../../src/models/User.js');const {signAuthToken}=await import('../../src/middleware/auth.js');
  ;({ProjectMembership}=await import('../../src/models/ProjectMembership.js'));({ActivityEvent}=await import('../../src/models/ActivityEvent.js'));
  const owner=await User.create({name:'Tree Owner',email:'tree-owner@example.test'}),member=await User.create({name:'Tree Viewer',email:'tree-viewer@example.test'}),other=await User.create({name:'Outsider',email:'tree-other@example.test'});
  ownerToken=signAuthToken(owner);memberToken=signAuthToken(member);otherToken=signAuthToken(other);
  const {app}=await import('../../src/app.js');server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});origin=`http://127.0.0.1:${server.address().port}`;
  projectId=(await (await call('/projects','POST',{name:'Live work tree'})).json()).project.id;
  await ProjectMembership.create({projectId,userId:member._id,invitedBy:owner._id,role:'viewer'});
});
after(async()=>{await new Promise(resolve=>server?.close(resolve));await stopMongo();});
test('new audit actions automatically update the graph and revision without frontend writes',async()=>{
  const path=`/projects/${projectId}/work-tree`;
  let graph=await (await call(path)).json();assert.equal(graph.project.name,'Live work tree');assert.equal(graph.nodes.length,0);
  const revision=graph.revision;
  const result=await call(`/projects/${projectId}/tasks`,'POST',{title:'Finish launch review',priority:'high'});assert.equal(result.status,201);
  graph=await (await call(`${path}?revision=${revision}`)).json();assert.equal(graph.unchanged,undefined);assert.notEqual(graph.revision,revision);
  const node=graph.nodes.find(node=>node.action==='TASK_CREATED');assert.equal(node.label,'Task created');assert.equal(node.category,'tasks');assert.equal(node.description,'Finish launch review');assert.equal(node.actor,'Tree Owner');
  const count=await ActivityEvent.countDocuments({projectId});
  assert.equal((await (await call(`${path}?revision=${graph.revision}`)).json()).unchanged,true);
  assert.equal(await ActivityEvent.countDocuments({projectId}),count);
});
test('viewers can read the tree; outsiders and unauthenticated requests cannot',async()=>{
  const path=`/projects/${projectId}/work-tree`;
  assert.equal((await call(path,'GET',undefined,memberToken)).status,200);
  assert.equal((await call(path,'GET',undefined,otherToken)).status,404);
  assert.equal((await call(path,'GET',undefined,'')).status,401);
  assert.equal((await call(`${path}?limit=999999`)).status,400);
});
test('all project audit actions appear, payload secrets stay private, and sources are labeled honestly',async()=>{
  const {logActivity}=await import('../../src/audit/service.js');const {SourceRecord}=await import('../../src/models/SourceRecord.js');
  await logActivity({projectId,actorType:'system',action:'GITHUB_PUSH_RECEIVED',payload:{repository:'team/repo',branch:'main',sha:'a'.repeat(40),commitCount:2,secret:'never-expose-this'}});
  await logActivity({projectId,actorType:'system',action:'NEW_CUSTOM_PROJECT_TRIGGER',payload:{apiKey:'secret-api-value'}});
  await SourceRecord.create({projectId,provider:'github',externalId:'tree-commit',type:'commit',title:'Add launch page',content:'private implementation',metadata:{author:'Developer'}});
  const data=await (await call(`/projects/${projectId}/work-tree`)).json();
  assert.equal(data.nodes.find(node=>node.action==='GITHUB_PUSH_RECEIVED').kind,'trigger');assert.equal(data.nodes.find(node=>node.action==='GITHUB_PUSH_RECEIVED').details.commits,2);
  assert.ok(data.nodes.some(node=>node.action==='NEW_CUSTOM_PROJECT_TRIGGER'));
  assert.equal(data.nodes.find(node=>node.action==='COMMIT_IMPORTED').kind,'source');
  assert.doesNotMatch(JSON.stringify(data),/never-expose-this|secret-api-value|private implementation/);
  const small=await (await call(`/projects/${projectId}/work-tree?limit=1`)).json();assert.equal(small.hasOlder,true);
});

test('a finished sync updates the earlier running node using the same run id',async()=>{
  const {logActivity}=await import('../../src/audit/service.js');
  await logActivity({projectId,actorType:'system',action:'REPOSITORY_SYNC_STARTED',payload:{runId:'test-run',repository:'team/repo'}});
  let graph=await (await call(`/projects/${projectId}/work-tree`)).json();assert.equal(graph.nodes.find(node=>node.action==='REPOSITORY_SYNC_STARTED'&&node.details.runId==='test-run').status,'running');
  await logActivity({projectId,actorType:'system',action:'REPOSITORY_SYNC_PARTIAL',payload:{runId:'test-run',repository:'team/repo'}});
  graph=await (await call(`/projects/${projectId}/work-tree`)).json();const start=graph.nodes.find(node=>node.action==='REPOSITORY_SYNC_STARTED'&&node.details.runId==='test-run');assert.equal(start.status,'partial');assert.equal(start.details.outcome,'partial');
});
