import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestEvidence } from '../../src/bots/request-events.ts';

test('a steered request never uses the recipient reply that preceded its authenticated input', () => {
  const envelope = { threadId: 'receiver', ts: '2026-11-26T00:00:00Z', turnId: 'recipient' };
  const input = { ...envelope, text: 'Input', images: [], type: 'user.message' as const, seq: 12, botInput: { id: 'input', conversationId: 'conversation', source: { kind: 'owner' as const }, request: { id: 'ask', role: 'request' as const } } };
  const early = { ...envelope, itemId: 'item', type: 'assistant.text', seq: 10, text: 'Earlier answer' } as const;
  const done = { ...envelope, durationMs: 0, type: 'turn.completed', seq: 16, outcome: 'completed' } as const;
  assert.equal(requestEvidence([early, input, done], 'ask').kind, 'failed');
  assert.equal(requestEvidence([early, input], 'ask', 'recipient').kind, 'running');
  assert.equal(requestEvidence([early, input], 'ask').kind, 'unknown');
  assert.deepEqual(requestEvidence([
    early, input, { ...early, seq: 14, text: 'Reply to the request', final: true },
    { ...early, seq: 15, text: 'Short transcript summary', summary: true }, done,
  ], 'ask'), { kind: 'complete', turnId: 'recipient', seq: 14, text: 'Reply to the request' });
});
