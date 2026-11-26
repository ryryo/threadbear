import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotConversations } from '../../../src/bots/conversations.ts';
import { BotRepository } from '../../../src/bots/repository.ts';
import type { SendOptions } from '../../../src/runner.ts';
import { makeHarness, tick, tmpDir } from '../../helpers/fakes.ts';

function linked() {
  const home = tmpDir();
  const root = join(home, 'bots');
  let service: BotConversations;
  let decision: 'allow' | 'drop' = 'allow';
  const h = makeHarness(home, {}, { botContext: rec => service.context(rec), botRequestQueue: () => decision });
  const repo = new BotRepository(root, 'runner');
  service = new BotConversations(h.runner, repo, root);
  const sender = service.create(repo.create({ name: 'Editor' }).id, 'sender');
  const receiver = service.create(repo.create({ name: 'Writer' }).id, 'receiver');
  const opts: SendOptions = {
    messageId: 'request-input', botSource: { kind: 'thread', threadId: sender.threadId },
    botRequest: { id: 'request', role: 'request' }, queue: true,
  };
  return { h, sender, receiver, opts, cancel: () => { decision = 'drop'; } };
}

test('a queued request is durably recorded before the Runner confirms it', async () => {
  const { h, receiver, sender, opts, cancel } = linked();
  h.runner.send(receiver.threadId, 'The current turn');
  await tick();
  const session = h.adapter.last;
  assert.equal(h.runner.send(receiver.threadId, 'The request', [], opts).turnId, 'request-input');
  const queued = h.store.load(receiver.threadId)?.queue.at(-1);
  assert.deepEqual(queued?.botInput, {
    id: 'request-input', conversationId: receiver.id, request: { id: 'request', role: 'request' },
    source: { kind: 'thread', threadId: sender.threadId },
  });
  assert.equal(session.sent.length, 1);
  cancel();
  session.init();
  session.result();
  await tick();
  assert.equal(session.sent.length, 1);
  assert.equal(h.runner.threads.get(receiver.threadId)?.rec.queue.length, 0);
});

test('a failed durable queue write never passes the request to the CLI', async () => {
  const { h, receiver, opts } = linked();
  const save = h.store.save.bind(h.store);
  h.store.save = rec => {
    if (rec.queue.some(item => item.botInput?.request?.id === 'request')) throw new Error('disk full');
    save(rec);
  };
  assert.throws(() => h.runner.send(receiver.threadId, 'The request', [], opts), /disk full/);
  await tick();
  assert.equal(h.adapter.sessions.length, 0);
  assert.equal(h.runner.threads.get(receiver.threadId)?.rec.queue.length, 0);
  assert.equal(h.store.load(receiver.threadId)?.queue.length, 0);
});

test('the recovered queue drops a duplicate whose Bot input receipt already reached the log', async () => {
  const { h, receiver, opts } = linked();
  h.runner.send(receiver.threadId, 'The request', [], opts);
  await tick();
  const session = h.adapter.last;
  session.init();
  session.result();
  await tick();
  const rec = h.store.load(receiver.threadId)!;
  rec.queue.push({
    text: 'The request', images: [], turnId: 'request-input',
    botInput: { id: 'request-input', conversationId: receiver.id, request: opts.botRequest, source: opts.botSource! },
  });
  h.store.save(rec);
  const reopened = h.restart();
  const state = reopened.runner.threads.get(receiver.threadId)!;
  reopened.runner.kickQueue(state);
  await tick();
  assert.equal(state.rec.queue.length, 0);
  assert.equal(reopened.adapter.sessions.length, 0);
  const log = reopened.store.log(receiver.threadId);
  assert.equal(log.read(1, log.lastSeq).filter(event =>
    event.type === 'user.message' && event.botInput?.request?.id === 'request').length, 1);
});
