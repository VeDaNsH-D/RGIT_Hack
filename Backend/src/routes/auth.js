import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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
// Stateless flow: the "state" param is itself a short-lived signed JWT
// (not a server-side session), so it survives across serverless cold
// starts. It's bound to the provider name so a state minted for one
// provider can't be replayed against another.

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

  const state = jwt.sign({ provider: req.params.provider }, config.jwtSecret, { expiresIn: '5m' });
  res.redirect(provider.authorizeUrl(state));
});

router.get('/oauth/:provider/callback', async (req, res, next) => {
  try {
    const provider = getProvider(req, res);
    if (!provider) return;

    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).json({ error: 'validation_error', message: 'Missing code or state' });
    }

    let statePayload;
    try {
      statePayload = jwt.verify(state, config.jwtSecret);
    } catch {
      return res.status(401).json({ error: 'invalid_state', message: 'Invalid or expired OAuth state' });
    }
    if (statePayload.provider !== req.params.provider) {
      return res.status(401).json({ error: 'invalid_state', message: 'OAuth state does not match provider' });
    }

    const profile = await provider.exchangeCode(code);
    if (!profile.email || !profile.emailVerified) {
      return res
        .status(401)
        .json({ error: 'unverified_email', message: 'OAuth provider did not return a verified email' });
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
      return res.status(401).json({ error: 'account_disabled', message: 'This account is disabled' });
    }

    await recordSuccessfulLogin(user, req.params.provider);
    const token = signAuthToken(user);

    if (!config.frontendUrl) {
      return res.json({ token, user: serializeUser(user) });
    }
    const redirectUrl = new URL(config.frontendUrl);
    redirectUrl.searchParams.set('token', token);
    res.redirect(redirectUrl.toString());
  } catch (err) {
    next(err);
  }
});

export default router;
