/**
 * Agora Token Generation Service
 * 
 * Provides cryptographically signed, bounded RTC (Audio/Video) and RTM (Real-Time Chat)
 * tokens using the official Agora SDK.
 */

import agoraPkg from 'agora-token';
import { config } from '../config.js';

const { RtcTokenBuilder, RtcRole, RtmTokenBuilder } = agoraPkg;

export class AgoraServiceError extends Error {
  constructor(message, code = 'AGORA_ERROR') {
    super(message);
    this.name = 'AgoraServiceError';
    this.code = code;
  }
}

/**
 * Validates that Agora credentials are configured.
 */
export function assertAgoraConfigured() {
  const { appId, appCertificate } = config.agora || {};
  if (!appId || !appCertificate) {
    throw new AgoraServiceError(
      'Agora real-time service is not configured. Missing AGORA_APP_ID or AGORA_APP_CERTIFICATE.',
      'AGORA_NOT_CONFIGURED'
    );
  }
}

/**
 * Generates an RTC token for audio/video calling.
 * 
 * @param {object} params
 * @param {string} params.channelName Name of the call channel
 * @param {string|number} [params.uid=0] User identifier (numeric UID or string account)
 * @param {'publisher'|'subscriber'} [params.role='publisher']
 * @param {number} [params.expireSeconds=3600]
 * @returns {{ token: string, appId: string, channelName: string, uid: string|number, expiresAt: number }}
 */
export function generateRtcToken({
  channelName,
  uid = 0,
  role = 'publisher',
  expireSeconds = 3600,
} = {}) {
  assertAgoraConfigured();

  if (!channelName || typeof channelName !== 'string' || channelName.trim().length === 0) {
    throw new AgoraServiceError('channelName must be a non-empty string.', 'INVALID_CHANNEL_NAME');
  }

  const { appId, appCertificate } = config.agora;
  const ttl = Math.max(60, expireSeconds);
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpireTime = currentTimestamp + ttl;
  const rtcRole = role === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;

  let token;
  const numericUid = Number(uid);

  // If uid is a positive integer, generate UID-based token; otherwise generate user account token
  if (!Number.isNaN(numericUid) && Number.isInteger(numericUid) && numericUid > 0) {
    token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName.trim(),
      numericUid,
      rtcRole,
      ttl,
      ttl
    );
  } else {
    const userAccount = String(uid || 'user_guest');
    token = RtcTokenBuilder.buildTokenWithUserAccount(
      appId,
      appCertificate,
      channelName.trim(),
      userAccount,
      rtcRole,
      ttl,
      ttl
    );
  }

  return {
    token,
    appId,
    channelName: channelName.trim(),
    uid,
    expiresAt: privilegeExpireTime,
  };
}

/**
 * Generates an RTM token for real-time text chat and signaling.
 * 
 * @param {object} params
 * @param {string} params.userId User identifier string
 * @param {number} [params.expireSeconds=3600]
 * @returns {{ token: string, appId: string, userId: string, expiresAt: number }}
 */
export function generateRtmToken({
  userId,
  expireSeconds = 3600,
} = {}) {
  assertAgoraConfigured();

  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new AgoraServiceError('userId must be a non-empty string for RTM token.', 'INVALID_USER_ID');
  }

  const { appId, appCertificate } = config.agora;
  const ttl = Math.max(60, expireSeconds);
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpireTime = currentTimestamp + ttl;

  let token;
  if (typeof RtmTokenBuilder.buildTokenWithPermissions === 'function') {
    // Generate Agora RTM 2.x AccessToken2
    token = RtmTokenBuilder.buildTokenWithPermissions(
      appId,
      appCertificate,
      userId.trim(),
      undefined,
      ttl
    );
  } else {
    token = RtmTokenBuilder.buildToken(
      appId,
      appCertificate,
      userId.trim(),
      privilegeExpireTime
    );
  }

  return {
    token,
    appId,
    userId: userId.trim(),
    expiresAt: privilegeExpireTime,
  };
}

