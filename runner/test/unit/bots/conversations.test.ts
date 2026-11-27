import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BotRepository } from '../../../src/bots/repository.ts';
import { BotConversations } from '../../../src/bots/conversations.ts';
import { botMethods } from '../../../src/bots/rpc.ts';
import { RpcServer } from '../../../src/rpc.ts';
import { RunnerClient } from '../../../src/client.ts';
import { threadKey } from '../../../src/rpc-auth.ts';
import { CallerGate } from '../../../src/rpc-gate.ts';
import { nullLogger } from '../../../src/log.ts';
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

// DS-Bot threads.test.js L19–44: a new CLI part stays in its conversation.
test('a fresh session keeps its conversation identity across Runner restart', async () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  let service: BotConversations;
  const h = makeHarness(home, {}, { botContext: rec => service.context(rec) });
  const repo = new BotRepository(root, 'runner-1');
  service = new BotConversations(h.runner, repo, root);
  const bot = repo.create({ name: 'Writer' });
  const first = service.create(bot.id, 'first');
  const second = service.create(bot.id, 'second');
  h.runner.send(first.threadId, 'Check a title');
  await tick();
  const session = h.adapter.last;
  const freshId = randomUUID();
  session.init(freshId);
  session.result();
  await tick();
  const restarted = h.restart();
  const reopened = new BotRepository(root, 'runner-1');
  assert.equal(restarted.store.load(first.threadId)?.nativeSessionId, freshId);
  assert.equal(reopened.matchesConversation(bot.id, first.id, first.threadId), true);
  assert.equal(reopened.matchesConversation(bot.id, first.id, second.threadId), false);
  assert.equal(reopened.matchesConversation(bot.id, first.id, bot.id), false);
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

test('the settings chosen on one conversation can become defaults for later conversations', () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner-1');
  const service = new BotConversations(h.runner, repo, root);
  const editor = repo.create({ name: 'Editor' });
  const a = service.create(editor.id, 'a');
  const unrelated = h.runner.makeThread({ text: 'Independent' }).st.rec.id;
  h.runner.update({ threadId: a.threadId, accountId: 'claude-3', model: 'claude-sonnet-4-6' });
  assert.throws(() => service.conversationModel(editor.id, editor.revision, unrelated), /does not belong/);
  let saved = service.conversationModel(editor.id, editor.revision, a.threadId);
  const b = service.create(editor.id, 'b');
  assert.equal(h.store.load(b.threadId)?.accountId, 'claude-3');
  assert.equal(h.store.load(b.threadId)?.model, 'claude-sonnet-4-6');
  saved = service.conversationModel(editor.id, saved.revision, null);
  assert.equal(saved.modelBinding, undefined);
  assert.equal(h.store.load(a.threadId)?.model, 'claude-sonnet-4-6');
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
  assert.deepEqual(resumed.events(b.threadId).filter(event => event.type === 'user.message').map(event => event.text), ['次の記事も', '最後の記事']);
  resumed.adapter.last.result('completed');
  await tick();

  service!.remember(editor.id, a.threadId, '敬体で書く');
  const session = resumed.adapter.last;
  const send = session.send.bind(session);
  session.send = () => { throw new Error('test send failure'); };
  const thread = resumed.runner.threads.get(b.threadId)!;
  const before = thread.rec.botContextTold;
  assert.throws(() => resumed.runner.sendWithInstructionsNews(thread, { id: 'failed-send', text: '再試行', images: [] }), /test send failure/);
  assert.equal(thread.rec.botContextTold, before);
  let committed = false;
  session.send = input => {
    const log = resumed.store.log(b.threadId);
    const row = log.read(1, log.lastSeq).find(event => event.type === 'user.message' && event.text === '次の記事');
    assert.equal(row?.type === 'user.message' && row.botInput?.conversationId, b.id);
    assert.notEqual(row?.type === 'user.message' && row.botInput?.id, row?.turnId);
    committed = true;
    send(input);
  };
  resumed.runner.send(b.threadId, '次の記事');
  await tick();
  assert.equal(committed, true);
  assert.match(session.sent.at(-1)?.text ?? '', /敬体で書く[\s\S]*次の記事/);
});

test('the owner can create and read Bot conversations over RPC and a Full thread key cannot', async t => {
  let service: BotConversations;
  const h = makeHarness(tmpDir(), {}, { botContext: rec => service.context(rec) });
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner-1');
  service = new BotConversations(h.runner, repo, root);
  const token = 'bot-test-owner-authentication';
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token, runner: h.runner, log: nullLogger, gate: new CallerGate({ runner: h.runner }), methods: botMethods(() => ({ repo, conversations: service })) });
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}/rpc`;
  const owner = await RunnerClient.connect(url, token);
  const caller = h.runner.makeThread({ text: '', permissionMode: 'full' }).st.rec.id;
  const full = await RunnerClient.connect(url, threadKey(token, caller), { threadId: caller });
  t.after(async () => { owner.close(); full.close(); await server.close(); });
  const { bot } = await owner.call<{ bot: { id: string; revision: number } }>('bots.create', { name: 'Editor' });
  await assert.rejects(full.call('bots.list', {}), /owner/);
  await assert.rejects(full.call('bots.list', { includeRosterMarks: true }), /owner/);
  const markless = await owner.call<{ bots: { id: string; rosterMark?: unknown }[] }>('bots.list', {});
  assert.equal(markless.bots[0].rosterMark, undefined);
  const marks = await owner.call<{ bots: { id: string; rosterMark: { light: string; dark?: string } }[] }>('bots.list', { includeRosterMarks: true });
  assert.match(marks.bots[0].rosterMark.light, /<mask id="bot-mark"/);
  const detail = await owner.call<{ bot: { rosterMark: unknown } }>('bots.get', { botId: bot.id, includeRosterMarks: true });
  assert.deepEqual(detail.bot.rosterMark, marks.bots[0].rosterMark);
  await assert.rejects(full.call('bots.create', { name: 'Intruder' }), /owner/);
  const copy = { botId: bot.id, expectedRevision: bot.revision, operationId: 'rpc-copy' };
  await assert.rejects(full.call('bots.duplicate', copy), /owner/);
  assert.equal((await owner.call<{ bot: { name: string } }>('bots.duplicate', copy)).bot.name, 'Editor copy');
  await assert.rejects(full.call('bots.conversations.attach', { ...copy, threadId: caller, operationId: 'rpc-attach' }), /owner/);
  const existing = h.runner.makeThread({ text: '' }).st.rec;
  const attached = await owner.call<{ conversation: { threadId: string } }>('bots.conversations.attach',
    { ...copy, threadId: existing.id, operationId: 'rpc-attach' });
  assert.equal(attached.conversation.threadId, existing.id);
  const { conversation } = await owner.call<{ conversation: { threadId: string } }>('bots.conversations.create', { botId: bot.id, operationId: 'a' });
  const input = { botId: bot.id, threadId: conversation.threadId };
  const { note } = await owner.call<{ note: { id: string } }>('bots.memory.add', { ...input, text: 'Keep headings short' });
  assert.equal((await owner.call<{ notes: unknown[] }>('bots.memory.read', input)).notes.length, 1);
  await assert.rejects(full.call('bots.memory.read', input), /owner/);
  await owner.call('threads.send', { threadId: conversation.threadId, text: 'Review a heading' });
  await tick();
  h.adapter.last.init();
  await full.call('threads.send', { threadId: conversation.threadId, text: 'Use this paragraph too', botSource: { kind: 'owner' } });
  await tick();
  const log = h.store.log(conversation.threadId);
  const messages = log.read(1, log.lastSeq).filter(row => row.type === 'user.message');
  assert.deepEqual(messages.map(row => row.botInput?.source), [{ kind: 'owner' }, { kind: 'thread', threadId: caller }]);
  await owner.call('bots.memory.edit', { ...input, entryId: note.id, text: 'Keep headings concise' });
  const { rows } = await owner.call<{ rows: { id: string; op: string }[] }>('bots.memory.history', input);
  assert.equal(rows[0].op, 'replace');
  await owner.call('bots.memory.restore', { ...input, changeId: rows[0].id });
  await owner.call('bots.memory.remove', { ...input, entryId: note.id });
  await owner.call('bots.archive', { botId: bot.id, expectedRevision: bot.revision });
  await assert.rejects(owner.call('bots.memory.add', { ...input, text: 'One more' }), /archived/);
  await assert.rejects(owner.call('bots.conversations.create', { botId: bot.id, operationId: 'b' }), /archived/);
  assert.equal((await owner.call<{ rows: unknown[] }>('bots.memory.history', input)).rows.length, 4);
});

test('the original copy policy names concurrent copies, keeps a model’s Default, and does not copy Bot history or authority', async () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner-1');
  const original = repo.create({ name: 'Writer', role: 'Editor', instructions: '日本語で校正' });
  const team = repo.createTeam('Desk', [original.id], h.runner.isoNow());
  const folder = join(h.home, 'editor-work');
  mkdirSync(folder);
  const bot = repo.createManagedBot(team.id, team.revision, original.id, h.runner.isoNow(), {
    name: 'Managed Writer', role: original.role, instructions: original.instructions,
    modelBinding: { accountId: 'claude-3', provider: 'claude', model: 'claude-sonnet-4-6' },
    workFolder: folder, permissionCeiling: 'plan',
  }).bot;
  const service = new BotConversations(h.runner, repo, root);
  const chat = service.create(bot.id, 'source-chat');
  service.remember(bot.id, chat.threadId, 'コピーしない覚書');
  h.runner.defaultEffortFor = () => 'high';
  const copy = (operationId: string) => service.duplicate(bot.id, bot.revision, operationId);
  const [first, second, third, retry] = await Promise.all([copy('d1'), copy('d2'), copy('d3'), copy('d1')]);
  assert.deepEqual([first.name, second.name, third.name].sort(), ['Managed Writer copy', 'Managed Writer copy 2', 'Managed Writer copy 3']);
  assert.equal(first.id, retry.id);
  assert.equal(first.role, bot.role);
  assert.equal(first.instructions, bot.instructions);
  assert.equal(first.workFolder, folder);
  assert.equal(first.copyOf, bot.id);
  assert.equal(first.permissionCeiling, undefined);
  assert.equal(first.reviewEnabled, undefined);
  assert.notEqual(repo.teamIdForBot(first.id), team.id);
  assert.deepEqual(repo.conversations(first.id), []);
  assert.equal(service.scopedMemory.open({ kind: 'bot', id: first.id }, { kind: 'owner' }, 'read').list('2026-11-27').length, 0);
  const fresh = service.create(first.id, 'copied-chat');
  assert.equal(h.store.load(fresh.threadId)?.model, 'claude-sonnet-4-6');
  assert.equal(h.store.load(fresh.threadId)?.effort, undefined);
  assert.deepEqual(repo.conversations(bot.id), [chat]);
  const restarted = new BotConversations(h.runner, new BotRepository(root, 'runner-1'), root);
  assert.equal((await restarted.duplicate(bot.id, bot.revision, 'd1')).id, first.id);
  await assert.rejects(restarted.duplicate(original.id, original.revision, 'd1'), /operation already belongs/);

  rmdirSync(folder);
  const unavailable = repo.setModelBinding(bot.id, bot.revision, { accountId: 'missing', provider: 'claude', model: 'claude-sonnet-4-6' });
  const fallback = await service.duplicate(bot.id, unavailable.revision, 'd4');
  assert.equal(fallback.workFolder, undefined);
  assert.equal(fallback.modelBinding, undefined);
});

test('the copy rejects a Bot that is Private or changes while the source policy is awaiting its catalog', async () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner-1');
  const service = new BotConversations(h.runner, repo, root);
  const source = repo.create({ name: 'Editor' });
  const reconsider = service.duplicate(source.id, source.revision, 'd1');
  const current = repo.setPrivate(source.id, source.revision, h.home, 'private-on', [], () => {});
  await assert.rejects(reconsider, /private, so it cannot be copied/i);
  await assert.rejects(service.duplicate(source.id, current.revision, 'd2'), /private, so it cannot be copied/i);
  assert.equal(repo.list().length, 1);
});

test('attaching an idle local Thread keeps its transcript and CLI session across a failed confirmation and restart', async () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  const h = makeHarness(home);
  const repo = new BotRepository(root, 'runner-1');
  const bot = repo.create({ name: 'Editor', instructions: '見出しを短くする' });
  const convo = new BotConversations(h.runner, repo, root);
  const threadId = h.runner.makeThread({ text: '', title: 'Existing notes' }).st.rec.id;
  h.runner.send(threadId, '先に保存していた既存メッセージ');
  await tick();
  h.adapter.last.init();
  const running = () => convo.attach(bot.id, bot.revision, threadId, 'attach-existing');
  assert.throws(running, /idle/i);
  h.adapter.last.result();
  await tick();
  const record = h.store.load(threadId)!;
  const log = h.store.log(threadId);
  const originalEvents = log.read(1, log.lastSeq);
  const confirm = repo.confirmConversation.bind(repo);
  repo.confirmConversation = () => { throw new Error('lost confirmation write'); };
  assert.throws(running, /lost confirmation/);
  repo.confirmConversation = confirm;
  const saved = h.store.load(threadId)!;
  assert.equal(saved.nativeSessionId, record.nativeSessionId);
  assert.equal(saved.botLink?.botId, bot.id);
  const restarted = h.restart();
  const reopenedRepo = new BotRepository(root, 'runner-1');
  const reopened = new BotConversations(restarted.runner, reopenedRepo, root);
  assert.match(reopened.context(restarted.store.load(threadId)!), /見出しを短くする/);
  const confirmed = reopened.attach(bot.id, bot.revision, threadId, 'attach-existing');
  assert.deepEqual(reopened.attach(bot.id, bot.revision, threadId, 'attach-existing'), confirmed);
  const events = restarted.store.log(threadId);
  assert.deepEqual(events.read(1, events.lastSeq), originalEvents);
  assert.deepEqual(restarted.store.load(threadId), { ...record, botLink: { botId: bot.id, conversationId: confirmed.id } });
  assert.match(reopened.context(restarted.store.load(threadId)!), /見出しを短くする/);
  assert.throws(() => reopened.create(bot.id, 'attach-existing'), /operation already belongs/i);
});

test('attaching refuses a different owner, a mismatched model, a Private Bot and a copied Thread', () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner-1');
  const bot = repo.create({ name: 'Editor' });
  const st = h.runner.makeThread({ text: '', model: 'claude-sonnet-4-6' }).st;
  const service = new BotConversations(h.runner, repo, root, undefined, { mayAttach: () => false });
  assert.throws(() => service.attach(bot.id, bot.revision, st.rec.id, 'foreign'), /own/i);
  const local = new BotConversations(h.runner, repo, root);
  const chosen = repo.setModelBinding(bot.id, bot.revision, { accountId: 'claude-3', provider: 'claude', model: 'claude-opus-4-6' });
  assert.throws(() => local.attach(bot.id, chosen.revision, st.rec.id, 'model'), /model/i);
  const madePrivate = repo.setPrivate(bot.id, chosen.revision, h.home, 'private-on', [], () => {});
  assert.throws(() => local.attach(bot.id, madePrivate.revision, st.rec.id, 'private'), /Private/);
  const ordinary = repo.create({ name: 'Reader' });
  st.rec.copied = true;
  assert.throws(() => local.attach(ordinary.id, ordinary.revision, st.rec.id, 'read-only'), /copied|local/i);
  assert.equal(h.store.load(st.rec.id)?.botLink, undefined);
});

test('an older idle Thread with no CLI session stays session-free during attachment', () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner-1');
  const bot = repo.create({ name: 'Editor' });
  const { st } = h.runner.makeThread({ text: '', title: 'Legacy Thread' });
  delete st.rec.nativeSessionId;
  h.store.save(st.rec);
  const service = new BotConversations(h.runner, repo, root);
  const attached = service.attach(bot.id, bot.revision, st.rec.id, 'legacy-attach');
  const record = h.store.load(st.rec.id)!;
  assert.equal(record.nativeSessionId, undefined);
  assert.deepEqual(record.botLink, { botId: bot.id, conversationId: attached.id });
});

test('a concurrent change of the owning Runner cannot commit a native Bot copy', async () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner-1');
  const bot = repo.create({ name: 'Editor' });
  let owns = true;
  const service = new BotConversations(h.runner, repo, root, undefined, { canModify: () => owns });
  const copying = service.duplicate(bot.id, bot.revision, 'copy-during-handover');
  owns = false;
  await assert.rejects(copying, /current Runner/);
  assert.equal(repo.list().length, 1);
});

test('the compatibility guard runs before a copy or existing Thread attachment is persisted', async () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner-1');
  const bot = repo.create({ name: 'Editor' });
  const thread = h.runner.makeThread({ text: '' }).st.rec;
  const old = new BotConversations(h.runner, repo, root, undefined, {
    protectRoster: () => { throw new Error('updated Bot supervisor required'); },
  });
  await assert.rejects(old.duplicate(bot.id, bot.revision, 'old-copy'), /updated Bot supervisor/);
  assert.throws(() => old.attach(bot.id, bot.revision, thread.id, 'old-attach'), /updated Bot supervisor/);
  assert.equal(repo.list().length, 1);
  assert.equal(repo.pendingAttachment(thread.id), undefined);
  assert.equal(h.store.load(thread.id)?.botLink, undefined);
});


test('copying uses the original validation of the saved avatar and palette', async () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const original = new BotRepository(root, 'runner-1').create({ name: 'Editor' });
  const file = join(root, 'state.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(saved.bots[0], { color: 'kimi', avatar: { shape: 'cat' }, sectionId: 'desk', browserGrants: ['no-copy'] });
  writeFileSync(file, JSON.stringify(saved));
  const repo = new BotRepository(root, 'runner-1');
  const service = new BotConversations(h.runner, repo, root);
  const copy = await service.duplicate(original.id, original.revision, 'appearance');
  assert.equal(copy.color, 'charcoal');
  assert.deepEqual(copy.avatar, { shape: 'cat' });
  assert.equal(copy.sectionId, 'desk');
  assert.equal(copy.browserGrants, undefined);
});
