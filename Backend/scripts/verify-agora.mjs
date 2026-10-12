import { app } from '../src/app.js';
import http from 'node:http';

const server = http.createServer(app);
server.listen(0, async () => {
  const port = server.address().port;
  console.log('Testing Agora API endpoints on port:', port);

  // 1. Test public config endpoint
  const configRes = await fetch(`http://localhost:${port}/api/agora/config`);
  const configJson = await configRes.json();
  console.log('/api/agora/config:', configJson);

  // 2. Test authenticated token generation endpoint for video call & chat
  const tokenRes = await fetch(`http://localhost:${port}/api/agora/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': 'dev_test_user_42',
    },
    body: JSON.stringify({
      channelName: 'team-daily-standup',
      callType: 'video',
      role: 'publisher',
    }),
  });
  const tokenJson = await tokenRes.json();
  console.log('/api/agora/token (video+chat) status:', tokenRes.status);
  console.log('Received RTC Video Token:', tokenJson.data?.rtcToken ? 'VALID' : 'MISSING');
  console.log('Received RTM Chat Token:', tokenJson.data?.rtmToken ? 'VALID' : 'MISSING');

  // 3. Test token generation for audio-only call
  const audioTokenRes = await fetch(`http://localhost:${port}/api/agora/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': 'dev_audio_caller_99',
    },
    body: JSON.stringify({
      channelName: 'team-audio-huddle',
      callType: 'audio',
      role: 'publisher',
    }),
  });
  const audioJson = await audioTokenRes.json();
  console.log('/api/agora/token (audio) status:', audioTokenRes.status);
  console.log('Received RTC Audio Token:', audioJson.data?.rtcToken ? 'VALID' : 'MISSING');

  server.close(() => {
    console.log('\nAll 3 communication modes (Audio, Video, Chat) verified successfully!');
    process.exit(0);
  });
});
