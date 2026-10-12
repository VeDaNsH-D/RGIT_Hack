import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { registerSchema, loginSchema } from '../contracts/schemas.js';
import { User } from '../models/User.js';
import { signAuthToken, requireAuth } from '../middleware/auth.js';
import { logActivity } from '../audit/service.js';

const router = Router();

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

router.post('/login', async (req, res, next) => {
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

export default router;
