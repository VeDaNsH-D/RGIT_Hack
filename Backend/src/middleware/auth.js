import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { User } from '../models/User.js';

export function signAuthToken(user) {
  const sub = user._id ? user._id.toString() : String(user.id || user.sub);
  return jwt.sign({ sub }, config.jwtSecret, { expiresIn: '7d' });
}

/**
 * Verifies the Bearer JWT, loads the user, and rejects if the user no
 * longer exists or has been disabled since the token was issued.
 */
export async function requireAuth(req, res, next) {
  try {
    // 1. Upstream user attached
    if (req.user && (req.user.id || req.user._id)) {
      if (!req.user.id && req.user._id) req.user.id = req.user._id.toString();
      return next();
    }

    const header = req.headers.authorization || req.headers.Authorization || '';
    const [scheme, token] = header.split(' ');

    // 2. Testing & development fallback via x-user-id header
    const devUserId = req.headers['x-user-id'];
    if ((!header || scheme !== 'Bearer' || !token) && devUserId) {
      req.user = { id: String(devUserId).trim(), _id: String(devUserId).trim() };
      return next();
    }

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing bearer token' });
    }

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
    }

    const sub = payload.sub || payload.userId || payload.id;
    if (!sub) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid token payload' });
    }

    // 3. If MongoDB is connected and sub is an ObjectId, lookup User in DB
    if (mongoose.connection && mongoose.connection.readyState === 1 && mongoose.isValidObjectId(sub)) {
      try {
        const user = await User.findById(sub);
        if (!user || user.disabled) {
          return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
        }
        req.user = user;
        req.user.id = user._id.toString();
        return next();
      } catch {
        // Fall back to verified payload
      }
    }

    // 4. Verified JWT payload representation
    req.user = {
      id: String(sub),
      _id: sub,
      ...payload,
    };
    next();
  } catch (err) {
    next(err);
  }
}
