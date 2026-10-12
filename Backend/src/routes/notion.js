import { NotionConnection } from '../models/NotionConnection.js';
import { withNotionToken } from '../services/notionOAuthService.js';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { NotionConnector } from '../modules/ingestion/providers/notion/notionConnector.js';
import { parseNotionId } from '../modules/ingestion/providers/notion/notionNormalizer.js';
import { persistSourceRecordCandidates } from '../modules/ingestion/persistence/sourceRecordStore.js';
import { logActivity } from '../audit/service.js';

export function createNotionRouter({ connections = SourceConnection, records = SourceRecord, connector = apiKey => new NotionConnector({ apiKey, notionVersion: process.env.NOTION_VERSION || '2022-06-28', fetchFn: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }) }), persist = persistSourceRecordCandidates, guards = [requireAuth, attachProject(), requireRole('owner')] } = {}) {
  const router = Router();
  const configured = () => Boolean(process.env.NOTION_API_KEY || process.env.NOTION_TOKEN);
  const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
  router.get('/:id/notion', ...guards, handle(async (req, res) => {
    const rows = await connections.find({ projectId: req.project._id, provider: 'notion' }).lean();
    const pages = await records.find({ projectId: req.project._id, provider: 'notion' }).select('title content url updatedAt').sort({ updatedAt: -1 }).limit(50).lean();
    res.set('Cache-Control', 'no-store').json({ configured: configured() || Boolean(await NotionConnection.exists({ userId: req.user._id, active: true })), connections: rows.map(row => ({ id: String(row._id), pageId: row.config?.pageId, title: row.config?.title, syncedAt: row.config?.syncedAt })), pages: pages.map(page => ({ id: String(page._id), title: page.title, content: page.content, url: page.url, updatedAt: page.updatedAt })) });
  }));
  router.post('/:id/notion', ...guards, handle(async (req, res) => {
    const account = await NotionConnection.findOne({ userId: req.user._id, active: true });
    if (!configured() && !account) return res.status(503).json({ message: 'Connect your Notion account first.' });
    const raw = req.body?.pageId;
    const pageId = typeof raw === 'string' && raw.length <= 2000 ? parseNotionId(raw) : '';
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(pageId)) return res.status(400).json({ message: 'Enter a valid Notion page URL or ID.' });
    let record;
    try {
      const read = apiKey => connector(apiKey).fetchPage(pageId, { projectId: String(req.project._id), fetchContent: true, maxDepth: 4 });
      record = account ? await withNotionToken(account, read) : await read(undefined);
    }
    catch (error) {
      const status = error.statusCode;
      return res.status(status === 401 || status === 403 || status === 404 ? 400 : 502).json({ message: status === 404 || status === 403 ? 'Notion could not access this page. Reauthorize your Notion connection and select this page, or share it with your internal integration. Public sharing alone does not grant API access.' : status === 401 ? 'Your Notion authorization is invalid. Reconnect Notion and try again.' : 'Notion could not be reached. Please try again.' });
    }
    const saved = await persist({ projectId: String(req.project._id), records: [record] });
    if (!saved.persisted || saved.failedCount) return res.status(500).json({ message: 'The Notion page could not be saved. Please retry.' });
    await connections.updateOne({ projectId: req.project._id, provider: 'notion', 'config.pageId': pageId }, { $set: { 'config.title': record.title, 'config.syncedAt': new Date() }, $setOnInsert: { projectId: req.project._id, provider: 'notion', 'config.pageId': pageId, connectedBy: req.user._id } }, { upsert: true });
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'NOTION_PAGE_SYNCED', payload: { title: record.title } });
    res.json({ title: record.title, imported: saved.createdCount, updated: saved.updatedCount });
  }));
  router.delete('/:id/notion/:connectionId', ...guards, handle(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.connectionId)) return res.status(400).json({ message: 'Invalid connection ID.' });
    const result = await connections.deleteOne({ _id: req.params.connectionId, projectId: req.project._id, provider: 'notion' });
    if (result.deletedCount) await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'NOTION_DISCONNECTED' });
    res.json({ disconnected: true });
  }));
  return router;
}
export default createNotionRouter();
