import 'dotenv/config';

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
};
