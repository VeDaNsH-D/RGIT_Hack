/** Source-grounded AI handoff drafts: real app + disposable MongoDB; the AIML HTTP service is mocked. */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMongo, stopMongo, resetCollections } from './harness.js';

await startMongo();
const { app } = await import('../../src/app.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { LIMITS } = await import('../../src/services/handoffDraftService.js');
const { User, Project, ProjectMembership, SourceConnection, SourceRecord, Handoff, Task } = await import('../../src/models/index.js');
after(async () => { await stopMongo(); });

const realFetch = globalThis.fetch;
const J = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });

describe('AI handoff drafts', () => {
  let server, base, alice, bob, project, handoff, ai, sent, prRecord, issueRecord;
  const tok = (u) => `Bearer ${signAuthToken(u)}`;
  const call = async (method, path, u, body) => {
    const res = await realFetch(`${base}${path}`, { method, headers: { ...(u ? { Authorization: tok(u) } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json, text };
  };
  const draft = () => call('POST', `/api/handoffs/${handoff._id}/ai-draft`, alice);
  const rec = (over) => SourceRecord.create({ projectId: project._id, provider: 'github', externalId: `x-${Math.random()}`, content: 'c', url: 'https://github.com/acme/relay/pull/1', ...over });

  before(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => {
      if (String(url).includes(':8001')) { sent = JSON.parse(init.body); return ai(sent); }
      return realFetch(url, init);
    };
  });
  after(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); });
  beforeEach(async () => {
    await resetCollections(); sent = null;
    alice = await User.create({ email: 'a@example.com', name: 'Alice' });
    bob = await User.create({ email: 'b@example.com', name: 'Bob' });
    project = await Project.create({ name: 'P', description: 'Ship it', ownerId: alice._id, createdBy: alice._id });
    await ProjectMembership.create({ projectId: project._id, userId: alice._id, role: 'owner', invitedBy: alice._id });
    await ProjectMembership.create({ projectId: project._id, userId: bob._id, role: 'member', invitedBy: alice._id });
    handoff = await Handoff.create({ projectId: project._id, fromUserId: alice._id, toUserId: bob._id });
    await SourceConnection.create({ projectId: project._id, provider: 'github', connectedBy: alice._id, config: { sync: { status: 'completed', lastSuccessAt: new Date() }, repositoryId: 1, fullName: 'acme/relay' } });
    prRecord = await rec({ type: 'pull_request', title: 'Add retry logic', externalId: 'PR_1', metadata: { author: 'carol', providerMetadata: { number: 12, state: 'open', draft: false, repositoryFullName: 'acme/relay', requested_reviewers: ['dave'] } } });
    issueRecord = await rec({ type: 'issue', title: 'CORS failures', externalId: 'I_1', url: 'https://github.com/acme/relay/issues/8', metadata: { author: 'alice', providerMetadata: { number: 8, state: 'open', repositoryFullName: 'acme/relay' } } });
    ai = (pack) => J({
      case_id: pack.case_id, summary: 'Retry work is in review while CORS issues persist.',
      attempted_actions: [{ action: 'Added retry logic', outcome: 'PR open for review', source_ids: [String(prRecord._id)] }],
      decisions: [], blockers: [{ description: 'CORS preflight failures', severity: 'high', source_ids: [String(issueRecord._id), 'not-a-real-id'] }],
      proposed_tasks: [{ title: 'Fix CORS headers', description: 'Align origins', priority: 'high', source_ids: [String(issueRecord._id)] }],
      missing_information: [{ topic: 'Test coverage', explanation: 'No tests mentioned', impact: null }], contradictions: [],
    });
  });

  it('requires authentication and restricts drafting to the outgoing owner of an editable handoff', async () => {
    assert.equal((await call('POST', `/api/handoffs/${handoff._id}/ai-draft`)).status, 401);
    assert.equal((await call('POST', `/api/handoffs/${handoff._id}/ai-draft`, bob)).status, 403);
    const outsider = await User.create({ email: 'o@example.com', name: 'O' });
    assert.equal((await call('POST', `/api/handoffs/${handoff._id}/ai-draft`, outsider)).status, 404);
    await Handoff.updateOne({ _id: handoff._id }, { state: 'SUBMITTED' });
    assert.equal((await draft()).status, 409);
    assert.equal(sent, null);
  });

  it('retrieves real project records before generating, and sends only that project\'s data', async () => {
    const other = await Project.create({ name: 'Other', ownerId: bob._id, createdBy: bob._id });
    await SourceRecord.create({ projectId: other._id, provider: 'github', externalId: 'leak', type: 'issue', title: 'OTHER PROJECT SECRET', metadata: { providerMetadata: { state: 'open' } } });
    await Task.create({ projectId: project._id, title: 'Existing task', createdBy: alice._id });
    const r = await draft();
    assert.equal(r.status, 200);
    assert.equal(sent.case_id, String(project._id));
    assert.ok(sent.sources.some((s) => s.title === 'Add retry logic' && s.record_type === 'pull_request' && s.url));
    assert.ok(sent.tasks.some((t) => t.title === 'Existing task'));
    assert.doesNotMatch(JSON.stringify(sent), /SECRET/);
  });

  it('maps grounded output to handoff fields with source attribution, and stores it only as a draft', async () => {
    const r = await draft();
    const d = r.body.handoff.aiDraft;
    assert.match(d.currentStatus, /Retry work/);
    const byType = Object.fromEntries(d.items.map((i) => [i.type, i]));
    assert.equal(byType.completed.sourceRecordId, String(prRecord._id));
    assert.match(byType.completed.text, /Source: acme\/relay PR #12/);
    assert.equal(byType.blocker.kind, 'sourced'); assert.match(byType.blocker.text, /issue #8/);
    assert.equal(byType.pending.kind, 'inference'); assert.match(byType.pending.text, /^Suggested:/);
    assert.equal(byType.risk.kind, 'unknown');
    assert.ok(d.supportingLinks.includes('https://github.com/acme/relay/issues/8'));
    assert.deepEqual(d.items.find((i) => i.type === 'blocker').evidenceIds, [String(issueRecord._id)]); // invented id dropped
    // The real handoff content is untouched until the user applies and saves.
    assert.deepEqual(r.body.handoff.items, []); assert.equal(r.body.handoff.currentStatus, '');
    const saved = await Handoff.findById(handoff._id).lean();
    assert.ok(saved.aiDraft); assert.equal(saved.items.length, 0);
  });

  it('lets the user apply the draft through the existing PATCH flow, then shows it in the handoff', async () => {
    const d = (await draft()).body.handoff.aiDraft;
    const items = d.items.map(({ type, text, sourceRecordId }) => ({ type, text, sourceRecordId }));
    const patch = await call('PATCH', `/api/handoffs/${handoff._id}`, alice, { currentStatus: d.currentStatus, items, supportingLinks: d.supportingLinks });
    assert.equal(patch.status, 200); assert.equal(patch.body.handoff.items.length, d.items.length);
    assert.equal((await call('GET', `/api/projects/${project._id}/handoffs`, alice)).body.handoffs[0].items.length, d.items.length);
  });

  it('flags stale or failed sync data and limits what it sends', async () => {
    await SourceConnection.updateOne({ projectId: project._id }, { 'config.sync.status': 'failed', 'config.sync.truncated': true });
    for (let i = 0; i < 80; i += 1) await rec({ type: 'issue', title: `Bulk ${i}`, externalId: `bulk-${i}`, content: 'x'.repeat(5000), metadata: { providerMetadata: { number: 100 + i, state: 'open' } } });
    const r = await draft();
    assert.ok(r.body.handoff.aiDraft.limitations.some((l) => /failed/.test(l)));
    assert.ok(r.body.handoff.aiDraft.limitations.some((l) => /truncated/.test(l)));
    assert.match(sent.case_description, /Relay data limitations/);
    assert.ok(sent.sources.filter((s) => s.record_type === 'issue').length <= LIMITS.openIssues);
    assert.ok(sent.sources.every((s) => s.content.length <= LIMITS.contentChars));
  });

  it('refuses to invent a draft for empty or unsynced projects', async () => {
    await SourceRecord.deleteMany({});
    await SourceConnection.updateOne({ projectId: project._id }, { 'config.sync': { status: 'pending' } });
    const unsynced = await draft();
    assert.equal(unsynced.status, 409); assert.equal(unsynced.body.error, 'not_synced');
    await SourceConnection.deleteMany({});
    const empty = await draft();
    assert.equal(empty.status, 422); assert.equal(empty.body.error, 'insufficient_context');
    assert.equal(sent, null);
  });

  it('keeps existing data and returns useful errors for AI failures and malformed output', async () => {
    const first = (await draft()).body.handoff.aiDraft;
    ai = () => J({ detail: 'GROQ_API_KEY is not configured' }, 503);
    let r = await draft(); assert.equal(r.status, 503); assert.doesNotMatch(r.text, /gsk_/);
    ai = () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    r = await draft(); assert.equal(r.status, 504);
    ai = () => J({ nonsense: true });
    r = await draft(); assert.equal(r.status, 502);
    ai = (pack) => J({ case_id: pack.case_id, summary: '   ' });
    r = await draft(); assert.equal(r.status, 502);
    const saved = await Handoff.findById(handoff._id).lean();
    assert.equal(saved.aiDraft.currentStatus, first.currentStatus); assert.equal(saved.items.length, 0);
  });

  it('does not duplicate handoffs: a second create is rejected and the open one still drafts', async () => {
    const dup = await call('POST', `/api/projects/${project._id}/handoffs`, alice, { toUserId: String(bob._id) });
    assert.equal(dup.status, 409);
    assert.equal(await Handoff.countDocuments({ projectId: project._id }), 1);
    assert.equal((await draft()).status, 200);
    assert.equal((await draft()).status, 200); // retrying the draft reuses the same handoff
    assert.equal(await Handoff.countDocuments({ projectId: project._id }), 1);
  });

  it('restricts creating the handoff to the project owner (members cannot start one)', async () => {
    await Handoff.deleteMany({});
    assert.equal((await call('POST', `/api/projects/${project._id}/handoffs`, bob, { toUserId: String(alice._id) })).status, 403);
    const created = await call('POST', `/api/projects/${project._id}/handoffs`, alice, { toUserId: String(bob._id) });
    assert.equal(created.status, 201);
    assert.equal((await call('POST', `/api/handoffs/${created.body.handoff.id}/ai-draft`, alice)).status, 200);
  });
});
