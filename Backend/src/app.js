import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';

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

import { notificationRouter } from './notifications/routes.js';

// Route modules are mounted here in later steps (auth, projects, handoffs, ...).
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
