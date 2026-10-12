import { app } from './app.js';
import { config } from './config.js';
import { connectDB } from './db.js';

async function start() {
  await connectDB();
  app.listen(config.port, () => {
    console.log(`Relay backend listening on http://localhost:${config.port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
