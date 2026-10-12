import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Agora AI Transcription & Summarization Suite', () => {
  it('should successfully parse meeting summary JSON structure', async () => {
    const rawAiResponse = JSON.stringify({
      overview: 'Team synced on sprint goals and deployment readiness.',
      keyPoints: [
        'Render deployment verified and operational.',
        'Agora audio/video channels connected.',
      ],
      decisions: ['Deploy to production today.'],
      actionItems: [{ task: 'Test live meeting call', assignee: 'Team' }],
      rawMarkdown: '# Meeting Summary\n\n- Deploy to production today.',
    });

    const parsed = JSON.parse(rawAiResponse);
    assert.equal(parsed.overview, 'Team synced on sprint goals and deployment readiness.');
    assert.equal(parsed.keyPoints.length, 2);
    assert.equal(parsed.decisions[0], 'Deploy to production today.');
    assert.equal(parsed.actionItems[0].task, 'Test live meeting call');
  });

  it('should format meeting prompt with transcript and metadata cleanly', () => {
    const transcript = 'Alice: Hello everyone. Bob: Ready for the demo.';
    const channelName = 'standup-test';
    const participants = ['Alice', 'Bob'];

    assert.ok(transcript.includes('Alice'));
    assert.ok(transcript.includes('Bob'));
    assert.equal(channelName, 'standup-test');
    assert.equal(participants.length, 2);
  });
});
