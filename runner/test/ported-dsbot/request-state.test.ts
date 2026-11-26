import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keepResult } from '../../src/bots/handoff-result.ts';
import { RequestStateStore } from '../../src/bots/request-state.ts';

test('a result stays returning after a restart and can only use its original delivery', t => {
  const root = mkdtempSync(join(tmpdir(), 'tb-request-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const protect = () => {};
  const store = new RequestStateStore(root, protect);
  const first = store.admit({
    id: 'request', sourceBotId: 'chief', targetBotId: 'writer',
    sourceThreadId: 'source', sourceConversationId: 'conversation-a', targetThreadId: 'target',
    targetConversationId: 'conversation-b', acceptedAt: '2026-11-26T00:00:00.000Z', when: 'queue',
  });
  const queued = store.advance(first.id, first.revision, { status: 'queued', turnId: 'turn1' });
  const result = keepResult({ threadId: 'target', seq: 20 }, 'Full answer');
  const waiting = store.advance(first.id, queued.revision, { status: 'returning', turnId: 'turn1', result, replyId: 'bot-reply:request' });
  const restarted = new RequestStateStore(root, protect);
  assert.deepEqual(restarted.get(first.id), waiting);
  assert.throws(() => restarted.advance(first.id, waiting.revision, { status: 'returned', turnId: 'turn1', result, replyId: 'different-delivery' }), /does not match/);
  const returned = restarted.advance(first.id, waiting.revision, { status: 'returned', turnId: 'turn1', result, replyId: 'bot-reply:request' });
  assert.equal(returned.state.status, 'returned');
  assert.throws(() => restarted.advance(first.id, waiting.revision, { status: 'cancelled', reason: 'stale' }), /request changed/);
  assert.throws(() => restarted.advance(first.id, returned.revision, { status: 'queued', turnId: 'turn2' }), /cannot enter/);
});
