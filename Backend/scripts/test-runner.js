import { MongoMemoryServer } from 'mongodb-memory-server';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');

const TEST_DB = 'relay_backend_test';

let server;
try {
  server = await MongoMemoryServer.create({
    instance: { dbName: TEST_DB },
  });
} catch (err) {
  console.error(`Failed to start disposable MongoDB for tests: ${err.message}`);
  process.exit(1);
}

const uri = server.getUri(TEST_DB);

const env = {
  ...process.env,
  MONGODB_URI: uri,
  MONGODB_URI_TEST: uri,
  NODE_ENV: 'test',
  JWT_SECRET: process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-characters-long',
  CRON_SECRET: process.env.CRON_SECRET || 'test-cron-secret',
};

const userArgs = process.argv.slice(2);
const hasConcurrency = userArgs.some((a) => a.startsWith('--test-concurrency'));
const testArgs = hasConcurrency ? userArgs : ['--test-concurrency=1', ...userArgs];

const proc = spawn('node', ['--test', ...testArgs], {
  cwd: backendDir,
  env,
  stdio: 'inherit',
});

let cleanedUp = false;
async function cleanup(exitCode = 0) {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    if (server) await server.stop({ doCleanup: true, force: true });
  } catch {}
  process.exit(exitCode);
}

proc.on('close', (code) => cleanup(code ?? 0));
process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));
