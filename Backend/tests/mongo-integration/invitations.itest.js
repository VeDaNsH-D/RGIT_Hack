import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import nodemailer from 'nodemailer'
import { startMongo, stopMongo } from './harness.js'
let server, origin, owner, recipient, outsider, projectId, User, ProjectMembership, ProjectInvitation
let sent = [], reject = false
const originalTransport = nodemailer.createTransport
const call = (path, method = 'GET', body, token = owner) => fetch(`${origin}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
const inviteToken = () => new URL(sent.at(-1).text.match(/http[^\s]+/)[0]).hash.slice(1)
before(async () => {
  Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'sender@example.test', SMTP_PASS: 'test-password', SMTP_PORT: '465', SMTP_SECURE: 'true', INVITE_FROM_EMAIL: 'Over2u <sender@example.test>' })
  nodemailer.createTransport = options => {
    assert.equal(options.secure, true); assert.equal(options.auth.user, 'sender@example.test')
    return { async sendMail(mail) { if (reject) throw Object.assign(new Error('test authentication rejected'), { code: 'EAUTH' }); sent.push(mail); return { accepted: [mail.to], rejected: [] } } }
  }
  await startMongo()
  ;({ User } = await import('../../src/models/User.js'))
  ;({ ProjectMembership } = await import('../../src/models/ProjectMembership.js'))
  ;({ ProjectInvitation } = await import('../../src/models/ProjectInvitation.js'))
  const { signAuthToken } = await import('../../src/middleware/auth.js')
  owner = signAuthToken(await User.create({ name: 'Owner', email: 'invite-owner@example.test' }))
  outsider = signAuthToken(await User.create({ name: 'Other', email: 'invite-other@example.test' }))
  const { app } = await import('../../src/app.js')
  server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)) })
  origin = `http://127.0.0.1:${server.address().port}`
  const created = await (await call('/projects', 'POST', { name: 'Invitation project' })).json()
  projectId = created.project.id
})
after(async () => { nodemailer.createTransport = originalTransport; await new Promise(resolve => server?.close(resolve)); await stopMongo() })
test('sends invitation to a new user without adding membership; stores only hash', async () => {
  const response = await call(`/projects/${projectId}/invitations`, 'POST', { email: 'Recipient@Example.test', role: 'member' })
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, 'recipient@example.test')
  assert.match(sent[0].text, /Invitation project/)
  assert.equal(await ProjectMembership.countDocuments({ projectId }), 1)
  const saved = await ProjectInvitation.findOne({ projectId }).select('+tokenHash').lean()
  assert.notEqual(saved.tokenHash, inviteToken())
  assert.doesNotMatch(JSON.stringify(await response.json()), new RegExp(inviteToken()))
})
test('requires sign-in and the invited email; new account can accept once', async () => {
  const token = inviteToken()
  assert.equal((await call('/invitations/preview', 'POST', { token }, '')).status, 401)
  assert.equal((await call('/invitations/accept', 'POST', { token }, outsider)).status, 403)
  const { signAuthToken } = await import('../../src/middleware/auth.js')
  recipient = signAuthToken(await User.create({ name: 'Recipient', email: 'recipient@example.test' }))
  const preview = await (await call('/invitations/preview', 'POST', { token }, recipient)).json()
  assert.equal(preview.project.name, 'Invitation project')
  assert.equal((await call('/invitations/accept', 'POST', { token }, recipient)).status, 200)
  assert.equal((await call('/invitations/accept', 'POST', { token }, recipient)).status, 200)
  assert.equal(await ProjectMembership.countDocuments({ projectId }), 2)
  assert.equal((await call(`/projects/${projectId}/context`, 'GET', undefined, recipient)).status, 200)
})
test('owner-only sending; existing member and owner role invitations are rejected', async () => {
  const path = `/projects/${projectId}/invitations`
  assert.equal((await call(path, 'POST', { email: 'new@example.test', role: 'member' }, recipient)).status, 403)
  assert.equal((await call(path, 'POST', { email: 'recipient@example.test', role: 'member' })).status, 409)
  assert.equal((await call(path, 'POST', { email: 'new@example.test', role: 'owner' })).status, 400)
})
test('revoked and expired invitations cannot be accepted', async () => {
  const path = `/projects/${projectId}/invitations`
  let response = await call(path, 'POST', { email: 'invite-other@example.test', role: 'viewer' })
  let row = (await response.json()).invitation
  let token = inviteToken()
  assert.equal((await call(`${path}/${row.id}`, 'DELETE')).status, 200)
  assert.equal((await call('/invitations/accept', 'POST', { token }, outsider)).status, 410)
  response = await call(path, 'POST', { email: 'invite-other@example.test', role: 'viewer' })
  row = (await response.json()).invitation; token = inviteToken()
  await ProjectInvitation.updateOne({ _id: row.id }, { $set: { expiresAt: new Date(0) } })
  assert.equal((await call('/invitations/accept', 'POST', { token }, outsider)).status, 410)
})
test('SMTP failures remain visible and do not grant access', async () => {
  reject = true
  try {
    const response = await call(`/projects/${projectId}/invitations`, 'POST', { email: 'invite-other@example.test', role: 'member' })
    assert.equal(response.status, 502)
    assert.match((await response.json()).message, /SMTP/)
    assert.equal(await ProjectMembership.countDocuments({ projectId }), 2)
    assert.equal(await ProjectInvitation.countDocuments({ projectId, status: 'failed' }), 1)
  } finally { reject = false }
})
test('missing SMTP configuration gives actionable setup error', async () => {
  const password = process.env.SMTP_PASS; delete process.env.SMTP_PASS
  try {
    const response = await call(`/projects/${projectId}/invitations`, 'POST', { email: 'new@example.test', role: 'viewer' })
    assert.equal(response.status, 503)
    assert.match((await response.json()).message, /SMTP_PASS/)
  } finally { process.env.SMTP_PASS = password }
})

test('accepted invitations notify the owner; project changes notify teammates, not outsiders', async () => {
  const { NotificationModel } = await import('../../src/models/Notification.js')
  const ownerUser = await User.findOne({ email: 'invite-owner@example.test' })
  const notification = await NotificationModel.findOne({ recipientUserId: String(ownerUser._id), title: 'Invitation accepted' }).lean()
  assert.ok(notification)
  assert.match(notification.message, /Recipient.*joined the team/)
  const { notifyProjectActivity } = await import('../../src/notifications/projectActivity.js')
  const { ActivityEvent } = await import('../../src/models/ActivityEvent.js')
  const event = await ActivityEvent.findOne({ action: 'INVITATION_ACCEPTED' })
  await notifyProjectActivity(event)
  assert.equal(await NotificationModel.countDocuments({ recipientUserId: String(ownerUser._id), title: 'Invitation accepted' }), 1)
  const response = await call(`/projects/${projectId}/tasks`, 'POST', { title: 'Review launch', priority: 'medium' })
  assert.equal(response.status, 201)
  const recipientData = (await (await call('/notifications', 'GET', undefined, recipient)).json()).data.items
  assert.ok(recipientData.some(item => item.title === 'New task'))
  const outsiderData = (await (await call('/notifications', 'GET', undefined, outsider)).json()).data.items
  assert.equal(outsiderData.length, 0)
})
test('notifications support unread counts and recipient-only mark-read and mark-all', async () => {
  const list = (await (await call('/notifications', 'GET', undefined, recipient)).json()).data.items
  assert.ok(list.length)
  const unreadBefore = (await (await call('/notifications/unread-count', 'GET', undefined, recipient)).json()).data.unreadCount
  assert.ok(unreadBefore > 0)
  assert.equal((await call(`/notifications/${encodeURIComponent(list[0].id)}/read`, 'PATCH', undefined, outsider)).status, 404)
  assert.equal((await call(`/notifications/${encodeURIComponent(list[0].id)}/read`, 'PATCH', undefined, recipient)).status, 200)
  const unreadAfter = (await (await call('/notifications/unread-count', 'GET', undefined, recipient)).json()).data.unreadCount
  assert.equal(unreadAfter, unreadBefore - 1)
  assert.equal((await call('/notifications/read-all', 'PATCH', undefined, recipient)).status, 200)
  assert.equal((await (await call('/notifications/unread-count', 'GET', undefined, recipient)).json()).data.unreadCount, 0)
  const ownerCount = (await (await call('/notifications/unread-count')).json()).data.unreadCount
  assert.ok(ownerCount > 0)
})
