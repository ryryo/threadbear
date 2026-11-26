import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotConversations } from '../../../src/bots/conversations.ts';
import { BotRepository } from '../../../src/bots/repository.ts';
import { BotRequests } from '../../../src/bots/request-service.ts';
import { TaskJournal } from '../../../src/bots/task-journal.ts';
import { BotTaskThreads } from '../../../src/bots/task-threads.ts';
import { atomicWriteFileSync } from '../../../src/fsutil.ts';
import { makeHarness, tick, tmpDir } from '../../helpers/fakes.ts';

test('a native background Task has one separate Thread and returns its saved result to its origin', async () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  let conversations: BotConversations;
  let service: BotTaskThreads;
  const h = makeHarness(home, {}, {
    botContext: rec => {
      if (!rec.botLink?.taskId) return conversations.context(rec);
      service.check(rec);
      return 'Bot task fixture instructions';
    },
    botTaskQueue: (id, ref) => service.queue(id, ref),
  });
  const repo = new BotRepository(root, 'runner');
  conversations = new BotConversations(h.runner, repo, root);
  const bot = repo.create({ name: '編集者' });
  const origin = conversations.create(bot.id, 'foreground');
  const makeService = (runner = h.runner) => new BotTaskThreads({
    runner, repo, journal: new TaskJournal(root, atomicWriteFileSync, () => {}),
    owns: () => true, parent: () => undefined,
  });
  service = makeService();
  h.runner.send(origin.threadId, 'Continue the foreground conversation');
  await tick();
  const foreground = h.adapter.last;
  foreground.init();
  const request = { operationId: 'same', title: '見出し', brief: '修正案を出す' };
  const [task, duplicate] = await Promise.all([
    service.start(origin.threadId, request, async () => 'full'),
    service.start(origin.threadId, request, async () => 'full'),
  ]);
  assert.equal(duplicate.id, task.id);
  assert.notEqual(task.threadId, origin.threadId);
  assert.deepEqual(repo.conversations(bot.id).map(row => row.threadId), [origin.threadId]);
  await tick();
  const worker = h.adapter.last;
  worker.init();
  assert.equal(worker.opts.threadId, task.threadId);
  const approval = h.runner.requestAgentApproval(task.threadId, {
    name: 'mcp__threadbear__task_fixture', title: 'Approve this task step', input: { step: 'Check a title' },
  });
  await tick();
  const card = h.events(task.threadId).find(event => event.type === 'approval.requested');
  assert.ok(card);
  assert.ok(!h.events(origin.threadId).some(event => event.type === 'approval.requested'));
  h.runner.respondApproval({ threadId: task.threadId, approvalId: card.approvalId, decision: 'allow' });
  assert.equal((await approval).decision, 'allow');
  const full = '背景Taskの長い日本語の答え。'.repeat(400);
  worker.text('answer', full);
  worker.result();
  await tick();
  service.recover(task.threadId);
  assert.deepEqual(service.taskResult(task.id).result, { text: full, whole: true });
  assert.equal(foreground.sent.length, 1);
  assert.equal(h.store.load(origin.threadId)?.queue.filter(input => input.botInput?.task?.id === task.id).length, 1);
  service.recover(task.threadId);
  assert.equal(h.store.load(origin.threadId)?.queue.filter(input => input.botInput?.task?.id === task.id).length, 1);
  foreground.result();
  await tick();
  assert.equal(foreground.sent.filter(input => input.text.includes('Background task')).length, 1);
});


test('a delegated request waits for a background task, or stops that task when the parent is cancelled', async () => {
  for (const cancel of [false, true]) {
    const home = tmpDir();
    const root = join(home, 'bots');
    let conversations: BotConversations;
    let tasks: BotTaskThreads;
    let requests: BotRequests;
    const h = makeHarness(home, {}, {
      botContext: rec => conversations.context(rec, rec.botLink?.taskId ? tasks.check(rec) : undefined),
      botTaskQueue: (id, ref) => tasks.queue(id, ref),
      botRequestQueue: (id, ref) => requests.queue(id, ref),
    });
    const repo = new BotRepository(root, 'runner');
    conversations = new BotConversations(h.runner, repo, root);
    const bot = repo.create({ name: 'Editor' });
    const worker = repo.create({ name: 'Writer' });
    const source = conversations.create(bot.id, 'source');
    const receiver = conversations.create(worker.id, 'receiver');
    tasks = new BotTaskThreads({
      runner: h.runner, repo, journal: new TaskJournal(root, atomicWriteFileSync, () => {}), owns: () => true,
      parent: id => requests.currentParent(id), childRequests: id => requests.pendingFrom(id), parentCancelled: id => requests.cancelled(id),
    });
    requests = new BotRequests({
      root, runner: h.runner, repo, owns: () => true, protect: () => {}, warn: () => {},
      task: id => tasks.get(id), childTasks: id => tasks.children(id),
      onCancel: row => tasks.recover(row.targetThreadId),
    });
    const parent = await requests.sendOwner(source.threadId, { to: worker.id, name: 'outline', when: 'queue', text: 'Make an outline with a background draft' });
    await tick();
    const writer = h.adapter.last;
    writer.init();
    const task = await tasks.start(receiver.threadId, { operationId: 'background', title: 'Outline', brief: 'Draft an outline' }, async () => 'full');
    assert.equal(task.originRequestId, parent.requestId);
    await tick();
    const background = h.adapter.last;
    background.init();
    writer.text('waiting', 'The draft is in progress.');
    writer.result();
    await tick();
    requests.recover(receiver.threadId);
    const row = requests.ownerGet(source.threadId, parent.requestId);
    assert.notEqual(row.state.status, 'returned');
    if (cancel) {
      requests.ownerCancel(source.threadId, row.id, row.revision);
      await tick();
      assert.equal(background.killed, true);
      assert.throws(() => h.runner.send(task.threadId, 'Continue the stopped task'), /no longer accepting messages/);
      assert.equal(tasks.get(task.id).state.status, 'stopped');
      assert.equal(writer.sent.length, 1);
    } else {
      background.text('draft', 'Use this outline.');
      background.result();
      await tick();
      tasks.recover(task.threadId);
      await tick();
      assert.match(writer.sent.at(-1)?.text ?? '', /Use this outline/);
      writer.text('final', 'Here is the final outline.');
      writer.result();
      await tick();
      requests.recover(receiver.threadId);
      assert.deepEqual(requests.ownerRead(source.threadId, parent.requestId).result, { text: 'Here is the final outline.', whole: true });
    }
  }
});

// DS-Bot bot-tasks.test.js L691–705, using the native approval and CLI job fixture.
test('stopTask cancels approvals, jobs and the task agent even when saving fails', async () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  let conversations: BotConversations;
  let tasks: BotTaskThreads;
  const h = makeHarness(home, {}, {
    botContext: rec => conversations.context(rec, rec.botLink?.taskId ? tasks.active(rec) : undefined),
    botTaskQueue: (id, ref) => tasks.queue(id, ref),
  });
  const repo = new BotRepository(root, 'runner');
  conversations = new BotConversations(h.runner, repo, root);
  const bot = repo.create({ name: 'Editor' });
  const origin = conversations.create(bot.id, 'origin');
  let noSpace = false;
  const journal = new TaskJournal(root, (file, body, mode) => {
    if (noSpace) throw new Error('ENOSPC: no space left on device');
    atomicWriteFileSync(file, body, mode);
  }, () => {});
  tasks = new BotTaskThreads({ runner: h.runner, repo, journal, owns: () => true, parent: () => undefined });
  h.runner.send(origin.threadId, 'Continue editing');
  await tick();
  const foreground = h.adapter.last;
  foreground.init();
  const task = await tasks.start(origin.threadId, { operationId: 'disk-full', title: 'Disk full stop', brief: 'Long command' }, async () => 'ask');
  await tick();
  const taskAgent = h.adapter.last;
  taskAgent.init();
  taskAgent.out({ kind: 'tasks', tasks: [{ id: 'j-disk-full', type: 'local_bash', kind: 'shell', description: 'Long command' }] });
  const approval = h.runner.requestAgentApproval(task.threadId, { name: 'mcp__threadbear__fixture', title: 'Approve another step', input: {} });
  const st = h.runner.threads.get(task.threadId)!;
  assert.equal(st.rt.tasks[0]?.id, 'j-disk-full');
  assert.equal(st.rt.approvals.size, 1);
  noSpace = true;
  assert.deepEqual(await tasks.cancel(task.id, task.revision), { stopped: true, saved: false });
  assert.equal((await approval).decision, 'expired');
  assert.equal(st.rt.tasks.length, 0, 'jobs must still be stopped when saving fails');
  assert.equal(taskAgent.killed, true, 'agent must still be cancelled when saving fails');
  assert.equal(foreground.killed, false);
});
