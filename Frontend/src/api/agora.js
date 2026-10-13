import { request } from './client';
import { readSession } from '../auth/session';

const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

/**
 * Retrieves public Agora configuration (App ID).
 */
export async function fetchAgoraConfig(signal) {
  return request('/agora/config', { signal });
}

/**
 * Retrieves Deepgram configuration/key from backend for live streaming transcription.
 */
export async function fetchDeepgramToken(signal) {
  return request('/agora/deepgram-token', { signal });
}

/**
 * Obtains authenticated RTC and RTM session tokens for an Agora call channel.
 *
 * @param {object} params
 * @param {string} params.channelName
 * @param {'video'|'audio'} [params.callType='video']
 * @param {'publisher'|'subscriber'} [params.role='publisher']
 */
export async function fetchAgoraToken({ channelName, callType = 'video', role = 'publisher' }, signal) {
  return request('/agora/token', {
    method: 'POST',
    body: { channelName, callType, role },
    signal,
  });
}

/**
 * Uploads an audio blob to Groq Whisper for Speech-to-Text transcription.
 *
 * @param {Blob} audioBlob
 * @param {string} [language='en']
 * @returns {Promise<{ success: boolean, text: string }>}
 */
export async function transcribeAudio(audioBlob, language = 'en') {
  const token = readSession()?.token;
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  if (language) formData.append('language', language);

  const res = await fetch(`${base}/agora/transcribe`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || `Transcription failed with HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Dispatches call transcript to Groq LLM to generate an executive meeting summary,
 * key points, decisions, and action items.
 *
 * @param {object} payload
 * @param {string} payload.transcript
 * @param {string} [payload.channelName]
 * @param {string} [payload.duration]
 * @param {string[]} [payload.participants]
 */
export async function summarizeCall({ transcript, channelName, duration, participants }, signal) {
  return request('/agora/summarize', {
    method: 'POST',
    body: { transcript, channelName, duration, participants },
    signal,
  });
}

/**
 * Sends a call invitation notification to a teammate.
 */
export async function sendCallInvite({ recipientUserId, channelName, callType = 'video', projectId }, signal) {
  return request('/agora/invite', {
    method: 'POST',
    body: { recipientUserId, channelName, callType, projectId },
    signal,
  });
}
