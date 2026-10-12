/**
 * Agora Real-Time Communication API Routes
 * 
 * Provides endpoints for obtaining RTC/RTM tokens and initiating audio/video/chat sessions.
 */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import {
  generateRtcToken,
  generateRtmToken,
  AgoraServiceError,
} from '../services/agoraTokenService.js';
import { emitNotificationEvent } from '../notifications/emitEvent.js';

export const agoraRouter = express.Router();

/**
 * Public configuration endpoint for Frontend to discover Agora App ID.
 * Never exposes the App Certificate secret.
 */
agoraRouter.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      appId: config.agora.appId || '',
      enabled: config.agora.enabled,
    },
  });
});

/**
 * Authenticated endpoint to mint Agora RTC & RTM tokens for the current user.
 * 
 * POST /api/agora/token
 * Body: { channelName: string, callType?: 'audio' | 'video' | 'chat', role?: 'publisher' | 'subscriber' }
 */
agoraRouter.post('/token', requireAuth, (req, res) => {
  try {
    const { channelName, callType = 'video', role = 'publisher' } = req.body || {};

    if (!channelName || typeof channelName !== 'string' || channelName.trim().length === 0) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'channelName is required and must be a non-empty string.',
      });
    }

    const userId = String(req.user.id || req.user._id || 'user_guest');

    // Generate RTC token for Audio/Video
    const rtc = generateRtcToken({
      channelName: channelName.trim(),
      uid: userId,
      role,
    });

    // Generate RTM token for Real-Time Text Chat
    const rtm = generateRtmToken({
      userId,
    });

    res.json({
      success: true,
      data: {
        appId: config.agora.appId,
        channelName: channelName.trim(),
        callType,
        uid: userId,
        rtcToken: rtc.token,
        rtmToken: rtm.token,
        expiresAt: rtc.expiresAt,
      },
    });
  } catch (err) {
    if (err instanceof AgoraServiceError) {
      const status = err.code === 'AGORA_NOT_CONFIGURED' ? 503 : 400;
      return res.status(status).json({
        error: err.code.toLowerCase(),
        message: err.message,
      });
    }

    console.error('Failed generating Agora token:', err);
    res.status(500).json({
      error: 'token_generation_failed',
      message: 'Failed to generate Agora token.',
    });
  }
});

/**
 * Authenticated endpoint to dispatch a call invitation notification to a recipient.
 * 
 * POST /api/agora/invite
 * Body: { recipientUserId: string, channelName: string, callType: 'audio' | 'video', projectId?: string }
 */
agoraRouter.post('/invite', requireAuth, async (req, res) => {
  try {
    const { recipientUserId, channelName, callType = 'video', projectId = 'general' } = req.body || {};

    if (!recipientUserId || !channelName) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'recipientUserId and channelName are required.',
      });
    }

    const callerName = req.user.name || req.user.email || req.user.id;

    // Emit event so the in-app notification system alerts the recipient
    try {
      await emitNotificationEvent({
        type: 'HANDOFF_SUBMITTED', // Reuses notification dispatcher with call metadata
        projectId: String(projectId),
        recipientUserId: String(recipientUserId),
        dedupeKey: `call_${channelName}_${Date.now()}`,
        payload: {
          entityId: channelName,
          outgoingUserId: callerName,
          handoffTitle: `Incoming ${callType.toUpperCase()} Call from ${callerName}`,
        },
      });
    } catch (notifErr) {
      console.warn('Call invite notification dispatch failed:', notifErr.message);
    }

    res.json({
      success: true,
      message: 'Call invitation sent.',
      data: {
        channelName,
        recipientUserId,
        callType,
        callerId: req.user.id,
      },
    });
  } catch (err) {
    res.status(500).json({
      error: 'invite_failed',
      message: err.message,
    });
  }
});
