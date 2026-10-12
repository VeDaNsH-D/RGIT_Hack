import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo } from './harness.js';
let server, origin, owner, viewer, outsider, tokens, projectId, SourceRecord;
const realFetch = globalThis.fetch;
const call = (path, method = 'GET', body, user = 0) => realFetch(`${origin}/api${path}`, { method, headers: { Authorization: `Bearer ${tokens[user]}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
before(async () => {
  await startMongo();
  const { User } = await import('../../src/models/User.js');
  const { signAuthToken } = await import('../../src/middleware/auth.js');
  [owner, viewer, outsider] = await Promise.all(['owner', 'viewer', 'outsider'].map(name => User.create({ name, email: `chat-${name}@example.test` })));
  tokens = [owner, viewer, outsider].map(signAuthToken);
  ({ SourceRecord } = await import('../../src/models/SourceRecord.js'));
  const { app } = await import('../../src/app.js');
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); origin = `http://127.0.0.1:${server.address().port}`;
  projectId = (await (await call('/projects', 'POST', { name: 'Payments launch' })).json()).project.id;
  const { ProjectMembership } = await import('../../src/models/ProjectMembership.js');
  await ProjectMembership.create({ projectId, userId: viewer._id, role: 'viewer', invitedBy: owner._id });
});
after(async () => { globalThis.fetch = realFetch; await new Promise(resolve => server?.close(resolve)); await stopMongo(); });
test('retrieval includes matching project evidence, excludes other projects and answers with citations', async () => {
  await SourceRecord.create({ projectId, provider: 'slack', externalId: 'chat1', title: 'Payment retry decision', content: 'The team decided to retry payments three times.' });
  const other = (await (await call('/projects', 'POST', { name: 'Other project' })).json()).project.id;
  await SourceRecord.create({ projectId: other, provider: 'slack', externalId: 'chat2', content: 'Payments secret outsider context.' });
  globalThis.fetch = async (_, options) => {
    const pack = JSON.parse(options.body);
    assert.doesNotMatch(JSON.stringify(pack), /secret outsider/);
    const source = pack.sources.find(s => s.text.includes('three times'));
    assert.ok(source);
    return Response.json({ answer: `Retry payments three times [${source.id}].`, insufficientEvidence: false });
  };
  const response = await call(`/projects/${projectId}/chat`, 'POST', { question: 'What did we decide about payment retry?' });
  assert.equal(response.status, 201); const data = await response.json(); assert.equal(data.turn.citations.length, 1); assert.match(data.turn.citations[0].text, /three times/);
  const viewerHistory = await (await call(`/projects/${projectId}/chat`, 'GET', undefined, 1)).json(); assert.equal(viewerHistory.turns.length, 0);
});
test('membership, input validation, and private conversation deletion are enforced', async () => {
  assert.equal((await call(`/projects/${projectId}/chat`, 'GET', undefined, 2)).status, 404);
  assert.equal((await call(`/projects/${projectId}/chat`, 'POST', { question: ' ' })).status, 400);
  assert.equal((await call(`/projects/${projectId}/chat`, 'POST', { question: 'x'.repeat(2001) })).status, 400);
  assert.equal((await call(`/projects/${projectId}/chat`, 'DELETE', undefined, 1)).status, 200);
  assert.equal((await (await call(`/projects/${projectId}/chat`)).json()).turns.length, 1);
});
test('unknown citations and AI failures do not persist a successful answer', async () => {
  globalThis.fetch = async () => Response.json({ answer: 'An unsupported fact [S999].' });
  assert.equal((await call(`/projects/${projectId}/chat`, 'POST', { question: 'Payment retry?' })).status, 502);
  globalThis.fetch = async () => { throw new Error('Offline'); };
  assert.equal((await call(`/projects/${projectId}/chat`, 'POST', { question: 'Payment retry?' })).status, 503);
  assert.equal((await (await call(`/projects/${projectId}/chat`)).json()).turns.length, 1);
});
test('replaced document chunks cannot be retrieved', async () => {
  const { Document } = await import('../../src/models/Document.js');
  const { DocumentChunk } = await import('../../src/models/DocumentChunk.js');
  const { retrieveProjectChat } = await import('../../src/chat/retrieval.js');
  // Only current indexed documents are eligible; stale/orphan chunks are excluded even when matching.
  await DocumentChunk.create({ projectId, documentId: owner._id, chunkIndex: 0, chunkId: 'stale', text: 'obsolete-unique-phrase', charCount: 22, chunkHash: 'old', contentHash: 'old' });
  const result = await retrieveProjectChat({ _id: projectId, name: 'Payments' }, 'obsolete unique phrase', []);
  assert.equal(result.sources.length, 0);
  assert.equal(await Document.countDocuments({ projectId }), 0);
});


test('repository evidence uses only the published manifest and deletion removes private chats', async () => {
  const { SourceConnection } = await import('../../src/models/SourceConnection.js');
  const { RepositoryFile } = await import('../../src/models/RepositoryFile.js');
  const { RepositorySnapshot } = await import('../../src/models/RepositorySnapshot.js');
  const { retrieveProjectChat } = await import('../../src/chat/retrieval.js');
  const connection = await SourceConnection.create({ projectId, provider: 'github', connectedBy: owner._id });
  const snapshot = await RepositorySnapshot.create({ projectId, connectionId: connection._id, repositoryId: 99, fullName: 'team/repo', branch: 'main', commitSha: 'a'.repeat(40), analyzerVersion: 1, status: 'completed', mode: 'full', analyzedAt: new Date(), coverage: {}, knowledge: {}, fileManifest: [{ path: 'retry.js', blobSha: 'current' }] });
  await SourceConnection.updateOne({ _id: connection._id }, { $set: { 'config.analysis.currentSnapshotId': snapshot._id } });
  await RepositoryFile.create([{ projectId, repositoryId: 99, path: 'retry.js', blobSha: 'current', size: 22, content: 'retry queue implementation' }, { projectId, repositoryId: 99, path: 'retry.js', blobSha: 'obsolete', size: 22, content: 'obsolete code secrets' }]);
  const result = await retrieveProjectChat({ _id: projectId, name: 'Payments' }, 'retry queue implementation', []);
  assert.ok(result.sources.some(source => source.provider === 'github'));
  assert.doesNotMatch(JSON.stringify(result), /obsolete code/);
  assert.equal((await call(`/projects/${projectId}`, 'DELETE')).status, 200);
  const { ProjectChatTurn } = await import('../../src/models/ProjectChatTurn.js');
  assert.equal(await ProjectChatTurn.countDocuments({ projectId }), 0);
});
