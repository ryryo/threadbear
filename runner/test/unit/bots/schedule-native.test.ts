// DS-Bot schedules.test.js owner/target, pause CAS and one-off cases,
// using the native Scheduler and Bot conversation records.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotConversations } from '../../../src/bots/conversations.ts';
import { GroupStore } from '../../../src/bots/group-store.ts';
import { BotGroups } from '../../../src/bots/groups.ts';
import { BotRepository } from '../../../src/bots/repository.ts';
import { botConversationSchedules } from '../../../src/bots/schedule-rpc.ts';
import { BotScheduleTargets } from '../../../src/bots/schedule-target.ts';
import { scheduleRouter } from '../../../src/handover.ts';
import { nullLogger } from '../../../src/log.ts';
import { Scheduler } from '../../../src/schedules.ts';
import { makeHarness, tick } from '../../helpers/fakes.ts';

function setup() {
  let conversations: BotConversations;
  let groups: BotGroups;
  const h = makeHarness(undefined, {}, {
    botContext: rec => {
      if (rec.botLink?.groupId) { groups.threads.check(rec); return ''; }
      return conversations.context(rec);
    },
    botGroupQueue: (threadId, ref) => groups.queue(threadId, ref),
  });
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, 'runner');
  conversations = new BotConversations(h.runner, repo, root);
  const chief = repo.create({ name: 'Editor' });
  const writer = repo.create({ name: 'Writer' });
  groups = new BotGroups({ runner: h.runner, owns: () => true, store: new GroupStore(root, repo, () => {}) });
  const targets = new BotScheduleTargets({ runner: h.runner, repo, conversations, groups: () => groups });
  const scheduler = new Scheduler({
    runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC',
    botSchedules: { targets: () => targets, protect: () => {} },
  });
  scheduler.start();
  const future = new Date(h.clock.now() + 60_000).toISOString();
  return { h, chief, writer, repo, conversations, groups, targets, scheduler, future };
}

test('the schedule binds an authorized conversation and reuses the native fire receipt', async () => {
  const { h, chief, writer, repo, conversations, targets, future } = setup();
  const a = conversations.create(chief.id, 'a');
  const b = conversations.create(chief.id, 'b');
  const target = { kind: 'conversation' as const, botId: chief.id, conversationId: a.id, threadId: a.threadId };
  assert.throws(() => targets.verify({ ...target, botId: writer.id }), /does not belong/);
  const schedule = { id: '49bfa2f7-a7ba-40d9-af5b-b5f41a8e1994', botCeiling: 'full' as const };
  const when = Date.parse(future);
  const first = targets.deliver(target, schedule, 'same', '見出しを見直す', when);
  repo.update(chief.id, chief.revision, { role: 'Lead Editor' });
  const retry = targets.deliver(target, schedule, 'same', '見出しを見直す', when);
  assert.deepEqual(first, retry);
  assert.equal(first.threadId, a.threadId);
  assert.equal(h.store.load(b.threadId)?.queue.length, 0);
  await tick();
  assert.equal(h.adapter.sessions.length, 1);
});

test('the same fire uses one new conversation, preserving its model revision and cap', async () => {
  const { h, chief, repo, targets } = setup();
  const target = { kind: 'newConversation' as const, botId: chief.id };
  const schedule = { id: '49bfa2f7-a7ba-40d9-af5b-b5f41a8e1994', botCeiling: 'ask' as const };
  const a = targets.deliver(target, schedule, 'run-one', '下書き', h.clock.now());
  const b = targets.deliver(target, schedule, 'run-one', '下書き', h.clock.now());
  assert.deepEqual(a, b);
  assert.equal(a.settingsRevision, chief.revision);
  assert.equal(h.runner.get(a.threadId!).permissionMode, 'ask');
  await tick();
  repo.archive(chief.id, chief.revision, h.runner.isoNow());
  assert.throws(() => targets.deliver(target, schedule, 'run-two', '次の下書き', h.clock.now()), /unavailable/);
  assert.equal(repo.conversations(chief.id).length, 1);
});

test('a Group pause withdraws only that schedule’s pending post, using the saved revision', async () => {
  const { h, chief, repo, groups, scheduler, future } = setup();
  const group = groups.create({ title: 'Editorial', teamId: repo.workspaceId(), adminId: chief.id, memberIds: [chief.id] });
  await groups.stop(group.id);
  const input = { text: '次の記事を準備', title: 'Draft', cron: '* * * * *', botTarget: { kind: 'group' as const, groupId: group.id } };
  const first = await scheduler.create(input);
  const second = await scheduler.create(input);
  await scheduler.runNow(first.id, 'full', true);
  await scheduler.runNow(second.id, 'full', true);
  assert.equal(groups.read(group.id).queued, 2);
  const revision = scheduler.find(first.id).updatedAt;
  await scheduler.update({ scheduleId: first.id, paused: true, botEdit: { expectedUpdatedAt: revision } });
  assert.equal(groups.read(group.id).queued, 1);
  await assert.rejects(scheduler.update({ scheduleId: first.id, paused: false, botEdit: { expectedUpdatedAt: revision } }), /changed/);
  await scheduler.delete(second.id, true);
  assert.equal(groups.read(group.id).queued, 0);
  const last = await scheduler.create({ ...input, cron: undefined, at: future, paused: true });
  assert.equal(last.paused, true);
  h.clock.advance(120_000);
  await assert.rejects(scheduler.update({ scheduleId: last.id, paused: false, botEdit: { expectedUpdatedAt: last.updatedAt } }), /future/);
  await assert.rejects(scheduler.runNow(first.id), /Bot schedule/);
});

test('the normal agent Schedule tools cannot list or look up a protected Bot schedule', async () => {
  const { chief, conversations, scheduler, future } = setup();
  const chat = conversations.create(chief.id, 'private-schedule-text');
  const regular = await scheduler.create({ title: 'Ordinary', text: 'Check a normal thread', threadId: chat.threadId, at: future });
  const bot = await scheduler.create({
    title: 'Bot note', text: 'Only my Bot schedule editor needs this', at: future,
    botTarget: { kind: 'conversation', botId: chief.id, conversationId: chat.id, threadId: chat.threadId },
  });
  const control = scheduleRouter(scheduler, () => undefined);
  assert.deepEqual((await control.list()).map(row => row.id), [regular.id]);
  assert.equal((await control.find(regular.id.slice(0, 12))).id, regular.id);
  await assert.rejects(async () => control.find(bot.id), /No schedule/);
  assert.equal(scheduler.botScheduleList()[0]?.id, bot.id);
});

test('a Bot sees and edits only schedules for its own chat when the same Bot has another conversation', async () => {
  const { chief, conversations, scheduler, future } = setup();
  const a = conversations.create(chief.id, 'source');
  const b = conversations.create(chief.id, 'other-chat');
  const target = { kind: 'conversation' as const, botId: chief.id, conversationId: a.id, threadId: a.threadId };
  const external = await scheduler.create({ text: 'Unrelated draft', at: future,
    botTarget: { ...target, conversationId: b.id, threadId: b.threadId },
  });
  const control = botConversationSchedules(scheduler, () => ({ target, ceiling: 'ask' }));
  await assert.rejects(control.create({ threadId: b.threadId, text: 'Different conversation', at: future }), /own conversation/);
  const own = await control.create({ threadId: a.threadId, text: 'My reminder', at: future, ceiling: 'full' });
  assert.equal(own.threadId, a.threadId);
  assert.equal(own.botCeiling, 'ask');
  assert.deepEqual((await control.list()).map(row => row.id), [own.id]);
  await assert.rejects(async () => control.find(external.id), /No schedule/);
  await assert.rejects(control.delete(external.id), /No schedule/);
  const paused = await control.update({ scheduleId: own.id, paused: true, botEdit: { expectedUpdatedAt: own.updatedAt } });
  assert.equal(paused.paused, true);
  await assert.rejects(control.update({ scheduleId: own.id, paused: false, botEdit: { expectedUpdatedAt: own.updatedAt } }), /changed/);
  assert.equal(scheduler.find(external.id).paused, false);
});
