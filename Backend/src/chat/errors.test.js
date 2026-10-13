import test from 'node:test';
import assert from 'node:assert/strict';
import { describeChatFailure } from './errors.js';
test('known service errors are actionable and upstream content is never forwarded', () => {
  assert.equal(describeChatFailure(503, { detail: { code: 'rag_key_missing' } }).status, 503);
  assert.equal(describeChatFailure(429, { detail: { code: 'groq_rate_limited' } }).status, 429);
  assert.equal(describeChatFailure(404, {}).error, 'chat_not_deployed');
  assert.doesNotMatch(JSON.stringify(describeChatFailure(502, { detail: 'secret upstream response' })), /secret upstream/);
});
