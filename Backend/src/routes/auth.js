import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { registerSchema, loginSchema } from '../contracts/schemas.js';
import { User } from '../models/User.js';
import { signAuthToken, requireAuth } from '../middleware/auth.js';
import { logActivity } from '../audit/service.js';
import { config } from '../config.js';
import { oauthProviders } from '../auth/oauthProviders.js';

const router = Router();

// In-memory (per-instance) limiter, as noted in the README's known
// limitations: on serverless this resets per cold start / isn't shared
// across instances. Good enough to blunt naive credential-stuffing for a
// hackathon prototype.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many login attempts, please try again later' },
});

function serializeUser(user, { includeLastLogin = false } = {}) {
  const out = { id: String(user._id), email: user.email, name: user.name };
  if (includeLastLogin) out.lastLoginAt = user.lastLoginAt || null;
  return out;
}

/**
 * Records a successful login: updates lastLoginAt and writes a
 * USER_LOGIN audit event on the system chain. Used by password login now;
 * OAuth login (when implemented) should call this with method
 * 'google'|'github'. A failure to persist lastLoginAt must never block
 * the login itself.
 */
export async function recordSuccessfulLogin(user, method) {
  try {
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  } catch (err) {
    console.error('[auth] failed to update lastLoginAt:', err);
  }
  await logActivity({
    projectId: null,
    actorId: user._id,
    actorType: 'user',
    action: 'USER_LOGIN',
    targetType: 'User',
    targetId: user._id,
    payload: { method },
  });
}

router.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const existing = await User.findOne({ email: body.email });
    if (existing) {
      return res.status(409).json({ error: 'email_taken', message: 'An account with this email already exists' });
    }
    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await User.create({ email: body.email, name: body.name, passwordHash });
    const token = signAuthToken(user);
    res.status(201).json({ token, user: serializeUser(user) });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    next(err);
  }
});

router.post('/login', loginRateLimiter, async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const user = await User.findOne({ email: body.email }).select('+passwordHash');

    const invalidCredentials = () =>
      res.status(401).json({ error: 'invalid_credentials', message: 'Invalid email or password' });

    if (!user || !user.passwordHash || user.disabled) return invalidCredentials();

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) return invalidCredentials();

    await recordSuccessfulLogin(user, 'password');

    const token = signAuthToken(user);
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: serializeUser(req.user, { includeLastLogin: true }) });
});

// --- OAuth (Google / GitHub) --------------------------------------------
//
// Signed state is bound to a short-lived browser cookie and the provider.
// No server-side OAuth session is needed across serverless cold starts.
const oauthCookie = 'relay_oauth_nonce';
function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: config.apiBaseUrl.startsWith('https://'), path: '/api/auth/oauth' };
}
function frontendCallback() {
  return config.frontendUrl ? new URL('/auth/callback', config.frontendUrl) : null;
}
function oauthError(res, status, error, message) {
  const redirect = frontendCallback();
  res.set('Cache-Control', 'no-store');
  if (redirect) {
    redirect.searchParams.set('error', error);
    return res.redirect(redirect.toString());
  }
  return res.status(status).json({ error, message });
}

router.get('/oauth/providers', (req, res) => {
  res.json({ providers: { google: oauthProviders.google.enabled(), github: oauthProviders.github.enabled() } });
});

function getProvider(req, res) {
  const provider = oauthProviders[req.params.provider];
  if (!provider || !provider.enabled()) {
    res.status(404).json({ error: 'not_found', message: 'Unknown or disabled OAuth provider' });
    return null;
  }
  return provider;
}

router.get('/oauth/:provider', (req, res) => {
  const provider = getProvider(req, res);
  if (!provider) return;

  const nonce = randomBytes(32).toString('base64url');
  const state = jwt.sign({ provider: req.params.provider, nonce }, config.jwtSecret, { expiresIn: '5m' });
  res.cookie(oauthCookie, nonce, { ...cookieOptions(), maxAge: 5 * 60 * 1000 });
  res.set('Cache-Control', 'no-store');
  res.redirect(provider.authorizeUrl(state));
});

router.get('/oauth/:provider/callback', async (req, res, next) => {
  try {
    const provider = getProvider(req, res);
    if (!provider) return;

    const { code, state } = req.query;
    if (typeof state !== 'string' || (!req.query.error && typeof code !== 'string')) {
      return oauthError(res, 400, 'validation_error', 'Missing code or state');
    }

    let statePayload;
    try {
      statePayload = jwt.verify(state, config.jwtSecret);
    } catch {
      return oauthError(res, 401, 'invalid_state', 'Invalid or expired OAuth state');
    }
    const nonce = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${oauthCookie}=`))?.slice(oauthCookie.length + 1);
    if (statePayload.provider !== req.params.provider || typeof statePayload.nonce !== 'string' || !nonce || Buffer.byteLength(nonce) !== Buffer.byteLength(statePayload.nonce) || !timingSafeEqual(Buffer.from(nonce), Buffer.from(statePayload.nonce))) {
      return oauthError(res, 401, 'invalid_state', 'OAuth state does not match this browser');
    }
    res.clearCookie(oauthCookie, cookieOptions());
    if (req.query.error) return oauthError(res, 400, 'access_denied', 'Sign-in was cancelled');

    const profile = await provider.exchangeCode(code);
    if (!profile.email || !profile.emailVerified) {
      return oauthError(res, 401, 'unverified_email', 'OAuth provider did not return a verified email');
    }

    const providerIdField = req.params.provider === 'google' ? 'googleId' : 'githubId';

    let user = await User.findOne({ [providerIdField]: profile.providerId });
    if (!user) {
      user = await User.findOne({ email: profile.email });
      if (user) {
        user[providerIdField] = profile.providerId;
        await user.save();
      } else {
        user = await User.create({
          email: profile.email,
          name: profile.name,
          [providerIdField]: profile.providerId,
        });
      }
    }

    if (user.disabled) {
      return oauthError(res, 401, 'account_disabled', 'This account is disabled');
    }

    await recordSuccessfulLogin(user, req.params.provider);
    const token = signAuthToken(user);

    if (!config.frontendUrl) {
      return res.json({ token, user: serializeUser(user) });
    }
    const redirectUrl = frontendCallback();
    redirectUrl.hash = new URLSearchParams({ token }).toString();
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.redirect(redirectUrl.toString());
  } catch (err) {
    if (config.frontendUrl) return oauthError(res, 502, 'oauth_failed', 'Could not complete sign-in');
    next(err);
  }
});

export default router;
