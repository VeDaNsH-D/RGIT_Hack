import { Router } from 'express';
import { logActivity } from '../audit/service.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { SourceConnection } from '../models/SourceConnection.js';
import { SyncError } from '../services/githubSyncEngine.js';
import { analyzeConnection, getAnalysisStatus } from '../services/repositoryAnalysisService.js';
import { HandoffReport } from '../models/HandoffReport.js';
import { AiServiceError } from '../services/aiClient.js';
import { DraftError } from '../services/handoffDraftService.js';
import { ReportError, generateDeveloperHandoffReport, serializeReport, serializeReportMeta } from '../services/developerHandoffReportService.js';
import { renderReportPdf } from '../services/reportPdf.js';

/**
 * Repository analysis (knowledge base) endpoints. All are project-scoped: the repository must be a
 * GitHub connection of THIS project, and analysis reads only through that project's own installation.
 */
const router = Router();
const isId = (v) => /^[a-f0-9]{24}$/i.test(v);

async function describe(connection) {
  return { connectionId: String(connection._id), repository: { id: connection.config?.repositoryId, fullName: connection.config?.fullName, isPrivate: Boolean(connection.config?.isPrivate), htmlUrl: connection.config?.htmlUrl }, analysis: await getAnalysisStatus(connection) };
}

router.get('/:id/repository-knowledge', requireAuth, attachProject(), requireRole('viewer'), async (req, res, next) => {
  try {
    const rows = await SourceConnection.find({ projectId: req.project._id, provider: 'github' }).sort({ createdAt: 1 }).lean();
    res.json({ repositories: await Promise.all(rows.map(describe)) });
  } catch (err) { next(err); }
});

/** Members and owners may analyze or refresh; viewers may not. Runs inline within the request. */
router.post('/:id/integrations/github/:connectionId/analyze', requireAuth, attachProject(), requireRole('member'), async (req, res, next) => {
  try {
    if (!isId(req.params.connectionId)) return res.status(400).json({ error: 'validation_error', message: 'Invalid connection id' });
    const owned = await SourceConnection.exists({ _id: req.params.connectionId, projectId: req.project._id, provider: 'github' });
    if (!owned) return res.status(404).json({ error: 'not_found', message: 'Repository connection not found' });
    const doc = await analyzeConnection(req.params.connectionId, { force: req.body?.force === true });
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'REPOSITORY_ANALYSIS_UPDATED', targetType: 'SourceConnection', targetId: doc._id, payload: { repository: doc.config?.fullName, status: doc.config?.analysis?.status } });
    res.json(await describe(doc));
  } catch (err) {
    if (err instanceof SyncError) return res.status(err.status).json({ error: err.code, message: err.message });
    next(err);
  }
});

/** Generate a developer handoff report from repository knowledge + project activity. Not a team handoff. */
router.post('/:id/handoff-reports', requireAuth, attachProject(), requireRole('member'), async (req, res, next) => {
  try {
    const report = await generateDeveloperHandoffReport(req.project, req.user);
    await logActivity({ projectId: req.project._id, actorId: req.user._id, action: 'HANDOFF_REPORT_GENERATED', targetType: 'HandoffReport', targetId: report.id, payload: { title: req.project.name } });
    res.status(201).json({ report });
  } catch (err) {
    if (err instanceof ReportError || err instanceof DraftError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof AiServiceError) return res.status(err.status || 502).json({ error: err.code || 'ai_service_error', message: err.message });
    next(err);
  }
});

router.get('/:id/handoff-reports', requireAuth, attachProject(), requireRole('viewer'), async (req, res, next) => {
  try {
    const rows = await HandoffReport.find({ projectId: req.project._id }).sort({ generatedAt: -1 }).limit(10).select('generatedAt repositories createdBy').lean();
    res.json({ reports: rows.map(serializeReportMeta) });
  } catch (err) { next(err); }
});

async function loadReport(req, res) {
  if (!isId(req.params.reportId)) { res.status(400).json({ error: 'validation_error', message: 'Invalid report id' }); return null; }
  const report = await HandoffReport.findOne({ _id: req.params.reportId, projectId: req.project._id }).lean();
  if (!report) res.status(404).json({ error: 'not_found', message: 'Report not found' });
  return report;
}

router.get('/:id/handoff-reports/:reportId', requireAuth, attachProject(), requireRole('viewer'), async (req, res, next) => {
  try {
    const report = await loadReport(req, res);
    if (report) res.json({ report: serializeReport(report) });
  } catch (err) { next(err); }
});

router.get('/:id/handoff-reports/:reportId/pdf', requireAuth, attachProject(), requireRole('viewer'), async (req, res, next) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    const pdf = await renderReportPdf(serializeReport(report));
    const name = `${String(report.projectName).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'project'}-developer-handoff.pdf`;
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'Content-Length': pdf.length }).send(pdf);
  } catch (err) { next(err); }
});

export default router;
