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
  port: Number(process.env.PORT) || 8000,
  mongodbUri: process.env.MONGODB_URI,
  mongodbUriTest: process.env.MONGODB_URI_TEST || '',
  jwtSecret: process.env.JWT_SECRET,
  cronSecret: process.env.CRON_SECRET,
  frontendUrl: process.env.FRONTEND_URL || '',
  apiBaseUrl: process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 8000}`,
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
  slackApp: {
    clientId: process.env.SLACK_CLIENT_ID || '',
    clientSecret: process.env.SLACK_CLIENT_SECRET || '',
    redirectUri: process.env.SLACK_REDIRECT_URI || `${process.env.API_BASE_URL || 'http://localhost:8000'}/api/connections/slack/callback`,
    scopes: process.env.SLACK_SCOPES || 'channels:read,channels:history,groups:read,groups:history',
    enabled: Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
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
    // The App's own OAuth client ("Request user authorization during installation"),
    // used to prove the installing user can access the installation. Secret.
    clientId: process.env.GITHUB_APP_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET || '',
    enabled: Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY),
    // Webhook signing secret (GitHub App settings). Webhook processing stays disabled without it.
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
    // Per-repository limits for one sync run (hard-capped by the ingestion service).
    // Repository content analysis budget (per analysis run).
    analysis: {
      maxFiles: Number(process.env.GITHUB_ANALYSIS_MAX_FILES) || 150,
      maxFileBytes: Number(process.env.GITHUB_ANALYSIS_MAX_FILE_BYTES) || 100_000,
      maxTotalBytes: Number(process.env.GITHUB_ANALYSIS_MAX_TOTAL_BYTES) || 3_000_000,
      maxFileChars: Number(process.env.GITHUB_ANALYSIS_MAX_FILE_CHARS) || 40_000,
      concurrency: Number(process.env.GITHUB_ANALYSIS_CONCURRENCY) || 5,
    },
    sync: {
      issues: Number(process.env.GITHUB_SYNC_ISSUE_LIMIT) || 200,
      pullRequests: Number(process.env.GITHUB_SYNC_PR_LIMIT) || 200,
      commits: Number(process.env.GITHUB_SYNC_COMMIT_LIMIT) || 50,
    },
  },
  // Developer-handoff prompt budget in characters (~3 chars/token). The default fits Groq's free-tier
  // 8,000 tokens-per-minute limit; raise it when the configured model/tier allows larger requests.
  ai: { handoffContextChars: Number(process.env.AI_HANDOFF_CONTEXT_CHARS) || 14000 },
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
