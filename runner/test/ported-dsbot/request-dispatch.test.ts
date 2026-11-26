import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotRequestDispatch } from '../../src/bots/request-dispatch.ts';
import { RequestReceipts } from '../../src/bots/request-receipts.ts';
import { RequestStateStore } from '../../src/bots/request-state.ts';

test('the chosen conversation is fixed by admission and an unsupported steer becomes queued', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tb-bot-dispatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const noop = () => {};
  const requests = new RequestStateStore(root, noop);
  const receipts = new RequestReceipts(root, () => true, noop, noop);
  const first = { botId: 'writer', threadId: 'writer-a', conversationId: 'conversation-a' };
  const second = { botId: 'writer', threadId: 'writer-b', conversationId: 'conversation-b' };
  let current = first;
  const received: string[] = [];
  const svc = new BotRequestDispatch({
    requests, receipts, canSteer: () => false, isoNow: () => '2026-11-26T00:00:00Z',
    target: (_bot, preferred) => preferred === first.conversationId ? first : preferred === second.conversationId ? second : current,
    dispatch: (row, text) => {
      assert.equal(requests.get(row.id).state.status, 'admitted');
      received.push(row.targetThreadId + ':' + text);
      return { turnId: 'turn', when: 'queue' };
    },
  });
  const actor = { kind: 'bot' as const, source: { botId: 'chief', threadId: 'chief-a', conversationId: 'chief-conversation' } };
  const input = { to: 'writer', name: 'heading', text: 'Review this', when: 'now' as const };
  const authorize = async () => { current = second; };
  const saved = await svc.send(actor, input, authorize);
  assert.equal(saved.threadId, first.threadId);
  assert.equal(saved.when, 'queue');
  assert.deepEqual(await svc.send(actor, input, authorize), saved);
  assert.deepEqual(received, ['writer-a:Review this']);
  await assert.rejects(svc.send(actor, { ...input, conversationId: second.conversationId }, authorize), /different request/);
});
