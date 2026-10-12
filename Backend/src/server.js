import { app } from './app.js';
import { config } from './config.js';
import { connectDB } from './db.js';

async function start() {
  console.log('[server] Connecting to MongoDB...');
  const conn = await connectDB();
  const dbName = conn?.name || conn?.connection?.name || 'database';
  console.log(`[server] Successfully connected to MongoDB (${dbName})`);
  app.listen(config.port, () => {
    console.log(`Relay backend listening on http://localhost:${config.port}`);
  });

  try {
    const redirectUrl = new URL(process.env.JIRA_REDIRECT_URI || '');
    const redirectPort = Number(redirectUrl.port);
    if (redirectPort && redirectPort !== config.port) {
      app.listen(redirectPort, () => {
        console.log(`[server] Also listening on http://localhost:${redirectPort} for Jira OAuth callback`);
      });
    }
  } catch {}
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
