// DS-Bot group-work.test.js parallel batch, partial result, restart and
// finalizing cases, adapted to the native CLI and approval fixture.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotGroups } from '../../../src/bots/groups.ts';
import { groupMethods } from '../../../src/bots/group-rpc.ts';
import { GroupStore } from '../../../src/bots/group-store.ts';
import { BotRepository } from '../../../src/bots/repository.ts';
import { TaskJournal } from '../../../src/bots/task-journal.ts';
import { BotTaskThreads } from '../../../src/bots/task-threads.ts';
import { atomicWriteFileSync } from '../../../src/fsutil.ts';
import { makeHarness, tick, tmpDir, type FakeSession } from '../../helpers/fakes.ts';

function fixture() {
  const home = tmpDir();
  const root = join(home, 'bots');
  let service: BotGroups;
  let tasks: BotTaskThreads;
  let handingOver = false;
  const h = makeHarness(home, {}, {
    botContext: rec => {
      if (rec.botLink?.taskId) tasks.active(rec);
      else service.threads.check(rec);
      return 'Group fixture instructions';
    },
    botGroupQueue: (id, ref) => service.queue(id, ref),
    botTaskQueue: (id, ref) => tasks.queue(id, ref),
  });
  const repo = new BotRepository(root, 'runner');
  const chief = repo.create({ name: 'Chief' });
  const writer = repo.create({ name: 'Writer' });
  const tester = repo.create({ name: 'Tester' });
  const journal = new TaskJournal(root, atomicWriteFileSync, () => {}, () => service?.activeCount() ?? 0);
  tasks = new BotTaskThreads({
    runner: h.runner, repo, journal,
    owns: () => true, parent: () => undefined, groupOrigin: rec => service.taskOrigin(rec),
    groupActive: task => service.taskActive(task), groupReply: task => service.taskReply(task),
  });
  const restore = () => service = new BotGroups({
    runner: h.runner, owns: () => true, store: new GroupStore(root, repo, kept => {
      if (handingOver && !kept) throw new Error('Wait for the Runner to finish handing over.');
    }), otherActive: () => journal.activeCount(),
    tasks: (id, roundId) => tasks.groupTasks(id, roundId), stopTasks: (id, threadIds) => tasks.stopGroup(id, threadIds),
  });
  const groups = restore();
  const draft = { teamId: repo.workspaceId(), adminId: chief.id, memberIds: [chief.id, writer.id, tester.id] };
  const group = groups.create({ ...draft, title: 'Desk' });
  return { h, chief, writer, tester, group, draft, restore, tasks, journal, service: () => service,
    handover: (waiting: boolean) => { handingOver = waiting; } };
}

function finish(session: FakeSession, reply: string) {
  session.text('answer', reply);
  session.result();
}

test('Group search pages the same saved events and ignores records without text', () => {
  const f = fixture();
  const groups = f.service();
  groups.store.change(f.group.id, book => {
    for (let i = 0; i < 21; i += 1) groups.store.append(book, 'post', f.h.runner.isoNow(), { text: `検索語 item ${i}` });
    groups.store.append(book, 'notice', f.h.runner.isoNow(), { reason: '検索語 item' });
  });
  const methods = groupMethods(() => groups, () => {});
  const search = (before?: number) => methods['bots.groups.find']({ groupId: f.group.id, query: '検索語 ITEM', before }) as {
    events: { seq: number; text: string }[]; hasMore: boolean;
  };
  const page = search();
  assert.equal(page.events.length, 20);
  assert.equal(page.events[0]?.text, '検索語 item 20');
  assert.equal(page.hasMore, true);
  const older = search(page.events.at(-1)?.seq);
  assert.deepEqual(older.events.map(row => row.text), ['検索語 item 0']);
  assert.equal(older.hasMore, false);
});

test('Chief delegates in parallel, preserves approval and output through recovery, and summarizes once', async () => {
  const f = fixture();
  const { h, group, chief, writer, tester } = f;
  let groups = f.service();
  assert.equal(h.adapter.sessions.length, 0, 'creation uses no Group model session');
  const post = groups.post(group.id, 'first', 'Draft a title');
  assert.equal(groups.post(group.id, 'first', 'Draft a title').eventId, post.eventId);
  await tick();
  const editor = h.adapter.last;
  editor.init();
  assert.throws(() => h.runner.send(editor.opts.threadId, 'Bypass the Group book'), /Group/);
  const batch = groups.delegate(editor.opts.threadId, 'batch', [writer.id, tester.id], 'Write and check the title');
  assert.equal(groups.delegate(editor.opts.threadId, 'batch', [writer.id, tester.id], 'Write and check the title').key, batch.key);
  await tick();
  assert.equal(h.adapter.sessions.length, 3);
  const work = groups.read(group.id).threads;
  assert.equal(work[chief.id].threadId, editor.opts.threadId);
  const writerSession = h.adapter.sessions.find(s => s.opts.threadId === work[writer.id].threadId)!;
  const testerSession = h.adapter.sessions.find(s => s.opts.threadId === work[tester.id].threadId)!;
  writerSession.init();
  testerSession.init();
  assert.throws(() => groups.delegate(testerSession.opts.threadId, 'cycle', [chief.id], 'Call Chief again'), /limit/);
  const approval = h.runner.requestAgentApproval(testerSession.opts.threadId, {
    name: 'mcp__threadbear__group_fixture', title: 'Approve the check', input: {},
  });
  const longResult = '承認待ちの間も読める日本語の結果。'.repeat(380) + ' Pinned checksum 検索語';
  finish(writerSession, longResult);
  finish(editor, 'Waiting for their results.');
  await tick();
  groups.recover();
  const partial = groups.read(group.id);
  const row = partial.events.find(event => event.kind === 'result' && event.memberId === writer.id);
  assert.ok(row);
  assert.deepEqual(groups.result(group.id, row.seq), { text: longResult, whole: true });
  assert.equal(partial.round?.slots.find(slot => slot.id === tester.id)?.status, 'speaking');
  assert.equal(editor.sent.length, 1);
  groups = f.restore();
  groups.recover();
  assert.equal(editor.sent.length, 1);
  const methods = groupMethods(() => groups, () => {});
  assert.deepEqual(methods['bots.groups.find']({ groupId: group.id, query: '検索語 CHECKSUM' }), {
    events: [row], hasMore: false,
  });
  assert.equal(groups.read(group.id).events.filter(event => event.memberId === writer.id).length, 1);
  const card = h.events(testerSession.opts.threadId).find(event => event.type === 'approval.requested');
  assert.ok(card);
  h.runner.respondApproval({ threadId: testerSession.opts.threadId, approvalId: card.approvalId, decision: 'allow' });
  assert.equal((await approval).decision, 'allow');
  finish(testerSession, 'The title passes.');
  await tick();
  groups.recover();
  await tick();
  const finalizing = groups.read(group.id);
  assert.equal(finalizing.round?.status, 'finalizing');
  assert.equal(finalizing.round?.slots.filter(slot => slot.summary).length, 1);
  assert.match(editor.sent.at(-1)?.text ?? '', /The title passes/);
  groups.post(group.id, 'next', 'Use the title');
  assert.equal(groups.read(group.id).queued, 1);
  groups = f.restore();
  groups.recover();
  assert.equal(editor.sent.length, 2);
  finish(editor, 'Here is the final title.');
  await tick();
  groups.recover();
  await tick();
  assert.equal(groups.read(group.id).events.filter(event => event.kind === 'summary').length, 1);
  assert.equal(groups.read(group.id).queued, 0);
  assert.match(editor.sent.at(-1)?.text ?? '', /Use the title/);
});

test('stopping one Group freezes later posts and leaves another Group session alone', async () => {
  const f = fixture();
  const { h, group, draft } = f;
  let groups = f.service();
  const other = groups.create({ ...draft, title: 'Independent' });
  groups.post(group.id, 'first', 'Start here');
  groups.post(other.id, 'other', 'Independent work');
  await tick();
  const threadId = groups.read(group.id).threads[f.chief.id].threadId;
  const member = h.adapter.sessions.find(s => s.opts.threadId === threadId)!;
  const separate = h.adapter.sessions.find(s => s.opts.threadId !== threadId)!;
  member.init();
  separate.init();
  groups.post(group.id, 'second', 'Wait for a deliberate resume');
  await groups.stop(group.id);
  assert.ok(member.killed);
  assert.equal(separate.killed, false);
  finish(member, 'Late reply');
  await tick();
  groups = f.restore();
  groups.recover();
  assert.equal(groups.read(group.id).frozen, true);
  assert.equal(groups.read(group.id).queued, 1);
  assert.ok(!groups.read(group.id).events.some(row => row.kind === 'result'));
});

test('a saved message calls both named members and ignores mentions in quoted context', async () => {
  const f = fixture();
  const { h, chief, group, writer, tester } = f;
  const groups = f.service();
  const source = groups.post(group.id, 'first', 'Discuss the title. Quoted from the last round: “@Writer”.');
  assert.deepEqual(source.mentions, []);
  assert.deepEqual(source.calleeIds, [chief.id]);
  await tick();
  const editor = h.adapter.last;
  editor.init();
  finish(editor, '@Writer @Tester check the title. See also `@Chief` and [a note](/@Chief).');
  await tick();
  groups.recover();
  await tick();
  const book = groups.read(group.id);
  assert.deepEqual(book.events.find(event => event.kind === 'batch')?.memberIds, [writer.id, tester.id]);
  assert.equal(book.round?.slots.filter(slot => slot.status === 'speaking').length, 2);
  assert.equal(h.adapter.sessions.length, 3);
});

test('native Tasks belong to the originating Group call, with a saved result or a scoped stop', async () => {
  for (const stopped of [false, true]) {
    const { h, group, tasks, service } = fixture();
    const groups = service();
    groups.post(group.id, 'first', 'Draft a title');
    await tick();
    const editor = h.adapter.last;
    editor.init();
    const task = await tasks.start(editor.opts.threadId, { title: 'Draft', brief: 'Propose a title', operationId: 'draft' }, async () => 'ask');
    assert.equal(task.group?.groupId, group.id);
    await tick();
    const worker = h.adapter.last;
    worker.init();
    assert.notEqual(worker.opts.threadId, editor.opts.threadId);
    finish(editor, 'The background draft is in progress.');
    await tick();
    groups.recover();
    assert.equal(groups.read(group.id).round?.status, 'running');
    assert.equal(groups.read(group.id).tasks[0]?.threadId, task.threadId);
    if (stopped) {
      await groups.stop(group.id);
      assert.equal(worker.killed, true);
      assert.equal(tasks.get(task.id).state.status, 'stopped');
    } else {
      finish(worker, '見出し案を保存しました。');
      await tick();
      tasks.recover();
      groups.recover();
      tasks.recover();
      groups.recover();
      const final = groups.read(group.id);
      assert.equal(final.round?.status, 'done');
      const rows = final.events.filter(row => row.kind === 'task-result');
      assert.equal(rows.length, 1);
      assert.deepEqual(groups.result(group.id, rows[0].seq), { text: '見出し案を保存しました。', whole: true });
    }
  }
});

test('the primary accepts delegated work from the same kept Group turn once', async () => {
  const { h, group, writer, service, handover } = fixture();
  const groups = service();
  groups.post(group.id, 'first', 'Draft a title');
  await tick();
  const editor = h.adapter.last;
  editor.init();
  const source = h.runner.threads.get(editor.opts.threadId)!;
  const turnId = source.rt.turn!.turnId;
  handover(true);
  assert.throws(() => groups.stop(group.id), /finish handing over/);
  assert.throws(() => groups.delegateKept(source.rec, 'wrong-turn', 'kept', [writer.id], 'Draft'), /cannot delegate/);
  const first = groups.delegateKept(source.rec, turnId, 'kept', [writer.id], 'Draft');
  const retry = groups.delegateKept(source.rec, turnId, 'kept', [writer.id], 'Draft');
  assert.deepEqual(retry, first);
  assert.equal(groups.read(group.id).events.filter(row => row.kind === 'batch').length, 1);
  assert.equal(h.adapter.sessions.length, 1);
  handover(false);
  groups.recover();
  await tick();
  assert.equal(h.adapter.sessions.length, 2);
});

test('Group calls and background tasks use the same four slots', () => {
  const { h, group, writer, tester, draft, journal, service } = fixture();
  const groups = service();
  const second = groups.create({ ...draft, title: 'Second group' });
  const third = groups.create({ ...draft, title: 'Third group' });
  const task = (botId: string, operationId: string) => journal.reserve({
    botId, sourceThreadId: botId, sourceConversationId: botId, title: 'Notes', brief: 'Check the copy', operationId,
  }, h.runner.isoNow());
  const a = task(writer.id, 'first');
  task(tester.id, 'second');
  for (const row of [group, second, third]) groups.post(row.id, 'start', 'Review the language.');
  groups.recover();
  assert.equal(groups.activeCount(), 2);
  assert.equal(groups.read(third.id).round?.slots[0]?.status, 'waiting');
  assert.equal(task(writer.id, 'first').id, a.id, 'a retry uses its already reserved slot');
  assert.throws(() => task(writer.id, 'third'), /workspace or Bot/);
  journal.finish(a.id, a.revision, h.runner.isoNow(), 'stopped', 'Stopped by the user', undefined, false);
  groups.recover();
  assert.equal(groups.activeCount(), 3);
  assert.equal(journal.activeCount(), 1);
});
