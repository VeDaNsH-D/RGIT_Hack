import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/User.js';

export function signAuthToken(user) {
  return jwt.sign({ sub: user._id.toString() }, config.jwtSecret, { expiresIn: '7d' });
}

/**
 * Verifies the Bearer JWT, loads the user, and rejects if the user no
 * longer exists or has been disabled since the token was issued.
 */
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing bearer token' });
    }

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
    }

    const user = await User.findById(payload.sub);
    if (!user || user.disabled) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
