import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotRequestReturn } from '../../src/bots/request-return.ts';
import { RequestStateStore } from '../../src/bots/request-state.ts';

test('a completed Bot request recovers the original reply after acceptance and avoids a duplicate', t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-return-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = new RequestStateStore(root, () => {});
  requests.admit({
    id: 'request', sourceBotId: 'caller', sourceThreadId: 'original', sourceConversationId: 'pinned',
    targetBotId: 'recipient', targetThreadId: 'receiver', targetConversationId: 'selected', when: 'queue', acceptedAt: new Date(0).toISOString(),
  });
  const text = '日本語の返事。'.repeat(600);
  const replies = new Map<string, string>();
  const ports: ConstructorParameters<typeof BotRequestReturn>[0] = {
    requests,
    inspectInput: () => ({ kind: 'complete', turnId: 'finished', text, seq: 10 }),
    inspectReply: (_row, replyId) => replies.has(replyId) ? 'queued' : 'missing',
    deliverReply: (row, replyId, body) => {
      assert.equal(row.sourceThreadId, 'original');
      assert.equal(row.sourceConversationId, 'pinned');
      replies.set(replyId, body);
      throw new Error('interrupted after recipient saved the reply');
    },
    waitingParent: () => false,
    readResult: source => source.threadId === 'receiver' && source.seq === 10 ? text : undefined,
    removeQueuedInput: () => { throw new Error('should not cancel'); },
  };
  assert.throws(() => new BotRequestReturn(ports).settle('request'), /after recipient saved/);
  const reloaded = new RequestStateStore(root, () => {});
  assert.equal(reloaded.get('request').state.status, 'returning');
  const service = new BotRequestReturn({ ...ports, requests: reloaded });
  assert.equal(service.settle('request', true).state.status, 'returned');
  assert.equal(service.settle('request', true).state.status, 'returned');
  assert.deepEqual([...replies.values()], [text]);
});

test('a failure shared by a steered turn keeps the two original request identities separate', t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-return-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = new RequestStateStore(root, () => {});
  for (const id of ['one', 'two', 'three', 'four']) {
    requests.admit({
      id, sourceBotId: 'caller', sourceThreadId: 'original', sourceConversationId: 'pinned',
      targetBotId: 'recipient', targetThreadId: 'receiver', targetConversationId: 'selected', when: 'now', acceptedAt: new Date(0).toISOString(),
    });
  }
  const ids: string[] = [];
  const service = new BotRequestReturn({
    requests,
    inspectInput: row => row.id === 'four' ? { kind: 'unknown' } : { kind: 'failed', seq: 10, turnId: 'same-turn', message: 'the turn stopped' },
    inspectReply: () => 'missing',
    deliverReply: (_row, replyId, text) => {
      assert.match(text, /the turn stopped/);
      ids.push(replyId);
    },
    waitingParent: () => false,
    readResult: () => undefined,
    removeQueuedInput: () => { throw new Error('disk full'); },
  });
  assert.equal(service.settle('one').state.status, 'returned');
  assert.equal(service.settle('two').state.status, 'returned');
  assert.throws(() => service.cancel('three', 1), /disk full/);
  assert.equal(service.settle('three', true).state.status, 'cancelled');
  assert.equal(service.settle('four', true).state.status, 'uncertain');
  assert.deepEqual(ids, ['bot-reply:one', 'bot-reply:two']);
});
