import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { BotRepository } from '../../../src/bots/repository.ts';
import { BotConversations } from '../../../src/bots/conversations.ts';
import { makeHarness, tick, tmpDir } from '../../helpers/fakes.ts';

test('a second Bot conversation reads the first conversation’s note after reopening the Runner', () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner-1');
  const service = new BotConversations(h.runner, repo, root);
  const editor = repo.create({ name: '編集者' });
  const a = service.create(editor.id, 'a');
  const note = service.remember(editor.id, a.threadId, '見出しは短くする');
  const b = service.create(editor.id, 'b');
  const aRecord = h.store.load(a.threadId)!;
  const bRecord = h.store.load(b.threadId)!;
  assert.notEqual(aRecord.nativeSessionId, bRecord.nativeSessionId);
  assert.deepEqual(aRecord.botLink, { botId: editor.id, conversationId: a.id });
  assert.deepEqual(bRecord.botLink, { botId: editor.id, conversationId: b.id });

  const restarted = h.restart();
  const reopened = new BotConversations(restarted.runner, new BotRepository(root, 'runner-1'), root);
  assert.deepEqual(reopened.create(editor.id, 'b'), b);
  assert.deepEqual(reopened.notes(editor.id, b.threadId), [note]);
  assert.equal(restarted.store.load(b.threadId)?.nativeSessionId, bRecord.nativeSessionId);
  const outside = restarted.runner.makeThread({ text: 'Independent thread' }).st.rec.id;
  assert.throws(() => reopened.notes(editor.id, outside), /does not belong/);
});

test('a saved Thread can confirm the same Bot reservation after confirmation failed', () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner-1');
  const editor = repo.create({ name: 'Editor' });
  const service = new BotConversations(h.runner, repo, root);
  const confirm = repo.confirmConversation.bind(repo);
  repo.confirmConversation = () => { throw new Error('state write failed'); };
  assert.throws(() => service.create(editor.id, 'a'), /state write failed/);
  const pending = repo.reserveConversation(editor.id, 'a');
  const record = h.store.load(pending.threadId)!;
  assert.equal(record.botLink?.conversationId, pending.id);
  repo.confirmConversation = confirm;
  const restarted = h.restart();
  const reopened = new BotConversations(restarted.runner, new BotRepository(root, 'runner-1'), root);
  assert.equal(reopened.create(editor.id, 'a').threadId, pending.threadId);
  assert.equal(restarted.store.load(pending.threadId)?.nativeSessionId, record.nativeSessionId);
});

test('a fresh Bot conversation hears the shared note and a resumed CLI hears only a changed Bot context', async () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  let service: BotConversations;
  const open = () => {
    const h = makeHarness(home, {}, { botContext: rec => service.context(rec) });
    const repo = new BotRepository(root, 'runner-1');
    service = new BotConversations(h.runner, repo, root);
    return { h, repo };
  };
  const { h, repo } = open();
  const editor = repo.create({ name: '編集者', instructions: '記事を編集する' });
  const a = service!.create(editor.id, 'a');
  service!.remember(editor.id, a.threadId, '見出しは短くする');
  const b = service!.create(editor.id, 'b');
  h.runner.send(b.threadId, 'この記事を見て');
  await tick();
  assert.match(h.adapter.last.opts.instructions ?? '', /見出しは短くする/);
  assert.equal(h.adapter.last.sent.at(-1)?.text, 'この記事を見て');
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();

  const { h: resumed, repo: reopened } = open();
  reopened.update(editor.id, editor.revision, { instructions: '箇条書きで返す' });
  resumed.runner.send(b.threadId, '次の記事も');
  await tick();
  assert.equal(resumed.adapter.last.opts.resume, true);
  assert.match(resumed.adapter.last.sent.at(-1)?.text ?? '', /箇条書きで返す[\s\S]*見出しは短くする[\s\S]*次の記事も/);
  resumed.adapter.last.init();
  resumed.adapter.last.result('completed');
  await tick();
  resumed.runner.send(b.threadId, '最後の記事');
  await tick();
  assert.equal(resumed.adapter.last.sent.at(-1)?.text, '最後の記事');
});
