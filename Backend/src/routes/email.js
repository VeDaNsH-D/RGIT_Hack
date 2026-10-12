import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole, getMembership } from '../middleware/access.js';
import { User } from '../models/User.js';
import { EmailConnection } from '../models/EmailConnection.js';
import { EmailReview } from '../models/EmailReview.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { Task } from '../models/Task.js';
import { generateContextPack } from '../services/aiClient.js';
import { buildProjectContextPack } from '../services/contextBuilder.js';
import { logActivity } from '../audit/service.js';
import { providers, settings, callbackUrl, encryptTokens, exchange, accessToken, mailboxIdentity, listThreads, readThread } from '../email/providers.js';

const router = Router();
const providerSchema = z.enum(providers);
const ids = z.string().regex(/^[a-f\d]{24}$/i);
const fail = (status, message) => Object.assign(new Error(message), { status });
const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { if (error.name === 'ZodError') return res.status(400).json({ error: 'validation_error', message: 'Please check your email selection and project changes.' }); next(error); } };
const guards = [requireAuth, attachProject(), requireRole('member')];
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: config.apiBaseUrl.startsWith('https://'), path: '/api/email/oauth' });
const cookieName = provider => `relay_mail_${provider}`;
function returnToApp(res, provider, error = '') { const url = new URL('/emails', config.frontendUrl || 'http://localhost:5173'); url.searchParams.set(error ? 'emailError' : 'connected', error || provider); res.set('Cache-Control', 'no-store'); return res.redirect(url.toString()); }
async function connection(req, provider) {
  const item = await EmailConnection.findOne({ userId: req.user._id, provider }).select('+encryptedTokens');
  if (!item) throw fail(400, 'Connect your mailbox first.');
  return item;
}
function serializeReview(review) {
  return { id: String(review._id), projectId: String(review.projectId), summary: review.summary, decisions: review.decisions, blockers: review.blockers, createdAt: review.createdAt, sourceRecordIds: review.sourceRecordIds.map(String), items: review.items.map(item => ({ id: String(item._id), title: item.title, description: item.description, priority: item.priority, deadline: item.deadline, rationale: item.rationale, sourceIds: item.sourceIds, status: item.status, targetTaskId: item.targetTaskId ? String(item.targetTaskId) : null })) };
}
router.get('/connections', requireAuth, handle(async (req,res) => {
  const connections = await EmailConnection.find({ userId: req.user._id }).lean();
  res.json({ connections: connections.map(item => ({ provider: item.provider, email: item.email })), available: Object.fromEntries(providers.map(provider => [provider, Boolean(settings(provider).id && settings(provider).secret)])) });
}));
router.post('/oauth/:provider/start', requireAuth, handle(async (req,res) => {
  const provider = providerSchema.parse(req.params.provider);
  const cfg = settings(provider);
  if (!cfg.id || !cfg.secret) throw fail(400, 'This mailbox provider is not configured yet.');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const state = jwt.sign({ purpose: 'mailbox', provider, userId: String(req.user._id), nonce }, config.jwtSecret, { expiresIn: '10m' });
  res.cookie(cookieName(provider), `${nonce}.${verifier}`, { ...cookieOptions(), maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({ client_id: cfg.id, redirect_uri: callbackUrl(provider), response_type: 'code', scope: cfg.scope, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(provider === 'gmail' ? { access_type: 'offline', prompt: 'consent' } : { response_mode: 'query' }) });
  res.json({ authorizationUrl: `${cfg.authorization}?${params}` });
}));
router.get('/oauth/:provider/callback', handle(async (req,res) => {
  const provider = providerSchema.parse(req.params.provider);
  let stage = 'state';
  try {
    const state = jwt.verify(z.string().parse(req.query.state), config.jwtSecret);
    const cookie = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName(provider)}=`))?.split('=').slice(1).join('=');
    const [nonce, verifier] = (cookie || '').split('.');
    if (state.purpose !== 'mailbox' || state.provider !== provider || !nonce || !verifier || typeof state.nonce !== 'string' || nonce.length !== state.nonce.length || !timingSafeEqual(Buffer.from(nonce), Buffer.from(state.nonce))) return returnToApp(res, provider, 'invalid_state');
    res.clearCookie(cookieName(provider), cookieOptions());
    stage = 'account';
    if (!await User.exists({ _id: state.userId, disabled: { $ne: true } })) return returnToApp(res, provider, 'account_unavailable');
    if (req.query.error) return returnToApp(res, provider, 'access_denied');
    const code = z.string().min(1).parse(req.query.code);
    stage = 'exchange';
    const tokens = await exchange(provider, { code, redirect_uri: callbackUrl(provider), grant_type: 'authorization_code', code_verifier: verifier });
    if (!tokens.access_token) throw fail(400, 'Mailbox authorization failed.');
    const requiredScope = provider === 'gmail' ? 'https://www.googleapis.com/auth/gmail.readonly' : 'Mail.Read';
    if (!String(tokens.scope || '').split(' ').includes(requiredScope)) return returnToApp(res, provider, 'permission_denied');
    stage = 'identity';
    const email = await mailboxIdentity(provider, tokens.access_token);
    if (!email) throw fail(400, 'Mailbox identity could not be verified.');
    stage = 'save';
    await EmailConnection.findOneAndUpdate({ userId: state.userId, provider }, { $set: { email, encryptedTokens: encryptTokens({ ...tokens, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 }) } }, { upsert: true });
    await logActivity({ actorId: state.userId, action: 'MAILBOX_CONNECTED', targetType: 'EmailConnection', payload: { provider } });
    return returnToApp(res, provider);
  } catch(error) {
    const allowed = ['gmail_api_disabled', 'oauth_code_expired', 'oauth_client_invalid', 'provider_unreachable', 'mailbox_access_expired', 'mailbox_permission_denied', 'provider_invalid_response'];
    const code = allowed.includes(error.code) ? error.code : stage === 'state' ? 'invalid_state' : stage === 'save' ? 'connection_save_failed' : stage === 'exchange' ? 'token_exchange_failed' : 'connection_failed';
    // Log diagnostic categories only; never authorization codes, tokens, or email bodies.
    console.error('[mailbox-oauth]', JSON.stringify({ provider, stage, code, ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}) }));
    return returnToApp(res, provider, code);
  }
}));
router.delete('/connections/:provider', requireAuth, handle(async (req,res) => {
  const provider = providerSchema.parse(req.params.provider);
  await EmailConnection.deleteOne({ userId: req.user._id, provider });
  await logActivity({ actorId: req.user._id, action: 'MAILBOX_DISCONNECTED', targetType: 'EmailConnection', payload: { provider } });
  res.json({ disconnected: true });
}));
router.get('/:provider/threads', requireAuth, handle(async (req,res) => {
  const provider = providerSchema.parse(req.params.provider);
  const query = z.object({ q: z.string().max(300).optional(), pageToken: z.string().max(8000).optional() }).strict().parse(req.query);
  const mailbox = await connection(req, provider);
  res.json(await listThreads(provider, await accessToken(mailbox), query));
}));
router.get('/:provider/threads/:threadId', requireAuth, handle(async (req,res) => {
  const provider = providerSchema.parse(req.params.provider);
  const threadId = z.string().min(1).max(1000).parse(req.params.threadId);
  const mailbox = await connection(req, provider);
  res.json({ thread: await readThread(provider, await accessToken(mailbox), threadId) });
}));
router.post('/projects/:id/import', ...guards, handle(async (req,res) => {
  const body = z.object({ provider: providerSchema, threadIds: z.array(z.string().min(1).max(1000)).min(1).max(10) }).strict().parse(req.body);
  const mailbox = await connection(req, body.provider);
  const token = await accessToken(mailbox);
  const threads = [];
  const selectedIds = [...new Set(body.threadIds)];
  for (let index = 0; index < selectedIds.length; index += 3) threads.push(...await Promise.all(selectedIds.slice(index, index + 3).map(id => readThread(body.provider, token, id))));
  const prepared = threads.map(thread => ({ thread, content: thread.messages.map(message => `From: ${message.from}\nTo: ${message.to}\nDate: ${message.date}\nSubject: ${message.subject}\n\n${message.body}`).join('\n\n---\n\n') }));
  if (threads.some(thread => thread.truncated)) throw fail(400, 'This conversation is too large to import completely. Choose a smaller conversation.');
  if (prepared.reduce((size, item) => size + item.content.length, 0) > 300000) throw fail(400, 'These conversations are too large. Import fewer threads at a time.');
  const records = [];
  for (const {thread, content} of prepared) {
    const externalId = `${String(req.user._id)}:${createHash('sha256').update(mailbox.email).digest('hex').slice(0,16)}:${thread.id}`;
    const record = await SourceRecord.findOneAndUpdate({ projectId: req.project._id, provider: body.provider, externalId }, { $set: { type: 'message', title: thread.subject, url: thread.url, content, metadata: { author: thread.from, importedBy: String(req.user._id), mailbox: mailbox.email, threadId: thread.id, messageCount: thread.messages.length, messageIds: thread.messages.map(message => message.id), sourceUpdatedAt: thread.date, fetchedAt: new Date() } } }, { upsert: true, new: true });
    records.push({ id: String(record._id), title: record.title });
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'EMAIL_CONVERSATION_IMPORTED', targetType: 'SourceRecord', targetId: record._id, payload: { provider: body.provider, threadId: thread.id, messageCount: thread.messages.length } });
  }
  res.status(201).json({ records });
}));
router.get('/projects/:id/log', ...guards, handle(async (req,res) => {
  const records = await SourceRecord.find({ projectId: req.project._id, provider: { $in: providers } }).sort({ updatedAt: -1 }).limit(100).lean();
  const reviews = await EmailReview.find({ projectId: req.project._id }).sort({ createdAt: -1 }).limit(30);
  res.json({ records: records.map(item => ({ id: String(item._id), provider: item.provider, title: item.title, content: item.content, url: item.url, importedAt: item.createdAt, updatedAt: item.updatedAt, messageCount: item.metadata?.messageCount })), reviews: reviews.map(serializeReview) });
}));
router.post('/projects/:id/analyze', ...guards, handle(async (req,res) => {
  const body = z.object({ recordIds: z.array(ids).min(1).max(10) }).strict().parse(req.body);
  const records = await SourceRecord.find({ _id: { $in: body.recordIds }, projectId: req.project._id, provider: { $in: providers } });
  if (records.length !== new Set(body.recordIds).size) throw fail(400, 'Choose email records from this project.');
  const tasks = await Task.find({ projectId: req.project._id });
  const pack = await buildProjectContextPack(req.project._id, { project: req.project, tasks, documents: [], sourceRecords: records });
  const intelligence = await generateContextPack(pack);
  const allowed = new Set(records.map(item => String(item._id)));
  const items = (intelligence.proposed_tasks || []).filter(item => item.source_ids?.some(id => allowed.has(id))).slice(0,40).map(item => ({ title: String(item.title).slice(0,300), description: String(item.description || '').slice(0,5000), priority: ['low','medium','high','critical'].includes(item.priority) ? item.priority : 'medium', deadline: item.suggested_deadline || null, rationale: item.rationale || '', sourceIds: item.source_ids.filter(id => allowed.has(id)) }));
  for (const gap of intelligence.missing_information || []) {
    const task = tasks.find(task => `${gap.topic} ${gap.explanation}`.toLowerCase().includes(task.title.toLowerCase()));
    if (task && items.length < 50) items.push({ title: task.title, description: gap.explanation, priority: task.priority, deadline: task.deadline, targetTaskId: task._id, rationale: gap.impact || 'Review this existing task against the email context.', sourceIds: records.map(item => String(item._id)) });
  }
  const review = await EmailReview.create({ projectId: req.project._id, createdBy: req.user._id, sourceRecordIds: records.map(item => item._id), summary: intelligence.summary, decisions: intelligence.decisions || [], blockers: intelligence.blockers || [], items });
  await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'EMAIL_WORKFLOW_PROPOSED', targetType: 'EmailReview', targetId: review._id, payload: { sourceRecordIds: records.map(item => String(item._id)), proposalCount: items.length } });
  res.status(201).json({ review: serializeReview(review) });
}));
const applySchema = z.object({ action: z.enum(['apply','dismiss']), title: z.string().trim().min(1).max(300).optional(), description: z.string().max(5000).optional(), priority: z.enum(['low','medium','high','critical']).optional(), deadline: z.string().datetime().nullable().optional(), assignee: ids.nullable().optional(), taskStatus: z.enum(['open','completed']).optional(), targetTaskId: ids.nullable().optional() }).strict();
router.post('/projects/:id/reviews/:reviewId/items/:itemId', ...guards, handle(async (req,res) => {
  const body = applySchema.parse(req.body);
  const review = await EmailReview.findOne({ _id: ids.parse(req.params.reviewId), projectId: req.project._id });
  const item = review?.items.id(ids.parse(req.params.itemId));
  if (!item) throw fail(404, 'Proposal not found.');
  if (['applied','dismissed'].includes(item.status)) return res.json({ review: serializeReview(review), alreadyReviewed: true });
  if (item.status === 'applying' && Date.now() - new Date(item.claimAt).getTime() < 300000) throw fail(409, 'This proposal is currently being applied. Please refresh shortly.');
  if (body.action === 'dismiss') { const changed = await EmailReview.updateOne({ _id: review._id, items: { $elemMatch: { _id: item._id, status: 'pending' } } }, { $set: { 'items.$.status': 'dismissed' } }); if (!changed.modifiedCount) throw fail(409, 'This proposal has changed. Refresh the page.'); item.status = 'dismissed'; await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'EMAIL_PROPOSAL_DISMISSED', targetType: 'EmailReview', targetId: review._id, payload: { itemId: String(item._id) } }); return res.json({ review: serializeReview(review) }); }
  const targetId = body.targetTaskId || null;
  const target = targetId ? await Task.findOne({ _id: targetId, projectId: req.project._id }) : null;
  if (targetId && !target) throw fail(400, 'The task does not belong to this project.');
  if (body.assignee && !await getMembership(req.project._id, body.assignee)) throw fail(400, 'Choose an assignee from this project.');
  const change = item.applyPayload || { title: body.title || item.title, description: body.description ?? item.description, priority: body.priority || item.priority, deadline: body.deadline === undefined ? item.deadline : body.deadline, assignee: body.assignee === undefined ? target?.assignee || null : body.assignee, status: body.taskStatus || target?.status || 'open', targetTaskId: targetId };
  const claimed = await EmailReview.updateOne({ _id: review._id, items: { $elemMatch: { _id: item._id, status: item.status, ...(item.status === 'applying' ? { claimAt: item.claimAt } : {}) } } }, { $set: { 'items.$.status': 'applying', 'items.$.claimAt': new Date(), 'items.$.applyPayload': change } });
  if (!claimed.modifiedCount) throw fail(409, 'This proposal was reviewed by someone else. Refresh the page.');
  try {
    const values = { title: change.title, description: change.description, priority: change.priority, deadline: change.deadline, assignee: change.assignee, status: change.status, completedAt: change.status === 'completed' ? new Date() : null };
    let task;
    if (change.targetTaskId) {
      const current = await Task.findOne({ _id: change.targetTaskId, projectId: req.project._id });
      if (!current) throw fail(400, 'The selected task is no longer available.');
      task = await Task.findOneAndUpdate({ _id: current._id, projectId: req.project._id, updatedAt: current.updatedAt }, { $set: values }, { new: true });
      if (!task) throw fail(409, 'The task changed while applying. Please review again.');
    } else {
      task = await Task.findOneAndUpdate({ _id: item.createdTaskId, projectId: req.project._id }, { $setOnInsert: { ...values, projectId: req.project._id, createdBy: req.user._id, origin: 'imported', sourceRecordId: review.sourceRecordIds[0] } }, { new: true, upsert: true });
    }
    await EmailReview.updateOne({ _id: review._id, 'items._id': item._id }, { $set: { 'items.$.status': 'applied', 'items.$.targetTaskId': task._id } });
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'EMAIL_WORKFLOW_CHANGE_APPLIED', targetType: 'Task', targetId: task._id, payload: { reviewId: String(review._id), itemId: String(item._id), sourceRecordIds: review.sourceRecordIds.map(String), change: values } });
    res.json({ review: serializeReview(await EmailReview.findById(review._id)), taskId: String(task._id) });
  } catch(error) { await EmailReview.updateOne({ _id: review._id, 'items._id': item._id }, { $set: { 'items.$.status': 'pending' } }); throw error; }
}));
export default router;
