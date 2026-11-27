import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotRuntime } from '../../../src/bots/runtime.ts';
import { neutraliseCopied } from '../../../src/real-copy.ts';
import { makeHarness, tick, tmpDir } from '../../helpers/fakes.ts';

test('the feature defaults off, and an unguarded Runner cannot create Bot data', () => {
  const h = makeHarness(tmpDir());
  let enabled = false;
  let guarded = false;
  let owns = true;
  const runtime = new BotRuntime({ home: h.home, runner: () => h.runner, owner: () => 'local', enabled: () => enabled, guarded: () => guarded, owns: () => owns });
  const marker = join(h.home, 'bots-format.json');
  const state = join(h.home, 'bots', 'state.json');
  assert.equal(runtime.methods['bots.status']({}).available, false);
  assert.throws(() => runtime.methods['bots.create']({ name: 'Editor' }), /turned off/);
  enabled = true;
  assert.throws(() => runtime.methods['bots.create']({ name: 'Editor' }), /supervisor/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(state), false);
  guarded = true;
  assert.equal(runtime.methods['bots.status']({}).available, true);
  assert.deepEqual(runtime.methods['bots.list']({}), { bots: [] });
  assert.equal(existsSync(marker), false);
  runtime.methods['bots.create']({ name: 'Editor' });
  assert.equal(readFileSync(marker, 'utf8').trim(), '1');
  assert.equal(existsSync(state), true);
  owns = false;
  assert.throws(() => runtime.methods['bots.list']({}), /owning Runner/);
});

test('a kept turn stores one Bot note on the primary with the authenticated source', async () => {
  const home = tmpDir();
  let old: BotRuntime;
  let oldOwns = true;
  const h = makeHarness(home, {}, { botContext: rec => old.context(rec) });
  old = new BotRuntime({ home, runner: () => h.runner, owner: () => 'local', enabled: () => true, guarded: () => true, owns: () => oldOwns });
  const { bot } = old.methods['bots.create']({ name: 'Editor' }) as { bot: { id: string } };
  const { thread } = old.methods['bots.conversations.create']({ botId: bot.id, operationId: 'source' }) as { thread: { id: string } };
  h.runner.send(thread.id, 'Keep the headline short');
  await tick();
  const cli = h.adapter.last;
  cli.init();
  const turnId = h.runner.threads.get(thread.id)!.rt.turn!.turnId;
  oldOwns = false;
  const next = makeHarness(home, {}, {}, { skip: new Set([thread.id]) });
  const primary = new BotRuntime({ home, runner: () => next.runner, owner: () => 'local', enabled: () => true, guarded: () => true, owns: () => true, peerOwns: id => id === thread.id });
  const input = { operationId: 'headlines', text: '見出しは短くする', pin: false };
  assert.throws(() => old.rememberFromTurn(thread.id, turnId, input), /owning Runner/);
  assert.throws(() => primary.rememberFromTurn(thread.id, 'old-turn', input, true), /active turn/);
  const saved = primary.rememberFromTurn(thread.id, turnId, input, true);
  assert.deepEqual(primary.rememberFromTurn(thread.id, turnId, input, true), saved);
  assert.throws(() => primary.rememberFromTurn(thread.id, turnId, { ...input, text: 'Different note' }, true), /different change/);
  assert.equal(saved.note?.pinned, false);
  const { rows } = primary.methods['bots.memory.history']({ botId: bot.id, threadId: thread.id }) as {
    rows: { actor: string; sourceThreadId: string; sourceTurnId: string; sourceSeq: number }[];
  };
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor, bot.id);
  assert.equal(rows[0]!.sourceThreadId, thread.id);
  assert.equal(rows[0]!.sourceTurnId, turnId);
  assert.ok(rows[0]!.sourceSeq > 0);
  cli.result();
  await tick();
  assert.throws(() => primary.rememberFromTurn(thread.id, turnId, input, true), /active turn/);
});

test('Bot Threads cannot be packed for moving, and a copy retains its read-only link', async () => {
  const home = tmpDir();
  let runtime: BotRuntime;
  const h = makeHarness(home, {}, { botContext: rec => runtime.context(rec) });
  runtime = new BotRuntime({ home, runner: () => h.runner, owner: () => 'local', enabled: () => true, guarded: () => true, owns: () => true });
  const { bot } = runtime.methods['bots.create']({ name: 'Editor' }) as { bot: { id: string } };
  const { conversation } = runtime.methods['bots.conversations.create']({ botId: bot.id, operationId: 'a' }) as { conversation: { threadId: string } };
  const id = conversation.threadId;
  await assert.rejects(h.runner.describeForMove(id, 0), /owning Runner/);
  await assert.rejects(h.runner.packForMove(id, {} as never), /owning Runner/);
  const rec = h.store.load(id)!;
  rec.botContextTold = 'old-snapshot';
  const copied = neutraliseCopied(rec, tmpDir());
  assert.equal(copied.copied, true);
  assert.equal(copied.botLink?.botId, bot.id);
  assert.equal(copied.botContextTold, undefined);
  assert.throws(() => runtime.context(copied), /copy/i);
});

test('Private is guarded before the first conversation and children keep the dedicated folder', async () => {
  const home = tmpDir();
  const folder = realpathSync.native(tmpDir());
  const marker = join(home, 'bots-format.json');
  let runtime: BotRuntime;
  let canChangePrivacy = false;
  let enabled = true;
  const h = makeHarness(home, {}, { botContext: rec => runtime.context(rec), botFolderRefusal: (cwd, id) => runtime.folderRefusal(cwd, id) });
  runtime = new BotRuntime({
    home, runner: () => h.runner, owner: () => 'local', enabled: () => enabled, guarded: () => true, owns: () => true,
    canChangePrivacy: () => canChangePrivacy,
    protectPrivacy: () => { writeFileSync(marker, '2\n'); },
  });
  const { bot } = runtime.methods['bots.create']({ name: 'Private Writer' }) as { bot: { id: string; revision: number } };
  const params = { botId: bot.id, expectedRevision: bot.revision, folder, operationId: randomUUID() };
  await assert.rejects(Promise.resolve(runtime.methods['bots.settings.privacy'](params)), /finish handing over/);
  assert.equal(readFileSync(marker, 'utf8').trim(), '1');
  canChangePrivacy = true;
  await assert.rejects(Promise.resolve(runtime.methods['bots.settings.privacy']({ ...params, folder: h.runner.cfg.defaults.cwd })), /dedicated Bot folder/);
  const changed = await runtime.methods['bots.settings.privacy'](params);
  assert.equal(readFileSync(marker, 'utf8').trim(), '2');
  const { thread } = runtime.methods['bots.conversations.create']({ botId: bot.id, operationId: 'p' }) as { thread: { id: string; privateBotId: string; cwd: string } };
  assert.equal(thread.privateBotId, bot.id);
  assert.equal(thread.cwd, folder);
  assert.deepEqual(await runtime.methods['bots.settings.privacy'](params), changed);
  const child = h.runner.makeThread({ text: '', startedBy: { kind: 'thread', label: 'Agent', threadId: thread.id } }).st.rec;
  assert.equal(child.privateBotId, bot.id);
  assert.equal(child.cwd, folder);
  assert.throws(() => h.runner.makeThread({ text: '', cwd: folder }), /overlaps a private Bot/);
  assert.throws(() => h.runner.update({ threadId: child.id, cwd: h.runner.cfg.defaults.cwd }), /dedicated work folder/);
  assert.deepEqual(h.runner.threadRecords(), []);
  h.runner.update({ threadId: thread.id, archived: true });
  enabled = false;
  assert.equal(h.store.load(thread.id)?.privateBotId, bot.id);
  assert.throws(() => h.runner.makeThread({ text: '', cwd: folder }), /overlaps a private Bot/);
});

test('existing Bot conversations stay locally protected across failure and resume withdrawal after restart', async () => {
  const home = tmpDir();
  const folder = realpathSync.native(tmpDir());
  let runtime: BotRuntime;
  let fail = true;
  let masked: string[] = [];
  const make = () => makeHarness(home, {}, {
    botContext: rec => runtime.context(rec), botFolderRefusal: (cwd, id) => runtime.folderRefusal(cwd, id),
    pendingBotPrivacy: id => runtime.pendingPrivateThread(id),
  });
  const open = (runner: ReturnType<typeof make>['runner']) => new BotRuntime({
    home, runner: () => runner, owner: () => 'local', enabled: () => true, guarded: () => true, owns: () => true,
    canChangePrivacy: () => true,
    protectPrivacy: () => { writeFileSync(join(home, 'bots-format.json'), '2\n'); },
    withdrawShared: async ids => {
      masked = [...ids];
      assert.ok(ids.every(id => runner.privateBotOf(id)));
      if (fail) throw new Error('The sync fixture is offline');
    },
  });
  const h = make();
  runtime = open(h.runner);
  const { bot } = runtime.methods['bots.create']({ name: 'Writer' }) as { bot: { id: string; revision: number } };
  const { thread } = runtime.methods['bots.conversations.create']({ botId: bot.id, operationId: 'old-chat' }) as { thread: { id: string } };
  h.runner.share(thread.id, { access: 'link' });
  const child = h.runner.makeThread({ text: '', startedBy: { kind: 'thread', label: 'Agent', threadId: thread.id } }).st.rec;
  const params = { botId: bot.id, expectedRevision: bot.revision, folder, operationId: randomUUID() };
  await assert.rejects(Promise.resolve(runtime.methods['bots.settings.privacy'](params)), /fixture is offline/);
  assert.deepEqual(new Set(masked), new Set([thread.id, child.id]));
  assert.equal(h.store.load(thread.id)?.share, undefined);
  assert.throws(() => h.runner.send(thread.id, 'Wait for the move'), /Finish moving/);
  assert.throws(() => runtime.methods['bots.conversations.create']({ botId: bot.id, operationId: 'new-chat' }), /Finish moving/);
  const restarted = h.restart();
  runtime = open(restarted.runner);
  fail = false;
  const complete = await runtime.methods['bots.settings.privacy'](params) as { bot: { privacy: { folder: string; moving?: string[] } } };
  assert.equal(complete.bot.privacy.moving, undefined);
  assert.equal(complete.bot.privacy.folder, folder);
  assert.equal(restarted.store.load(thread.id)?.privateBotId, bot.id);
  assert.equal(restarted.store.load(child.id)?.cwd, folder);
});
