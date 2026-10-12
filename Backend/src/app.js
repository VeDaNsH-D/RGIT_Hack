import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import authRouter from './routes/auth.js';
import projectsRouter from './routes/projects.js';
import notesRouter from './routes/notes.js';
import documentsRouter from './routes/documents.js';
import ingestionRouter from './routes/ingestion.js';
import tasksRouter from './routes/tasks.js';
import handoffsRouter from './routes/handoffs.js';
import conflictsRouter from './routes/conflicts.js';
import cronRouter from './routes/cron.js';
import { notificationRouter } from './notifications/routes.js';

export const app = express();

app.use(helmet());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
// POST /api/projects/:id/documents (multipart upload; see routes/documents.js)
app.use('/api/projects', documentsRouter);
// Read-only ingestion APIs: source records, document list/detail, ingestion status.
app.use('/api/projects', ingestionRouter);
// notesRouter and tasksRouter each define both a /projects/:id/... path and
// a flat /notes/:id or /tasks/:id path, so they're mounted at /api rather
// than /api/projects.
app.use('/api', notesRouter);
app.use('/api', tasksRouter);
app.use('/api', handoffsRouter);
app.use('/api', conflictsRouter);
app.use('/api', cronRouter);
app.use('/api/notifications', notificationRouter);

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
