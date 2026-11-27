import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BOT_ABANDON_FORMAT } from '../../../src/bots/format.ts';
import { RequestStateStore } from '../../../src/bots/request-state.ts';
import { archive, sha256, unarchive } from '../../../src/move-pack.ts';
import { BotRepository } from '../../../src/bots/repository.ts';
import { BotConversations } from '../../../src/bots/conversations.ts';
import { atomicWriteFileSync } from '../../../src/fsutil.ts';
import { TaskJournal } from '../../../src/bots/task-journal.ts';
import { GroupStore } from '../../../src/bots/group-store.ts';
import { packWorkspaceThread, workspaceThreadFiles } from '../../../src/bots/workspace-threads.ts';
import { BotWorkspaceTransfer } from '../../../src/bots/workspace-transfer.ts';
import { makeHarness, tmpDir } from '../../helpers/fakes.ts';

const moveId = 'move-1';
const source = 'source-mac';
const target = 'target-mac';

test('the source stays frozen across restart, stages the same archive, and cannot reopen after a claim', () => {
  const home = tmpDir();
  const repository = new BotRepository(join(home, 'bots'), source);
  const bot = repository.create({ name: 'Japanese copy desk', instructions: '原稿の見出しを確認してください' });
  const identity = repository.workspaceIdentity();
  assert.throws(() => new BotWorkspaceTransfer(home, source, () => {}).freeze({
    moveId, identity, target, idle: () => false, threadFiles: [],
  }), /active work/);
  assert.equal(new BotWorkspaceTransfer(home, source, () => {}).blocked(), false);
  const original = new BotWorkspaceTransfer(home, source, () => {});
  const threadFiles = [{ path: 'threads/id-fixture/history.jsonl', data: Buffer.from('{"text":"修正済み"}\n') }];
  const pack = original.freeze({ moveId, identity, target, idle: () => true, threadFiles });
  const reopened = new BotWorkspaceTransfer(home, source, () => {});
  assert.equal(reopened.blocked(), true);
  assert.deepEqual(reopened.freeze({ moveId, identity, target, idle: () => false, threadFiles: [] }), pack);
  const otherHome = tmpDir();
  const receiver = new BotWorkspaceTransfer(otherHome, target, () => {});
  assert.throws(() => receiver.stage({ moveId, checksum: '0'.repeat(64), packed: pack.packed }), /checksum/);
  const staged = receiver.stage({ moveId, ...pack });
  assert.equal(staged.identity.workspaceId, identity.workspaceId);
  assert.equal(receiver.blocked(), true);
  assert.equal(existsSync(join(otherHome, 'bots', 'state.json')), false, 'the staged transfer is not the normal workspace');
  assert.throws(() => receiver.accept({ state: 'claimed', workspaceId: identity.workspaceId, moveId, ownerRunnerId: target, epoch: identity.epoch }, moveId), /saved claim/);
  const proof = { state: 'claimed' as const, workspaceId: identity.workspaceId, moveId, ownerRunnerId: target, epoch: identity.epoch + 1 };
  assert.throws(() => receiver.accept({ ...proof, workspaceId: 'other-workspace' }, moveId), /saved claim/);
  const after = receiver.accept(proof, moveId);
  assert.equal(after.workspaceId, identity.workspaceId);
  assert.deepEqual(new BotRepository(join(otherHome, 'bots'), target).get(bot.id), bot);
  assert.equal(readFileSync(join(otherHome, 'threads', 'id-fixture', 'history.jsonl'), 'utf8'), '{"text":"修正済み"}\n');
  assert.deepEqual(new BotWorkspaceTransfer(otherHome, target, () => {}).accept(proof, moveId), after);
  assert.equal(receiver.blocked(), false);
  reopened.closeSource(proof, moveId);
  assert.equal(new BotWorkspaceTransfer(home, source, () => {}).blocked(), true);
  assert.throws(() => reopened.closeSource({ state: 'cancelled', workspaceId: identity.workspaceId, moveId, ownerRunnerId: source, epoch: identity.epoch }, moveId), /already moved/);
});

test('detaching Projects leaves their notes at the source and carries Team notes', () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  const repo = new BotRepository(root, source);
  repo.create({ name: 'Editor' });
  const identity = repo.workspaceIdentity();
  const project = 'memory/project-' + randomUUID();
  const team = 'memory/team-' + identity.workspaceId;
  for (const folder of [project, team]) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'memory.md'), folder);
  }
  const sourceStore = new BotWorkspaceTransfer(home, source, () => {});
  const pack = sourceStore.freeze({ moveId, identity, target, idle: () => true, threadFiles: [] });
  const dest = tmpDir();
  const receiver = new BotWorkspaceTransfer(dest, target, () => {});
  const staged = receiver.stage({ moveId, ...pack });
  assert.ok(!staged.files.some(entry => entry.path.startsWith('bots/' + project + '/')));
  receiver.accept({ moveId, workspaceId: identity.workspaceId, ownerRunnerId: target, epoch: identity.epoch + 1, state: 'claimed' }, moveId);
  assert.equal(readFileSync(join(dest, 'bots', team, 'memory.md'), 'utf8'), team);
  assert.equal(readFileSync(join(root, project, 'memory.md'), 'utf8'), project);
});

test('an explicit Project assignment carries notes under the chosen ID and requires every source choice', () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  const repo = new BotRepository(root, source);
  repo.create({ name: 'Editor' });
  const identity = repo.workspaceIdentity();
  for (const id of ['p_source', 'p_keep', 'p_skip']) {
    const folder = join(root, 'memory', 'project-' + id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'memory.md'), id);
  }
  const transfer = new BotWorkspaceTransfer(home, source, () => {});
  const move = { moveId, identity, target, idle: () => true, threadFiles: [] };
  assert.throws(() => transfer.freeze({ ...move, projects: { assign: { p_source: 'p_target' } } }), /Choose what happens/);
  const projects = { assign: { p_source: 'p_target', p_keep: 'p_keep', p_skip: null } };
  const packed = transfer.freeze({ ...move, projects });
  const dest = tmpDir();
  const receiver = new BotWorkspaceTransfer(dest, target, () => {});
  assert.deepEqual(receiver.stage({ moveId, ...packed }).projects, projects);
  receiver.accept({ moveId, workspaceId: identity.workspaceId, ownerRunnerId: target, epoch: identity.epoch + 1, state: 'claimed' }, moveId);
  const notes = join(dest, 'bots', 'memory');
  assert.equal(readFileSync(join(notes, 'project-p_target', 'memory.md'), 'utf8'), 'p_source');
  assert.equal(readFileSync(join(notes, 'project-p_keep', 'memory.md'), 'utf8'), 'p_keep');
  assert.equal(existsSync(join(notes, 'project-p_skip')), false);
  assert.equal(existsSync(join(notes, 'project-p_source')), false);
});

test('only a verified cancellation can reopen the frozen source and it leaves all local files untouched', () => {
  const home = tmpDir();
  const repo = new BotRepository(join(home, 'bots'), source);
  repo.create({ name: 'Editor' });
  const identity = repo.workspaceIdentity();
  const original = readFileSync(join(home, 'bots', 'state.json'), 'utf8');
  const transfer = new BotWorkspaceTransfer(home, source, () => {});
  transfer.freeze({ moveId, identity, target, idle: () => true, threadFiles: [] });
  assert.throws(() => transfer.closeSource({ state: 'cancelled', workspaceId: identity.workspaceId, moveId, ownerRunnerId: target, epoch: identity.epoch }, moveId), /saved claim/);
  assert.equal(transfer.blocked(), true);
  transfer.closeSource({ state: 'cancelled', workspaceId: identity.workspaceId, moveId, ownerRunnerId: source, epoch: identity.epoch }, moveId);
  assert.equal(transfer.blocked(), false);
  assert.equal(readFileSync(join(home, 'bots', 'state.json'), 'utf8'), original);
});

test('a claim does not overwrite a different local workspace or an existing Thread', () => {
  const home = tmpDir();
  const repo = new BotRepository(join(home, 'bots'), source);
  repo.create({ name: 'Editor' });
  const identity = repo.workspaceIdentity();
  const files = [{ path: 'threads/id-fixture/history.jsonl', data: Buffer.from('new') }];
  const packed = new BotWorkspaceTransfer(home, source, () => {}).freeze({ moveId, identity, target, idle: () => true, threadFiles: files });
  const otherHome = tmpDir();
  const other = new BotWorkspaceTransfer(otherHome, target, () => {});
  other.stage({ moveId, ...packed });
  writeFileSync(join(otherHome, 'conflict'), 'untouched');
  new BotRepository(join(otherHome, 'bots'), target).create({ name: 'Another workspace' });
  assert.throws(() => other.accept({ state: 'claimed', workspaceId: identity.workspaceId, moveId, ownerRunnerId: target, epoch: identity.epoch + 1 }, moveId), /another workspace/);
  assert.equal(readFileSync(join(otherHome, 'conflict'), 'utf8'), 'untouched');
  assert.equal(other.blocked(), true);
});

test('freezing starts before asynchronously gathering CLI files and can be abandoned before any offer', async () => {
  const home = tmpDir();
  const repo = new BotRepository(join(home, 'bots'), source);
  repo.create({ name: 'Editor' });
  const identity = repo.workspaceIdentity();
  const row = { moveId, target, identity, idle: () => true };
  const store = new BotWorkspaceTransfer(home, source, () => {});
  store.prepare(row);
  const reopened = new BotWorkspaceTransfer(home, source, () => {});
  assert.equal(reopened.blocked(), true);
  assert.equal(reopened.progress()?.state, 'preparing');
  reopened.prepare({ ...row, idle: () => false });
  assert.throws(() => reopened.prepare({ ...row, moveId: 'other' }), /already/);
  reopened.abandonPreparation(moveId);
  assert.equal(reopened.blocked(), false);
  assert.equal(new BotRepository(join(home, 'bots'), source).workspaceIdentity().epoch, identity.epoch);
});

test('a workspace with a saved Bot conversation cannot lose it by freezing an incomplete pack', () => {
  const { home, runner } = makeHarness(tmpDir());
  const root = join(home, 'bots');
  const repo = new BotRepository(root, source);
  const bot = repo.create({ name: 'Editor' });
  const chat = new BotConversations(runner, repo, root).create(bot.id, 'original');
  const transfer = new BotWorkspaceTransfer(home, source, () => {});
  assert.throws(() => transfer.freeze({
    moveId, identity: repo.workspaceIdentity(), target, idle: () => true, threadFiles: [],
  }), /missing a Bot conversation/);
  assert.equal(transfer.progress()?.state, 'preparing');
  transfer.abandonPreparation(moveId);
  assert.equal(transfer.blocked(), false);
  assert.deepEqual(repo.conversations(bot.id), [chat]);
  assert.equal(runner.store.load(chat.threadId)?.botLink?.conversationId, chat.id);
});

test('a transfer preserves the saved conversation of a Group member', async () => {
  const { home, runner } = makeHarness(tmpDir());
  const root = join(home, 'bots');
  const repo = new BotRepository(root, source);
  const bot = repo.create({ name: 'Editor' });
  const groupStore = new GroupStore(root, repo, () => {});
  const group = groupStore.create({ title: 'Desk', teamId: repo.workspaceId(), memberIds: [bot.id], adminId: bot.id });
  const link = { id: randomUUID(), threadId: randomUUID(), sessionId: randomUUID() };
  groupStore.change(group.id, book => { book.threads[bot.id] = link; });
  runner.makeThread({ text: '', title: 'Editorial history', worktree: false }, {
    id: link.threadId, sessionId: link.sessionId,
    botLink: { botId: bot.id, groupId: group.id, conversationId: link.id },
  });
  const identity = repo.workspaceIdentity();
  const transfer = new BotWorkspaceTransfer(home, source, () => {});
  const move = { moveId, identity, target, idle: () => true };
  assert.throws(() => transfer.freeze({ ...move, threadFiles: [] }), /missing a Group conversation/);

  const thread = await packWorkspaceThread(runner, transfer, identity, link.threadId, {
    moveId, target, projects: 'detach',
  }, candidate => candidate.groupId === group.id);
  assert.throws(() => transfer.freeze({
    ...move, threadFiles: workspaceThreadFiles({ ...thread, link: { ...thread.link, groupId: randomUUID() } }),
  }), /Group conversation.*saved identity/);
  const extraId = randomUUID();
  const unlisted = {
    ...thread, row: { ...thread.row, threadId: extraId },
    link: { ...thread.link, conversationId: randomUUID() },
  };
  assert.throws(() => transfer.freeze({
    ...move, threadFiles: [thread, unlisted].flatMap(workspaceThreadFiles),
  }), /undeclared Bot Thread/);
  const pack = transfer.freeze({ ...move, threadFiles: workspaceThreadFiles(thread) });
  const received = new BotWorkspaceTransfer(tmpDir(), target, () => {});
  assert.equal(received.stage({ moveId, ...pack }).files.some(file => file.path === `moves/${link.threadId}/files.pack`), true);
});

test('workspace moves preserve materialized task Threads and leave stopped reservations as history only', async () => {
  const { home, runner } = makeHarness(tmpDir());
  const root = join(home, 'bots');
  const repo = new BotRepository(root, source);
  const bot = repo.create({ name: 'Editor' });
  const tasks = new TaskJournal(root, atomicWriteFileSync, () => {});
  const now = runner.isoNow();
  const init = {
    botId: bot.id, sourceThreadId: randomUUID(), sourceConversationId: randomUUID(),
    title: 'Check a heading', brief: 'Use a short heading.',
  };
  const stopped = tasks.reserve({ ...init, operationId: 'never-started' }, now);
  tasks.finish(stopped.id, stopped.revision, now, 'stopped', 'Stopped before opening.', undefined, false);
  const active = tasks.reserve({ ...init, operationId: 'review' }, now);
  const identity = repo.workspaceIdentity();
  const transfer = new BotWorkspaceTransfer(home, source, () => {});
  const move = { moveId, identity, target, idle: () => true };
  const pendingMoveId = 'pending-' + moveId;
  assert.throws(() => transfer.freeze({ ...move, moveId: pendingMoveId, threadFiles: [] }), /Finish or stop/);
  transfer.abandonPreparation(pendingMoveId);
  const link = { botId: bot.id, conversationId: active.id, taskId: active.id };
  runner.makeThread({ text: '', title: 'Editorial task', worktree: false }, {
    id: active.threadId, sessionId: active.nativeSessionId, botLink: link,
  });
  const queued = tasks.progress(active.id, active.revision, now, { status: 'queued', turnId: 'work-input' });
  tasks.finish(queued.id, queued.revision, now, 'completed', '確認済み', undefined, false);

  const opened = tasks.reserve({ ...init, operationId: 'opened-before-stop' }, now);
  runner.makeThread({ text: '', title: 'Opened task', worktree: false }, {
    id: opened.threadId, sessionId: opened.nativeSessionId,
    botLink: { botId: bot.id, conversationId: opened.id, taskId: opened.id },
  });
  tasks.finish(opened.id, opened.revision, now, 'stopped', 'Stopped before the first input.', undefined, false);

  assert.throws(() => transfer.freeze({ ...move, threadFiles: [] }), /missing a Bot task/);
  const collect = (task: typeof active) => packWorkspaceThread(runner, transfer, identity, task.threadId,
    { moveId, target, projects: 'detach' }, candidate => candidate.taskId === task.id);
  const thread = await collect(active);
  assert.throws(() => transfer.freeze({
    ...move, threadFiles: workspaceThreadFiles({ ...thread, link: { ...thread.link, taskId: stopped.id } }),
  }), /Bot task.*saved identity/);
  assert.throws(() => transfer.freeze({ ...move, threadFiles: workspaceThreadFiles(thread) }), /missing a Bot task/);
  const pack = transfer.freeze({ ...move, threadFiles: [thread, await collect(opened)].flatMap(workspaceThreadFiles) });
  const dest = tmpDir();
  const received = new BotWorkspaceTransfer(dest, target, () => {});
  assert.equal(received.stage({ moveId, ...pack }).files.some(file => file.path === `moves/${active.threadId}/files.pack`), true);
  const proof = { moveId, workspaceId: identity.workspaceId, ownerRunnerId: target, epoch: identity.epoch + 1, state: 'claimed' as const };
  received.accept(proof, moveId);
  const recovered = new TaskJournal(join(dest, 'bots'), atomicWriteFileSync, () => {});
  const persisted = new TaskJournal(root, atomicWriteFileSync, () => {});
  assert.deepEqual(recovered.get(active.id), persisted.get(active.id));
  assert.deepEqual(recovered.get(opened.id), persisted.get(opened.id));
  assert.deepEqual(recovered.get(stopped.id), persisted.get(stopped.id));
});

test('an abandoned request upgrades the transfer before claiming and cannot be disguised as an old envelope', () => {
  const home = tmpDir();
  const root = join(home, 'bots');
  const repo = new BotRepository(root, source);
  const [chief, editor, reader] = ['Chief', 'Editor', 'Reader'].map(name => repo.create({ name }));
  const identity = repo.workspaceIdentity();
  const requests = new RequestStateStore(root, () => {});
  const parent = requests.admit({
    id: 'root', when: 'queue', acceptedAt: new Date(0).toISOString(),
    sourceBotId: chief.id, sourceThreadId: 'chief-thread', sourceConversationId: 'chief-conversation',
    targetBotId: editor.id, targetThreadId: 'editor-thread', targetConversationId: 'editor-conversation',
  });
  const child = requests.admit({
    id: 'child', parentRequestId: parent.id, when: 'queue', acceptedAt: parent.acceptedAt,
    sourceBotId: editor.id, sourceThreadId: parent.targetThreadId, sourceConversationId: parent.targetConversationId,
    targetBotId: reader.id, targetThreadId: 'reader-thread', targetConversationId: 'reader-conversation',
  });
  requests.advance(child.id, child.revision, { status: 'abandoned', notice: 'pending', text: 'No reply came back.' });
  assert.throws(() => requests.admit({
    id: 'grandchild', parentRequestId: child.id, when: 'queue', acceptedAt: parent.acceptedAt,
    sourceBotId: reader.id, sourceThreadId: child.targetThreadId, sourceConversationId: child.targetConversationId,
    targetBotId: 'tester', targetThreadId: 'tester-thread', targetConversationId: 'tester-conversation',
  }), /cannot delegate/);
  const pack = new BotWorkspaceTransfer(home, source, () => {}).freeze({
    moveId, identity, target, idle: () => true, threadFiles: [],
  });
  const dest = tmpDir();
  const oldSupervisor = new BotWorkspaceTransfer(dest, target, format => {
    if (format === BOT_ABANDON_FORMAT) throw new Error('This supervisor cannot stage abandoned requests.');
  });
  assert.throws(() => oldSupervisor.stage({ moveId, ...pack }), /cannot stage/);
  assert.equal(oldSupervisor.progress(), undefined);
  assert.equal(existsSync(join(dest, 'bots', 'requests.json')), false);
  const [first, ...files] = unarchive(pack.packed);
  const packed = archive([{ ...first, data: Buffer.from(JSON.stringify({ ...JSON.parse(first.data.toString()), format: 1 })) }, ...files]);
  const protections: (number | undefined)[] = [];
  const receiver = new BotWorkspaceTransfer(dest, target, format => { protections.push(format); });
  assert.throws(() => receiver.stage({ moveId, packed, checksum: sha256(packed) }), /does not declare/);
  assert.equal(receiver.stage({ moveId, ...pack }).format, 2);
  assert.equal(protections[0], BOT_ABANDON_FORMAT);
  receiver.accept({ moveId, workspaceId: identity.workspaceId, ownerRunnerId: target, epoch: identity.epoch + 1, state: 'claimed' }, moveId);
  assert.deepEqual(new RequestStateStore(join(dest, 'bots'), () => {}).get(child.id), requests.get(child.id));
});
