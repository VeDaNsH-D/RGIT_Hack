import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

export const providers = ['gmail', 'outlook'];
export const callbackUrl = provider => `${config.apiBaseUrl.replace(/\/$/, '')}/api/email/oauth/${provider}/callback`;
const outlookTenant = () => encodeURIComponent(process.env.MICROSOFT_TENANT_ID || 'common');
export function settings(provider) {
  return provider === 'gmail' ? { id: config.oauth.google.clientId, secret: config.oauth.google.clientSecret, authorization: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/gmail.readonly' } : { id: process.env.MICROSOFT_CLIENT_ID, secret: process.env.MICROSOFT_CLIENT_SECRET, authorization: `https://login.microsoftonline.com/${outlookTenant()}/oauth2/v2.0/authorize`, token: `https://login.microsoftonline.com/${outlookTenant()}/oauth2/v2.0/token`, scope: 'offline_access User.Read Mail.Read' };
}
export function encryptTokens(value) {
  const key = createHash('sha256').update(process.env.EMAIL_TOKEN_ENCRYPTION_KEY || config.jwtSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(part => part.toString('base64url')).join('.');
}
export function decryptTokens(value) {
  const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  const key = createHash('sha256').update(process.env.EMAIL_TOKEN_ENCRYPTION_KEY || config.jwtSecret).digest();
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString());
}
export async function remoteJson(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) }); }
  catch { throw Object.assign(new Error('Email provider could not be reached. Please try again.'), { status: 502, code: 'provider_unreachable' }); }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error;
    const reasons = [...(error?.errors || []).map(item => item.reason), ...(error?.details || []).map(item => item.reason)];
    let code = response.status === 401 ? 'mailbox_access_expired' : response.status === 403 ? 'mailbox_permission_denied' : 'provider_rejected';
    let message = response.status === 401 ? 'Mailbox access expired. Reconnect your mailbox.' : response.status === 403 ? 'Mailbox permission was denied. Check email permissions and reconnect.' : 'Email provider rejected the request. Please try again.';
    if (new URL(url).hostname === 'gmail.googleapis.com' && (reasons.includes('SERVICE_DISABLED') || reasons.includes('accessNotConfigured'))) {
      code = 'gmail_api_disabled';
      message = 'Gmail API is not enabled in the Google Cloud project containing your OAuth client. Enable Gmail API, then reconnect.';
    } else if (error === 'invalid_grant') {
      code = 'oauth_code_expired';
      message = 'The authorization code expired or was already used. Start a fresh mailbox connection.';
    } else if (error === 'invalid_client') {
      code = 'oauth_client_invalid';
      message = 'The email OAuth client configuration was rejected. Check the client ID and secret.';
    }
    throw Object.assign(new Error(message), { status: response.status === 401 || response.status === 403 ? 400 : 502, code, providerStatus: response.status });
  }
  if (!data) throw Object.assign(new Error('Email provider returned an unreadable response.'), { status: 502, code: 'provider_invalid_response' });
  return data;
}
export async function exchange(provider, values) {
  const cfg = settings(provider);
  return remoteJson(cfg.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.id, client_secret: cfg.secret, ...values }) });
}
export async function accessToken(connection) {
  let tokens;
  try { tokens = decryptTokens(connection.encryptedTokens); }
  catch { throw Object.assign(new Error('Reconnect your mailbox to restore access.'), { status: 400 }); }
  if (tokens.expiresAt > Date.now() + 60000) return tokens.access_token;
  if (!tokens.refresh_token) throw Object.assign(new Error('Mailbox access expired. Reconnect your mailbox.'), { status: 400 });
  const fresh = await exchange(connection.provider, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, ...(connection.provider === 'outlook' ? { scope: settings('outlook').scope } : {}) });
  if (!fresh.access_token) throw Object.assign(new Error('Reconnect your mailbox to restore access.'), { status: 400 });
  connection.encryptedTokens = encryptTokens({ ...tokens, ...fresh, expiresAt: Date.now() + (fresh.expires_in || 3600) * 1000 });
  await connection.save();
  return fresh.access_token;
}
export async function mailboxIdentity(provider, token) {
  const data = await remoteJson(provider === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile' : 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { Authorization: `Bearer ${token}` } });
  return provider === 'gmail' ? data.emailAddress : data.mail || data.userPrincipalName;
}
export function textOnly(value = '') {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<\/?(?:p|div|br|li)[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim().slice(0, 30000);
}
function gmailText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  const plain = (part.parts || []).filter(child => child.mimeType !== 'text/html').map(gmailText).filter(Boolean).join('\n');
  if (plain) return plain;
  if (part.body?.data && part.mimeType === 'text/html') return textOnly(Buffer.from(part.body.data, 'base64url').toString('utf8'));
  return (part.parts || []).map(gmailText).filter(Boolean).join('\n');
}
export function normalizeGmail(thread) {
  const messages = (thread.messages || []).slice(-100).map(message => {
    const header = name => message.payload?.headers?.find(item => item.name.toLowerCase() === name)?.value || '';
    const fullBody = gmailText(message.payload);
    return { truncated: fullBody.length > 30000, id: message.id, subject: header('subject'), from: header('from'), to: header('to'), date: new Date(Number(message.internalDate) || 0).toISOString(), body: fullBody.slice(0, 30000), snippet: message.snippet || '' };
  });
  const last = messages.at(-1);
  return { truncated: (thread.messages || []).length > 100 || messages.some(message => message.truncated), id: thread.id, subject: messages[0]?.subject || '(No subject)', from: last?.from || '', date: last?.date, snippet: last?.snippet || '', messages, url: `https://mail.google.com/mail/u/0/#all/${thread.id}` };
}
function normalizeOutlook(messages, id) {
  const normalized = messages.map(message => ({ id: message.id, subject: message.subject, from: message.from?.emailAddress?.address || '', to: (message.toRecipients || []).map(item => item.emailAddress?.address).join(', '), date: message.receivedDateTime, body: message.body?.contentType?.toLowerCase() === 'html' ? textOnly(message.body.content) : (message.body?.content || '').slice(0, 30000), snippet: message.bodyPreview || '' })).sort((a,b) => new Date(a.date) - new Date(b.date));
  const last = normalized.at(-1);
  return { id, subject: last?.subject || '(No subject)', from: last?.from || '', date: last?.date, snippet: last?.snippet || '', messages: normalized, url: messages[0]?.webLink || '' };
}
function safeGraphLink(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com' || url.pathname !== '/v1.0/me/messages' || url.username || url.password) throw Object.assign(new Error('Invalid mailbox page token.'), { status: 400 });
  return url.toString();
}
export async function listThreads(provider, token, { q = '', pageToken = '' } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (provider === 'gmail') {
    const params = new URLSearchParams({ maxResults: '20', q, ...(pageToken ? { pageToken } : {}) });
    const data = await remoteJson(`https://gmail.googleapis.com/gmail/v1/users/me/threads?${params}`, { headers });
    const threads = [];
    // Bound concurrency to avoid flooding provider quotas.
    for (let i = 0; i < (data.threads || []).length; i += 5) {
      threads.push(...await Promise.all(data.threads.slice(i, i + 5).map(thread => remoteJson(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(thread.id)}?format=metadata`, { headers }).then(normalizeGmail))));
    }
    return { threads: threads.map(({ messages, ...thread }) => ({ ...thread, messageCount: messages.length })), nextPageToken: data.nextPageToken || null };
  }
  const params = new URLSearchParams({ '$top': '30', '$select': 'id,conversationId,subject,from,receivedDateTime,bodyPreview,webLink', ...(q ? { '$search': `"${q.replace(/["\\]/g, '')}"` } : { '$orderby': 'receivedDateTime desc' }) });
  const url = pageToken ? safeGraphLink(Buffer.from(pageToken, 'base64url').toString()) : `https://graph.microsoft.com/v1.0/me/messages?${params}`;
  const data = await remoteJson(url, { headers });
  const grouped = new Map();
  for (const message of data.value || []) { const id = message.conversationId || message.id; grouped.set(id, [...(grouped.get(id) || []), message]); }
  return { threads: [...grouped].map(([id, messages]) => { const thread = normalizeOutlook(messages, id); return { ...thread, messages: undefined, messageCount: messages.length }; }), nextPageToken: data['@odata.nextLink'] ? Buffer.from(safeGraphLink(data['@odata.nextLink'])).toString('base64url') : null };
}
export async function readThread(provider, token, id) {
  const headers = { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' };
  if (provider === 'gmail') return normalizeGmail(await remoteJson(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=full`, { headers }));
  const params = new URLSearchParams({ '$filter': `conversationId eq '${id.replace(/'/g, "''")}'`, '$top': '100', '$select': 'id,subject,from,toRecipients,receivedDateTime,body,bodyPreview,webLink' });
  const data = await remoteJson(`https://graph.microsoft.com/v1.0/me/messages?${params}`, { headers });
  if (!data.value?.length) throw Object.assign(new Error('Email conversation not found.'), { status: 404 });
  // Never silently import a truncated conversation.
  if (data['@odata.nextLink']) throw Object.assign(new Error('This conversation has more than 100 messages. Choose a smaller conversation.'), { status: 400 });
  return normalizeOutlook(data.value, id);
}
