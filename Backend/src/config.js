import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

/**
 * Reads and validates process.env once at module load, failing fast so a
 * misconfigured deployment never silently serves with missing secrets.
 */

const required = ['MONGODB_URI', 'JWT_SECRET', 'CRON_SECRET'];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

if (process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long');
}

function parseOrigins() {
  const origins = new Set();
  if (process.env.FRONTEND_URL) origins.add(process.env.FRONTEND_URL);
  for (const origin of (process.env.CORS_ORIGINS || '').split(',')) {
    const trimmed = origin.trim();
    if (trimmed) origins.add(trimmed);
  }
  return [...origins];
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  mongodbUri: process.env.MONGODB_URI,
  mongodbUriTest: process.env.MONGODB_URI_TEST || '',
  jwtSecret: process.env.JWT_SECRET,
  cronSecret: process.env.CRON_SECRET,
  frontendUrl: process.env.FRONTEND_URL || '',
  apiBaseUrl: process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}`,
  corsOrigins: parseOrigins(),
  ackSlaHours: Number(process.env.ACK_SLA_HOURS) || 48,
  oauth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      enabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      enabled: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    },
  },
  // GitHub App repository integration. Values are validated lazily by
  // src/modules/ingestion/providers/github/githubAppAuth.js so a missing or
  // malformed key disables GitHub ingestion without blocking server startup.
  // privateKey is a secret: never log it or expose it to clients.
  githubApp: {
    appId: process.env.GITHUB_APP_ID || '',
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY || '',
    appSlug: process.env.GITHUB_APP_SLUG || '',
    // Optional default installation (e.g. for the smoke test / demo); not a secret.
    installationId: process.env.GITHUB_APP_INSTALLATION_ID || '',
    enabled: Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY),
  },
  // Document uploads (src/modules/ingestion/documents). The local storage
  // directory is NOT durable on Vercel or multi-instance deployments.
  documents: {
    maxBytes: Number(process.env.DOCUMENT_MAX_BYTES) || 10 * 1024 * 1024,
    storageDir: process.env.DOCUMENT_STORAGE_DIR || '',
  },
  // WhatsApp Web Selenium delivery adapter (optional, disabled by default)
  whatsappWeb: {
    enabled: process.env.WHATSAPP_WEB_ENABLED === 'true',
    browser: process.env.WHATSAPP_WEB_BROWSER || 'chrome',
    profileDir: process.env.WHATSAPP_WEB_PROFILE_DIR || '.whatsapp-sessions',
    headless: process.env.WHATSAPP_WEB_HEADLESS === 'true',
    navigationTimeoutMs: Number(process.env.WHATSAPP_WEB_NAVIGATION_TIMEOUT_MS) || 30000,
    actionTimeoutMs: Number(process.env.WHATSAPP_WEB_ACTION_TIMEOUT_MS) || 15000,
    defaultPhone: process.env.WHATSAPP_WEB_DEFAULT_PHONE || '+919021875564',
  },
  // Agora Real-Time Communication (Audio, Video, Chat)
  agora: {
    appId: process.env.AGORA_APP_ID || '',
    appCertificate: process.env.AGORA_APP_CERTIFICATE || '',
    enabled: Boolean(process.env.AGORA_APP_ID && process.env.AGORA_APP_CERTIFICATE),
  },
};
