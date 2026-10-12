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

import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max audio
});

/**
 * Transcribe meeting audio recording using Groq Whisper (whisper-large-v3).
 * Accepts multipart audio file or JSON with base64 audio.
 * POST /api/agora/transcribe
 */
agoraRouter.post('/transcribe', requireAuth, upload.single('audio'), async (req, res) => {
  try {
    const groqApiKey = config.groqApiKey || process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(503).json({
        error: 'groq_not_configured',
        message: 'Groq API key is not configured for Whisper transcription.',
      });
    }

    let audioBuffer;
    let fileName = 'recording.webm';
    let mimeType = 'audio/webm';

    if (req.file) {
      audioBuffer = req.file.buffer;
      fileName = req.file.originalname || 'recording.webm';
      mimeType = req.file.mimetype || 'audio/webm';
    } else if (req.body?.audioBase64) {
      audioBuffer = Buffer.from(req.body.audioBase64, 'base64');
      fileName = req.body.fileName || 'recording.webm';
      mimeType = req.body.mimeType || 'audio/webm';
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({
        error: 'missing_audio',
        message: 'No audio file or audioBase64 payload provided.',
      });
    }

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('file', blob, fileName);
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');
    if (req.body?.language) {
      formData.append('language', req.body.language);
    }

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: formData,
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text().catch(() => '');
      let parsedErr = errText;
      try { parsedErr = JSON.parse(errText); } catch {}
      console.error('[agora-whisper] Groq transcription error:', parsedErr);
      return res.status(groqRes.status).json({
        error: 'transcription_failed',
        message: parsedErr?.error?.message || 'Whisper transcription failed.',
      });
    }

    const result = await groqRes.json();
    return res.json({
      success: true,
      text: result.text || '',
      model: 'whisper-large-v3-turbo',
    });
  } catch (err) {
    console.error('[agora-whisper] Error:', err);
    return res.status(500).json({
      error: 'transcription_error',
      message: err.message || 'Internal error transcribing audio.',
    });
  }
});

/**
 * Generate meeting executive summary, key points, decisions, and action items
 * from call transcript using Groq.
 * POST /api/agora/summarize
 */
agoraRouter.post('/summarize', requireAuth, async (req, res) => {
  try {
    const groqApiKey = config.groqApiKey || process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(503).json({
        error: 'groq_not_configured',
        message: 'Groq API key is not configured for meeting summarization.',
      });
    }

    const { transcript, channelName, duration, participants } = req.body || {};
    if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
      return res.status(400).json({
        error: 'missing_transcript',
        message: 'Meeting transcript text is required to generate a summary.',
      });
    }

    const systemPrompt = `You are an executive meeting assistant and scribe for the Over2u continuity platform.
Analyze the following meeting transcript and produce a structured JSON summary with the following schema:
{
  "overview": "A clear, professional 2-3 sentence overview of the meeting purpose and outcomes.",
  "keyPoints": ["Bullet point 1", "Bullet point 2", ...],
  "decisions": ["Confirmed decision 1", ...],
  "actionItems": [
    { "task": "Actionable task title", "assignee": "Person responsible or Unassigned" }
  ],
  "rawMarkdown": "Formatted markdown report with headers, bullet points, and task lists ready to paste."
}
Be concise, actionable, and strictly adhere to the facts mentioned in the transcript.`;

    const userPrompt = `Meeting Details:
- Channel / Topic: ${channelName || 'General Call'}
- Duration: ${duration || 'N/A'}
- Participants: ${Array.isArray(participants) ? participants.join(', ') : (participants || 'Team')}

Transcript:
"""
${transcript.trim().slice(0, 40000)}
"""`;

    // Try qwen/qwen3.8-27b, fallback to openai/gpt-oss-120b
    const modelsToTry = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'];
    let lastError = null;
    let summaryData = null;

    for (const model of modelsToTry) {
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${groqApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            response_format: { type: 'json_object' },
            temperature: 0.2,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
        });

        if (!groqRes.ok) {
          const errData = await groqRes.text().catch(() => '');
          lastError = new Error(`Groq HTTP ${groqRes.status}: ${errData}`);
          continue;
        }

        const data = await groqRes.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          summaryData = JSON.parse(content);
          break;
        }
      } catch (tryErr) {
        lastError = tryErr;
      }
    }

    if (!summaryData) {
      console.error('[agora-summarize] Failed across models:', lastError);
      return res.status(502).json({
        error: 'summary_generation_failed',
        message: lastError?.message || 'Could not generate meeting summary.',
      });
    }

    return res.json({
      success: true,
      data: {
        channelName: channelName || 'Meeting',
        generatedAt: new Date().toISOString(),
        overview: summaryData.overview || 'Meeting completed.',
        keyPoints: Array.isArray(summaryData.keyPoints) ? summaryData.keyPoints : [],
        decisions: Array.isArray(summaryData.decisions) ? summaryData.decisions : [],
        actionItems: Array.isArray(summaryData.actionItems) ? summaryData.actionItems : [],
        rawMarkdown: summaryData.rawMarkdown || '',
      },
    });
  } catch (err) {
    console.error('[agora-summarize] Error:', err);
    return res.status(500).json({
      error: 'internal_error',
      message: err.message || 'Failed to process summary.',
    });
  }
});

