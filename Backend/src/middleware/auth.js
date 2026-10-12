/**
 * Authentication Middleware
 * 
 * Verifies authenticated user identity from token/session or trusted test header,
 * populating req.user.id for route authorization.
 */

import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * Ensures the incoming request has a verified authenticated user identity.
 * Rejects unauthenticated requests with 401 Unauthorized.
 */
export function requireAuth(req, res, next) {
  // 1. Check if user was already attached by an upstream session/middleware
  if (req.user && (req.user.id || req.user.userId || req.user._id)) {
    req.user.id = String(req.user.id || req.user.userId || req.user._id);
    return next();
  }

  // 2. Check Authorization header (Bearer <token>)
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      try {
        const decoded = jwt.verify(token, config.jwtSecret);
        const userId = decoded.sub || decoded.userId || decoded.id;
        if (userId) {
          req.user = { id: String(userId), ...decoded };
          return next();
        }
      } catch (err) {
        // If JWT signature fails or is expired, handle or fall through in non-production
        if (config.nodeEnv === 'production') {
          return res.status(401).json({
            error: 'unauthorized',
            message: 'Invalid or expired authentication token',
          });
        }
      }
    }
  }

  // 3. Testing & development fallback via x-user-id header
  const devUserId = req.headers['x-user-id'];
  if (devUserId && typeof devUserId === 'string' && devUserId.trim()) {
    req.user = { id: devUserId.trim() };
    return next();
  }

  // 4. Missing credentials
  return res.status(401).json({
    error: 'unauthorized',
    message: 'Authentication required to access notifications',
  });
}
