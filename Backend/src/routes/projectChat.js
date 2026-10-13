import { describeChatFailure } from '../chat/errors.js';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { ProjectChatTurn } from '../models/ProjectChatTurn.js';
import { retrieveProjectChat } from '../chat/retrieval.js';
const router = Router();
const guards = [requireAuth, attachProject(), requireRole('viewer')];
const limiter = rateLimit({ windowMs: 60000, limit: 12, keyGenerator: req => String(req.user._id), message: { message: 'Please wait a moment before asking another question.' } });
const turn = row => ({ id: String(row._id), question: row.question, answer: row.answer, citations: row.citations, limitations: row.limitations, createdAt: row.createdAt });
router.get('/:id/chat', ...guards, async (req, res, next) => {
  try { const rows = await ProjectChatTurn.find({ projectId: req.project._id, userId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(); res.set('Cache-Control', 'no-store').json({ turns: rows.reverse().map(turn) }); } catch (error) { next(error); }
});
router.delete('/:id/chat', ...guards, async (req, res, next) => {
  try { await ProjectChatTurn.deleteMany({ projectId: req.project._id, userId: req.user._id }); res.json({ cleared: true }); } catch (error) { next(error); }
});
router.post('/:id/chat', ...guards, limiter, async (req, res, next) => {
  try {
    const question = req.body?.question;
    if (typeof question !== 'string' || !question.trim() || question.length > 2000) return res.status(400).json({ message: 'Enter a question of up to 2,000 characters.' });
    const filter = { projectId: req.project._id, userId: req.user._id };
    const history = (await ProjectChatTurn.find(filter).sort({ createdAt: -1 }).limit(3).lean()).reverse();
    const context = await retrieveProjectChat(req.project, question, history);
    let answer = 'I couldn’t find relevant evidence in this project. Import or sync the relevant sources, or ask a more specific question.'; let citations = [];
    if (context.sources.length) {
      const base = (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');
      let response;
      try { response = await fetch(`${base}/api/v1/project-chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: question.trim(), sources: context.sources, history: history.map(row => ({ question: row.question.slice(0, 2000), answer: row.answer.slice(0, 3000) })) }), signal: AbortSignal.timeout(45000) }); }
      catch { return res.status(503).json({ message: 'The AI service is unavailable. Please retry; your question was not saved.' }); }
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = describeChatFailure(response.status, data);
        console.warn(`[project-chat] AI HTTP ${response.status}: ${failure.error}`);
        return res.status(failure.status).json({ error: failure.error, message: failure.message });
      }
      const cited = [...new Set([...String(data?.answer || '').matchAll(/\[(S\d+)\]/g)].map(match => match[1]))];
      const available = new Map(context.sources.map(source => [source.id, source]));
      if (typeof data?.answer !== 'string' || !data.answer.trim() || data.answer.length > 8000 || (!data.insufficientEvidence && !cited.length) || cited.some(id => !available.has(id))) return res.status(502).json({ message: 'The AI returned an answer without valid evidence. Please retry.' });
      answer = data.answer;
      citations = cited.map(id => available.get(id));
    }
    const saved = await ProjectChatTurn.create({ ...filter, question: question.trim(), answer, citations, limitations: context.limitations });
    res.set('Cache-Control', 'no-store').status(201).json({ turn: turn(saved) });
  } catch (error) { next(error); }
});
export default router;
