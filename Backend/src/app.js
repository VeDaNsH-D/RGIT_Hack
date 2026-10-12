import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import authRouter from './routes/auth.js';
import emailRouter from './routes/email.js';
import projectsRouter from './routes/projects.js';
import notesRouter from './routes/notes.js';
import documentsRouter from './routes/documents.js';
import ingestionRouter from './routes/ingestion.js';
import notionRouter from './routes/notion.js';
import invitationsRouter from './routes/invitations.js';
import mcpRouter from './mcp/router.js';
import { keyRouter } from './mcp/keys.js';
import { oauthRouter, consentRouter, publicMcpUrl } from './mcp/oauth.js';
import tasksRouter from './routes/tasks.js';
import handoffsRouter from './routes/handoffs.js';
import conflictsRouter from './routes/conflicts.js';
import connectionsRouter from './routes/connections.js';
import repositoryKnowledgeRouter from './routes/repositoryKnowledge.js';
import githubWebhookRouter from './routes/githubWebhook.js';
import cronRouter from './routes/cron.js';
import { notificationRouter } from './notifications/routes.js';
import { agoraRouter } from './routes/agora.js';

export const app = express();
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (Number.isInteger(proxyHops) && proxyHops > 0 && proxyHops <= 5) app.set('trust proxy', proxyHops);

app.use(helmet());
// OAuth discovery and token endpoints have SDK-managed CORS; website APIs retain their origin policy.
app.use(express.json({
  limit: '1mb',
  // Preserve the signed webhook bytes before any middleware consumes the body.
  verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/webhooks/github')) req.rawBody = buf; },
}));
app.use(oauthRouter);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(Object.assign(new Error('Not allowed by CORS'), { status: 403, code: 'origin_not_allowed' }));
    },
    credentials: true,
  })
);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/mcp/keys', keyRouter);
app.use('/api/mcp/oauth/requests', consentRouter);
app.get('/api/mcp/info', (req, res) => res.json({ url: publicMcpUrl(), oauth: true }));
app.use('/mcp', mcpRouter);
app.use('/api/email', emailRouter);
app.use('/api/projects', projectsRouter);
// POST /api/projects/:id/documents (multipart upload; see routes/documents.js)
app.use('/api/projects', documentsRouter);
// Read-only ingestion APIs: source records, document list/detail, ingestion status.
app.use('/api/projects', ingestionRouter);
app.use('/api/projects', notionRouter);
app.use('/api', invitationsRouter);
app.use('/api/projects', repositoryKnowledgeRouter);
// notesRouter and tasksRouter each define both a /projects/:id/... path and
// a flat /notes/:id or /tasks/:id path, so they're mounted at /api rather
// than /api/projects.
app.use('/api', notesRouter);
app.use('/api', tasksRouter);
app.use('/api', handoffsRouter);
app.use('/api', conflictsRouter);
app.use('/api', cronRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/webhooks', githubWebhookRouter);
app.use('/api/agora', agoraRouter);

// 404 for unmatched API routes.
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Route not found' });
});

// Generic error handler: never leak stack traces or internal error details.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('Unhandled error:', err);
  }
  if (!res.headersSent) {
    const message = status < 500 ? err.message : 'Internal server error';
    res.status(status).json({ error: err.code || 'internal_error', message });
  }
});

export default app;
