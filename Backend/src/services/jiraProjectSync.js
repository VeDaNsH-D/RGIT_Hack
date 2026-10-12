import { JiraConnection } from '../models/JiraConnection.js';
import { JiraConnector } from '../integrations/jira/index.js';
import { persistSourceRecordCandidates } from '../modules/ingestion/persistence/sourceRecordStore.js';
import { getValidJiraAccessToken } from './jiraOAuthService.js';
import { redactSecrets } from '../modules/ingestion/providers/github/githubErrors.js';

/**
 * Project-level Jira link. A user connects Jira once (JiraConnection, per user); a project owner then links ONE Jira
 * project key to a Relay project (SourceConnection provider 'jira'). Syncs always use the linking user's credentials
 * server-side, so any member can refresh the data without ever seeing or needing the token.
 */

export const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
export const JIRA_SYNC_LIMITS = Object.freeze({ maxPages: 4, perPage: 25 });

export class JiraLinkError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Connector for the credentials stored on a user's JiraConnection (OAuth or API token). */
export async function connectorFor(conn) {
  if (conn.authType === 'oauth' || conn.cloudId) {
    return new JiraConnector({ cloudId: conn.cloudId, accessToken: await getValidJiraAccessToken(conn) });
  }
  return new JiraConnector({ host: conn.host, email: conn.email, apiToken: conn.apiToken });
}

/**
 * Pulls the linked Jira project's issues into SourceRecords for the Relay project and records the outcome on the link.
 * Never throws for provider failures: they are stored (sanitized) as sync status 'failed' so the UI and handoff can say so.
 */
export async function syncJiraLink(link, { connectorFactory = connectorFor, now = () => new Date() } = {}) {
  const projectKey = link.config?.projectKey;
  const previous = link.config?.sync || {};
  try {
    const conn = await JiraConnection.findOne({ userId: link.connectedBy, active: true });
    if (!conn) throw new JiraLinkError(400, 'not_connected', 'The Jira account that linked this project is no longer connected.');
    const connector = await connectorFactory(conn);
    const result = await connector.sync({ projectKey, projectId: String(link.projectId), ...JIRA_SYNC_LIMITS, asCandidate: true });
    const records = result.records || [];
    if (records.length) await persistSourceRecordCandidates({ projectId: String(link.projectId), records, now });
    const partial = (result.errors?.length || 0) > 0;
    if (partial && !records.length) throw new JiraLinkError(502, 'jira_sync_failed', result.errors[0]?.message || 'Jira returned an error.');
    link.config = { ...link.config, siteName: conn.siteName || conn.host || link.config?.siteName, siteUrl: conn.siteUrl || conn.host || link.config?.siteUrl,
      sync: { status: partial ? 'partial' : 'completed', lastSuccessAt: now(), syncedIssueCount: records.length, ...(partial ? { error: redactSecrets(result.errors[0]?.message || 'Some issues could not be fetched.') } : {}) } };
  } catch (err) {
    link.config = { ...link.config, sync: { ...previous, status: 'failed', error: redactSecrets(err?.message || 'Jira sync failed.').slice(0, 300) } };
  }
  link.markModified('config');
  await link.save();
  return link;
}

export const serializeJiraLink = (r) => ({
  id: String(r._id),
  projectKey: r.config?.projectKey,
  siteName: r.config?.siteName || null,
  siteUrl: r.config?.siteUrl || null,
  sync: r.config?.sync || { status: 'pending' },
  createdAt: r.createdAt,
});
