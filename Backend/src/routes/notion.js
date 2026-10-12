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

/**
 * Extracts remaining/open tasks and completed tasks from Notion content and metadata.
 */
export function extractRemainingWork(records = []) {
  const allRecords = Array.isArray(records) ? records.filter(Boolean) : [records].filter(Boolean);
  const remaining = [];
  const completed = [];

  for (const rec of allRecords) {
    const content = rec.content || '';
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Unchecked checklist item: - [ ] or * [ ] or [ ]
      const uncheckMatch = trimmed.match(/^[-*]?\s*\[\s*\]\s*(.+)/);
      if (uncheckMatch) {
        remaining.push(uncheckMatch[1].trim());
        continue;
      }
      // Checked checklist item: - [x] or * [x] or [x]
      const checkMatch = trimmed.match(/^[-*]?\s*\[x\]\s*(.+)/i);
      if (checkMatch) {
        completed.push(checkMatch[1].trim());
        continue;
      }
    }

    // Check database row properties (Status / Checkbox / Select)
    const pm = rec.metadata?.providerMetadata;
    if (pm?.properties) {
      for (const [propKey, propVal] of Object.entries(pm.properties)) {
        if (propVal?.type === 'status' && propVal.status?.name) {
          const sName = propVal.status.name;
          const isDone = /done|complete|closed|finished|resolved/i.test(sName);
          if (isDone) completed.push(`${rec.title} (${sName})`);
          else remaining.push(`${rec.title} (${sName})`);
        } else if (propVal?.type === 'checkbox') {
          if (propVal.checkbox) completed.push(rec.title);
          else remaining.push(rec.title);
        } else if (propVal?.type === 'select' && propVal.select?.name && /status|state|progress|stage/i.test(propKey)) {
          const sName = propVal.select.name;
          const isDone = /done|complete|closed|finished|resolved/i.test(sName);
          if (isDone) completed.push(`${rec.title} (${sName})`);
          else remaining.push(`${rec.title} (${sName})`);
        }
      }
    }
  }

  return {
    remainingItems: remaining,
    completedItems: completed,
    remainingCount: remaining.length,
    completedCount: completed.length,
    totalCount: remaining.length + completed.length,
    hasChecklist: (remaining.length + completed.length) > 0,
  };
}

export function createNotionRouter({
  connections = SourceConnection,
  records = SourceRecord,
  connector = apiKey =>
    new NotionConnector({
      apiKey,
      notionVersion: process.env.NOTION_VERSION || '2022-06-28',
      fetchFn: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }),
    }),
  persist = persistSourceRecordCandidates,
  guards,
  viewGuards = guards || [requireAuth, attachProject(), requireRole('viewer')],
  syncGuards = guards || [requireAuth, attachProject(), requireRole('member')],
  ownerGuards = guards || [requireAuth, attachProject(), requireRole('owner')],
} = {}) {
  const router = Router();
  const configured = () => Boolean(process.env.NOTION_API_KEY || process.env.NOTION_TOKEN);
  const handle = fn => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      next(error);
    }
  };

  const serializeNotionLink = (row) => ({
    id: String(row._id),
    pageId: row.config?.pageId,
    title: row.config?.title || 'Notion page',
    url: row.config?.url,
    syncedAt: row.config?.syncedAt || row.config?.sync?.lastSuccessAt,
    sync: row.config?.sync || {
      status: row.config?.syncedAt ? 'completed' : 'pending',
      lastSuccessAt: row.config?.syncedAt,
      remainingCount: row.config?.sync?.remainingCount ?? 0,
      completedCount: row.config?.sync?.completedCount ?? 0,
      totalCount: row.config?.sync?.totalCount ?? 0,
      remainingItems: row.config?.sync?.remainingItems || [],
      completedItems: row.config?.sync?.completedItems || [],
    },
    createdAt: row.createdAt,
  });

  // GET /api/projects/:id/notion -> list linked Notion connections and pages
  router.get('/:id/notion', ...viewGuards, handle(async (req, res) => {
    const rows = await connections.find({ projectId: req.project._id, provider: 'notion' }).lean();
    const pages = await records
      .find({ projectId: req.project._id, provider: 'notion' })
      .select('title content url updatedAt metadata')
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();

    res.set('Cache-Control', 'no-store').json({
      configured: configured() || Boolean(await NotionConnection.exists({ userId: req.user._id, active: true })),
      connections: rows.map(serializeNotionLink),
      pages: pages.map(page => ({
        id: String(page._id),
        title: page.title,
        content: page.content,
        url: page.url,
        updatedAt: page.updatedAt,
      })),
    });
  }));

  // POST /api/projects/:id/notion -> Link and sync a Notion page or database
  router.post('/:id/notion', ...ownerGuards, handle(async (req, res) => {
    const account = await NotionConnection.findOne({ userId: req.user._id, active: true });
    if (!configured() && !account) {
      return res.status(503).json({ message: 'Connect your Notion account first.' });
    }

    const raw = req.body?.pageId || req.body?.databaseId || req.body?.raw;
    const pageId = typeof raw === 'string' && raw.length <= 2000 ? parseNotionId(raw) : '';
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(pageId)) {
      return res.status(400).json({ message: 'Enter a valid Notion page URL or ID.' });
    }

    let fetchedRecords = [];
    try {
      const read = async (apiKey) => {
        const c = connector(apiKey);
        try {
          const rec = await c.fetchPage(pageId, { projectId: String(req.project._id), fetchContent: true, maxDepth: 4 });
          return [rec];
        } catch (pageErr) {
          try {
            const dbRecords = await c.fetchDatabase(pageId, { projectId: String(req.project._id), fetchPageContent: true, maxDepth: 3 });
            if (dbRecords && dbRecords.length) return dbRecords;
          } catch {}
          throw pageErr;
        }
      };
      fetchedRecords = account ? await withNotionToken(account, read) : await read(undefined);
    } catch (error) {
      const status = error.statusCode;
      return res.status(status === 401 || status === 403 || status === 404 ? 400 : 502).json({
        message:
          status === 404 || status === 403
            ? 'Notion could not access this page. Reauthorize your Notion connection and select this page, or share it with your internal integration. Public sharing alone does not grant API access.'
            : status === 401
            ? 'Your Notion authorization is invalid. Reconnect Notion and try again.'
            : 'Notion could not be reached. Please try again.',
      });
    }

    const primaryRecord = fetchedRecords[0];
    if (!primaryRecord) {
      return res.status(502).json({ message: 'No content could be retrieved from Notion.' });
    }

    const saved = await persist({ projectId: String(req.project._id), records: fetchedRecords });
    if (!saved.persisted || saved.failedCount) {
      return res.status(500).json({ message: 'The Notion page could not be saved. Please retry.' });
    }

    const remainingWork = extractRemainingWork(fetchedRecords);

    let link = await connections.findOne({ projectId: req.project._id, provider: 'notion', 'config.pageId': pageId });
    if (!link) {
      link = new connections({
        projectId: req.project._id,
        provider: 'notion',
        connectedBy: req.user._id,
        config: {
          pageId,
          title: primaryRecord.title,
          url: primaryRecord.url,
          syncedAt: new Date(),
          sync: {
            status: 'completed',
            lastSuccessAt: new Date(),
            remainingCount: remainingWork.remainingCount,
            completedCount: remainingWork.completedCount,
            totalCount: remainingWork.totalCount,
            remainingItems: remainingWork.remainingItems,
            completedItems: remainingWork.completedItems,
          },
        },
      });
    } else {
      link.config = {
        ...link.config,
        title: primaryRecord.title,
        url: primaryRecord.url,
        syncedAt: new Date(),
        sync: {
          status: 'completed',
          lastSuccessAt: new Date(),
          remainingCount: remainingWork.remainingCount,
          completedCount: remainingWork.completedCount,
          totalCount: remainingWork.totalCount,
          remainingItems: remainingWork.remainingItems,
          completedItems: remainingWork.completedItems,
        },
      };
      link.markModified('config');
    }
    await link.save();

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'NOTION_PAGE_SYNCED',
      payload: { title: primaryRecord.title, remainingCount: remainingWork.remainingCount },
    });

    res.json({
      title: primaryRecord.title,
      imported: saved.createdCount,
      updated: saved.updatedCount,
      integration: serializeNotionLink(link),
      remainingCount: remainingWork.remainingCount,
      completedCount: remainingWork.completedCount,
      remainingItems: remainingWork.remainingItems,
    });
  }));

  // POST /api/projects/:id/notion/:connectionId/sync -> Sync an existing linked Notion page/database
  router.post('/:id/notion/:connectionId/sync', ...syncGuards, handle(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.connectionId)) {
      return res.status(400).json({ message: 'Invalid connection ID.' });
    }

    const link = await connections.findOne({
      _id: req.params.connectionId,
      projectId: req.project._id,
      provider: 'notion',
    });
    if (!link) {
      return res.status(404).json({ message: 'Notion connection not found.' });
    }

    const pageId = link.config?.pageId;
    if (!pageId) {
      return res.status(400).json({ message: 'Connection is missing a Notion page ID.' });
    }

    const account = await NotionConnection.findOne({ userId: req.user._id, active: true });
    if (!configured() && !account) {
      return res.status(503).json({ message: 'Connect your Notion account first.' });
    }

    let fetchedRecords = [];
    try {
      const read = async (apiKey) => {
        const c = connector(apiKey);
        try {
          const rec = await c.fetchPage(pageId, { projectId: String(req.project._id), fetchContent: true, maxDepth: 4 });
          return [rec];
        } catch (pageErr) {
          try {
            const dbRecords = await c.fetchDatabase(pageId, { projectId: String(req.project._id), fetchPageContent: true, maxDepth: 3 });
            if (dbRecords && dbRecords.length) return dbRecords;
          } catch {}
          throw pageErr;
        }
      };
      fetchedRecords = account ? await withNotionToken(account, read) : await read(undefined);
    } catch (error) {
      const status = error.statusCode;
      link.config = {
        ...link.config,
        sync: {
          ...(link.config?.sync || {}),
          status: 'failed',
          error: error.message || 'Notion sync failed.',
        },
      };
      link.markModified('config');
      await link.save();
      return res.status(status === 401 || status === 403 || status === 404 ? 400 : 502).json({
        message: error.message || 'Could not sync Notion page.',
      });
    }

    const primaryRecord = fetchedRecords[0];
    await persist({ projectId: String(req.project._id), records: fetchedRecords });
    const remainingWork = extractRemainingWork(fetchedRecords);

    link.config = {
      ...link.config,
      title: primaryRecord.title,
      url: primaryRecord.url,
      syncedAt: new Date(),
      sync: {
        status: 'completed',
        lastSuccessAt: new Date(),
        remainingCount: remainingWork.remainingCount,
        completedCount: remainingWork.completedCount,
        totalCount: remainingWork.totalCount,
        remainingItems: remainingWork.remainingItems,
        completedItems: remainingWork.completedItems,
      },
    };
    link.markModified('config');
    await link.save();

    await logActivity({
      projectId: req.project._id,
      actorId: req.user._id,
      action: 'NOTION_PAGE_SYNCED',
      payload: { title: primaryRecord.title, remainingCount: remainingWork.remainingCount },
    });

    res.json({
      integration: serializeNotionLink(link),
      remainingCount: remainingWork.remainingCount,
      completedCount: remainingWork.completedCount,
      remainingItems: remainingWork.remainingItems,
    });
  }));

  // DELETE /api/projects/:id/notion/:connectionId -> Unlink Notion page
  router.delete('/:id/notion/:connectionId', ...ownerGuards, handle(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.connectionId)) {
      return res.status(400).json({ message: 'Invalid connection ID.' });
    }

    const row = await connections.findOne({
      _id: req.params.connectionId,
      projectId: req.project._id,
      provider: 'notion',
    }).lean();

    if (!row) {
      return res.status(404).json({ message: 'Notion connection not found.' });
    }

    await connections.deleteOne({ _id: req.params.connectionId, projectId: req.project._id, provider: 'notion' });

    if (row.config?.pageId) {
      await records.deleteMany({ projectId: req.project._id, provider: 'notion', externalId: row.config.pageId });
    }

    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'NOTION_DISCONNECTED' });
    res.json({ disconnected: true });
  }));

  return router;
}

export default createNotionRouter();
