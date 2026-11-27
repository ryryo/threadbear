import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotRepository } from '../../src/bots/repository.ts';
import { BotWorkspaceWire, connectNativeWorkspaceRunner } from '../../src/bots/workspace-wire.ts';
import { backupMemoryRestoreInput, listManagedMemoryBackups, readManagedMemoryBackup, scopedBackupNotes, selectBackupMemoryNote } from '../../src/bots/managed-memory-restore.ts';
import { BotWorkspaceTransfer } from '../../src/bots/workspace-transfer.ts';
import { BotConversations } from '../../src/bots/conversations.ts';
import { PersonalMemory } from '../../src/bots/ported/personal-memory.js';
import { FakeClock } from '../../src/clock.ts';
import { GroupStore } from '../../src/bots/group-store.ts';
import { nullLogger } from '../../src/log.ts';
import { archive, readTree, sha256 as digest } from '../../src/move-pack.ts';
import { Projects } from '../../src/projects.ts';
import { SecretStore } from '../../src/secrets.ts';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { test } from 'node:test';
import { call, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const SOURCE = 'source-mac';
const TARGET = 'target-mac';
const OTHER = 'other-mac';
const WORKSPACE = 'bot-workspace';
const DIGEST = '7'.repeat(64);
const RELEASE = 'current-release';
const edit = {
  workspaceId: WORKSPACE, epoch: 1, botId: 'bot-id', expectedRevision: 1,
  operationId: 'device-edit', settings: { role: 'Review' },
};

const moves = load('botWorkspaceMoves');
const sync = load('sync');
const phone = load('phone');
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };

async function fixture(workspaceId = WORKSPACE, checksum = DIGEST, sealed: Buffer = Buffer.from('sealed fixture'), threadIds: string[] = []) {
  const b = memoryBackend();
  process.env.RUNNER_KEY = 'fixture-owner-key';
  delete process.env.RUNNER_KEY_NEXT;
  const key = (runnerId: string) => `tbr_${runnerId}`;
  for (const runnerId of [SOURCE, TARGET, OTHER]) {
    await b.ctx.db.insert('runnerKeys', { runnerId, keyHash: await sha256(key(runnerId)), name: runnerId, createdAt: 1 });
    await b.ctx.db.insert('runners', { runnerId, name: runnerId, version: 'test', startedAt: RELEASE, draining: false, threadCount: 0, lastSeenAt: Date.now() });
  }
  const token = 'fixture-device';
  await b.ctx.db.insert('tokens', { hash: await sha256(token), name: 'iphone', kind: 'phone', expiresAt: Date.now() + 600_000, createdAt: Date.now() });
  const projection = (ownerRunnerId: string, epoch: number) => ({
    workspaceId, ownerRunnerId, epoch,
    profiles: [{ id: 'bot-id', name: 'Editor', role: '', instructions: '', revision: 1 }],
    notes: [], groups: [], tasks: [], requests: [],
  });
  const publish = (runnerId: string, epoch: number) => call(b.ctx, sync.setBotWorkspace, {
    key: key(runnerId), runnerId, startedAt: RELEASE, workspace: projection(runnerId, epoch),
  });
  await publish(SOURCE, 1);
  const request = { workspaceId, moveId: 'move-1', epoch: 1, targetRunnerId: TARGET, checksum, bytes: sealed.length, parts: 1, sealedChecksum: digest(sealed), threadIds };
  return {
    ...b,
    key,
    invoke: (id: string, method: string, args: Record<string, unknown>) =>
      call(b.ctx, moves[method.split(':')[1]], { key: key(id), runnerId: id, startedAt: RELEASE, ...args }),
    begin: (runnerId = SOURCE) => call(b.ctx, moves.begin, { key: key(runnerId), runnerId, startedAt: RELEASE, ...request }),
    upload: (runnerId = SOURCE, data = sealed.toString('base64')) => call(b.ctx, moves.putPart, {
      key: key(runnerId), runnerId, startedAt: RELEASE, workspaceId, moveId: request.moveId, index: 0, data,
    }),
    part: (runnerId = TARGET) => call(b.ctx, moves.part, {
      key: key(runnerId), runnerId, startedAt: RELEASE, workspaceId, moveId: request.moveId, index: 0,
    }),
    claim: (runnerId = TARGET, stagedChecksum = checksum) => call(b.ctx, moves.claim, {
      key: key(runnerId), runnerId, startedAt: RELEASE, workspaceId, moveId: request.moveId, checksum: stagedChecksum,
    }),
    cancel: (runnerId = SOURCE) => call(b.ctx, moves.cancel, {
      key: key(runnerId), runnerId, startedAt: RELEASE, workspaceId, moveId: request.moveId,
    }),
    queueEdit: () => call(b.ctx, phone.editBotProfile, { token, runnerId: SOURCE, edit }),
    deviceList: () => call(b.ctx, phone.botWorkspaces, { token }),
    publish,
  };
}

test('only the active workspace owner can list active destination Projects', async () => {
  const t = await fixture();
  for (const [runnerId, id, title, archived] of [
    [SOURCE, 'source', 'Source desk', false],
    [TARGET, 'next', 'Next desk', false],
    [TARGET, 'old', 'Old desk', true],
  ] as const) {
    await t.ctx.db.insert('projectHeads', {
      runnerId, id, title, archived, createdBy: 'mike', createdAt: '2026-01-01', updatedAt: '2026-01-01', threadCount: 0,
    });
  }
  const targets = { workspaceId: WORKSPACE, epoch: 1, targetRunnerId: TARGET };
  assert.deepEqual(await t.invoke(SOURCE, 'botWorkspaceMoves:destinationProjects', targets), [{ id: 'next', title: 'Next desk' }]);
  assert.equal(await outcome(t.invoke(OTHER, 'botWorkspaceMoves:destinationProjects', targets)), 'forbidden');
  assert.equal(await outcome(t.invoke(SOURCE, 'botWorkspaceMoves:destinationProjects', { ...targets, epoch: 2 })), 'forbidden');
  assert.equal(await outcome(t.invoke(SOURCE, 'botWorkspaceMoves:destinationProjects', { ...targets, targetRunnerId: SOURCE })), 'unavailable');
  await t.begin();
  assert.equal(await outcome(t.invoke(SOURCE, 'botWorkspaceMoves:destinationProjects', targets)), 'forbidden');
});

test('the saved owner can freeze a move and only the staged target can claim it once', async () => {
  const t = await fixture();
  assert.equal(await outcome(t.begin(OTHER)), 'forbidden');
  assert.equal((await t.begin()).state, 'staged');
  assert.equal((await t.begin()).state, 'staged', 'lost response returns the prior receipt');
  assert.deepEqual(await t.deviceList(), []);
  assert.equal(await outcome(t.queueEdit()), 'notFound');
  assert.equal(await outcome(t.publish(SOURCE, 1)), 'forbidden');
  assert.equal(await outcome(t.claim(OTHER)), 'forbidden');
  assert.equal(await outcome(t.claim()), 'conflict', 'a claim needs every part from the source');
  assert.equal(await outcome(t.upload(OTHER)), 'forbidden');
  assert.equal(await outcome(t.part()), 'conflict');
  await t.upload();
  await t.upload();
  assert.equal(await outcome(t.part(OTHER)), 'forbidden');
  assert.equal(await t.part(), Buffer.from('sealed fixture').toString('base64'));
  assert.equal(await outcome(t.claim(TARGET, '1'.repeat(64))), 'forbidden');
  assert.equal(await outcome(t.publish(TARGET, 2)), 'forbidden', 'target is not the owner before the claim');
  const claim = await t.claim();
  assert.deepEqual(claim, { state: 'claimed', workspaceId: WORKSPACE, moveId: 'move-1', ownerRunnerId: TARGET, epoch: 2 });
  assert.deepEqual(await t.claim(), claim, 'lost response recovers the claim with no second epoch');
  assert.equal(await outcome(t.cancel()), 'forbidden', 'old owner cannot recover ownership after the claim');
  assert.equal(await outcome(t.publish(SOURCE, 1)), 'forbidden');
  await t.publish(TARGET, 2);
  assert.deepEqual((await t.deviceList()).map((row: { ownerRunnerId: string; epoch: number }) => [row.ownerRunnerId, row.epoch]), [[TARGET, 2]]);
});

test('a cancelled staged move releases only the source with its existing epoch', async () => {
  const t = await fixture();
  await t.begin();
  assert.equal(await outcome(t.cancel(TARGET)), 'forbidden');
  assert.deepEqual(await t.cancel(), { state: 'cancelled', workspaceId: WORKSPACE, moveId: 'move-1', ownerRunnerId: SOURCE, epoch: 1 });
  assert.deepEqual(await t.cancel(), { state: 'cancelled', workspaceId: WORKSPACE, moveId: 'move-1', ownerRunnerId: SOURCE, epoch: 1 });
  assert.equal(await outcome(t.claim()), 'forbidden');
  assert.equal(await outcome(t.publish(TARGET, 2)), 'forbidden');
  await t.publish(SOURCE, 1);
  assert.deepEqual((await t.deviceList()).map((row: { ownerRunnerId: string; epoch: number }) => [row.ownerRunnerId, row.epoch]), [[SOURCE, 1]]);
});

test('public Bot reservations retain their identity and next run when the workspace claims a new owner', async () => {
  const f = await fixture();
  const id = randomUUID();
  const due = '2099-01-01T00:00:00.000Z';
  const original = {
    id, runnerId: SOURCE, title: '毎週レビュー', text: '見出しを確認してください',
    whenText: 'Weekly', cron: '0 9 * * 1', timezone: 'Asia/Tokyo',
    nextRunAt: due, createdAt: '2026-11-26T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z',
    paused: false, runs: 3, lastRun: { at: '2026-11-24T00:00:00.000Z', outcome: 'sent' },
    botTarget: { kind: 'newConversation', botId: 'bot-id' }, botCeiling: 'ask',
  };
  const save = (runnerId: string, schedule: typeof original, expectedUpdatedAt?: string) =>
    call(f.ctx, sync.saveSchedule, { key: f.key(runnerId), schedule, expectedUpdatedAt });
  await save(SOURCE, original);
  const ordinary = { ...original, id: randomUUID(), botTarget: undefined, botCeiling: undefined };
  await call(f.ctx, sync.saveSchedule, { key: f.key(SOURCE), schedule: ordinary });
  const lease = (runnerId: string) => call(f.ctx, sync.claimSchedule, {
    key: f.key(runnerId), runnerId, scheduleId: id, holder: runnerId + ':1:process', kind: 'due', expect: due,
  });
  const stage = (updatedAt = original.updatedAt) => f.invoke(SOURCE, 'botWorkspaceMoves:begin', {
    workspaceId: WORKSPACE, moveId: 'move-1', epoch: 1, targetRunnerId: TARGET, checksum: DIGEST,
    bytes: Buffer.byteLength('sealed fixture'), parts: 1, sealedChecksum: digest(Buffer.from('sealed fixture')),
    threadIds: [], schedules: [{ id, updatedAt }],
  });
  assert.equal(await outcome(f.begin()), 'conflict', 'a move cannot omit a saved Bot reservation');
  assert.equal(await lease(SOURCE), true);
  assert.equal(await outcome(stage()), 'busy');
  await call(f.ctx, sync.releaseSchedule, { key: f.key(SOURCE), scheduleId: id, holder: SOURCE + ':1:process' });
  assert.equal(await outcome(stage('stale')), 'conflict');
  assert.equal((await stage()).state, 'staged');
  assert.equal(await lease(SOURCE), false);
  assert.equal(await outcome(save(SOURCE, { ...original, paused: true }, original.updatedAt)), 'forbidden');
  assert.equal(await outcome(call(f.ctx, sync.deleteSchedule, {
    key: f.key(SOURCE), scheduleId: id, expectedUpdatedAt: original.updatedAt,
  })), 'forbidden');
  await f.upload();
  assert.equal((await f.claim()).state, 'claimed');
  assert.equal((await f.claim()).state, 'claimed');
  const moved = f.rows('schedules').find(row => row.id === id);
  assert.equal(moved?.runnerId, TARGET);
  for (const property of ['id', 'updatedAt', 'nextRunAt', 'cron', 'timezone', 'runs', 'lastRun', 'botTarget', 'botCeiling'] as const) {
    assert.deepEqual(moved?.[property], original[property]);
  }
  assert.equal(f.rows('schedules').find(row => row.id === ordinary.id)?.runnerId, SOURCE);
  assert.equal(f.rows('scheduleGone').filter(row => row.id === id).length, 1);
  assert.equal(await lease(SOURCE), false);
  assert.equal(await lease(TARGET), true);
  const next = '2099-01-08T00:00:00.000Z';
  const ran = (who: string, holder: string) => call(f.ctx, sync.scheduleRan, {
    key: f.key(who), scheduleId: id, holder, lastRun: { at: due, outcome: 'sent' },
    sent: true, expectUpdatedAt: original.updatedAt, nextRunAt: next,
  });
  await ran(SOURCE, SOURCE + ':1:process');
  await ran(TARGET, SOURCE + ':1:process');
  assert.equal(f.rows('schedules').find(row => row.id === id)?.nextRunAt, due);
  await ran(TARGET, TARGET + ':1:process');
  await ran(TARGET, TARGET + ':1:process');
  assert.equal(f.rows('schedules').find(row => row.id === id)?.nextRunAt, next);
  assert.equal(f.rows('schedules').find(row => row.id === id)?.runs, 4);
});

test('cancelling a not-yet-offered move prevents a delayed begin from freezing the workspace', async () => {
  const f = await fixture();
  const id = 'cancel-before-offer';
  const cancelled = {
    epoch: 1, state: 'cancelled', ownerRunnerId: SOURCE, moveId: id, workspaceId: WORKSPACE,
  };
  const cancel = (runnerId: string, epoch: number) => f.invoke(runnerId, 'botWorkspaceMoves:cancel', {
    workspaceId: WORKSPACE, moveId: id, epoch, targetRunnerId: TARGET,
  });
  assert.equal(await outcome(cancel(OTHER, 1)), 'forbidden');
  assert.equal(await outcome(cancel(SOURCE, 2)), 'forbidden');
  assert.deepEqual(await cancel(SOURCE, 1), cancelled);
  assert.deepEqual(await f.invoke(SOURCE, 'botWorkspaceMoves:state', { workspaceId: WORKSPACE, moveId: id }), cancelled);
  assert.equal((await f.begin()).state, 'staged', 'the owner can start a different move');
  assert.deepEqual(await f.invoke(SOURCE, 'botWorkspaceMoves:begin', {
    workspaceId: WORKSPACE, moveId: id, epoch: 1, targetRunnerId: TARGET, checksum: DIGEST,
    bytes: Buffer.byteLength('sealed fixture'), parts: 1, sealedChecksum: digest(Buffer.from('sealed fixture')), threadIds: [],
  }), cancelled);
  assert.equal((await f.invoke(SOURCE, 'botWorkspaceMoves:state', { workspaceId: WORKSPACE, moveId: 'move-1' })).state, 'staged');
});

test('two isolated Runners retry one sealed transfer after lost upload and claim replies', async () => {
  const oldHome = tmpDir();
  const newHome = tmpDir();
  const repo = new BotRepository(join(oldHome, 'bots'), SOURCE);
  const bot = repo.create({ name: 'Reviewer', instructions: '記事と見出しを確認してください' });
  const identity = repo.workspaceIdentity();
  const recipient = new SecretStore(join(newHome, 'secrets'));
  const f = await fixture(identity.workspaceId);
  const schedule = {
    id: randomUUID(), runnerId: SOURCE, title: '予約', text: '記事を確認', whenText: 'Weekly',
    paused: false, runs: 1, nextRunAt: '2099-01-01T09:00:00.000Z', cron: '0 9 * * 1',
    createdAt: '2026-11-26T10:00:00.000Z', updatedAt: '2026-11-26T10:00:00.000Z',
    botTarget: { kind: 'newConversation', botId: bot.id }, botCeiling: 'ask',
  };
  await call(f.ctx, sync.saveSchedule, { key: f.key(SOURCE), schedule });
  const revisions = [{ id: schedule.id, updatedAt: schedule.updatedAt }];
  let loseUpload = true;
  let loseClaim = true;
  let staleReservationOffer = true;
  let adopted = 0;
  let keyReads = 0;
  let uploads = 0;
  const sender = () => new BotWorkspaceWire({
    runnerId: SOURCE, store: new BotWorkspaceTransfer(oldHome, SOURCE, () => {}),
    key: async () => {
      assert.equal(++keyReads, 1, 'a restart uses the exact saved ciphertext');
      return recipient.publicKey();
    },
    call: async (_kind, method, args) => {
      const response = await f.invoke(SOURCE, method, args);
      if (method.endsWith(':putPart')) uploads += 1;
      if (method.endsWith(':putPart') && loseUpload) {
        loseUpload = false;
        throw new Error('lost upload reply');
      }
      return response;
    },
    open: () => { throw new Error('This is the source'); },
    validateTarget: () => { throw new Error('This is the source'); },
    adopted: () => { throw new Error('This is the source'); },
  });
  const target = () => new BotWorkspaceWire({
    runnerId: TARGET, store: new BotWorkspaceTransfer(newHome, TARGET, () => {}),
    key: async () => { throw new Error('This is the target'); },
    call: async (_kind, method, args) => {
      const response = await f.invoke(TARGET, method, args);
      if (method.endsWith(':pending') && response && staleReservationOffer) {
        staleReservationOffer = false;
        return { ...response, schedules: [{ ...revisions[0], updatedAt: 'stale' }] };
      }
      if (method.endsWith(':claim') && loseClaim) {
        loseClaim = false;
        throw new Error('lost claim reply');
      }
      return response;
    },
    open: (bytes, info) => recipient.openBytes(bytes, info),
    validateTarget: manifest => {
      assert.equal(manifest.identity.workspaceId, identity.workspaceId);
      assert.deepEqual(manifest.schedules, revisions);
    },
    adopted: () => { adopted += 1; },
  });
  const request = { moveId: 'move-1', target: TARGET, identity, idle: () => true, threadFiles: () => [], schedules: () => revisions };
  await assert.rejects(sender().send(request), /lost upload reply/);
  assert.equal(new BotWorkspaceTransfer(oldHome, SOURCE, () => {}).blocked(), true);
  await sender().poll();
  const recoveredUploads = uploads;
  assert.ok(recoveredUploads > 1);
  await sender().poll();
  assert.equal(uploads, recoveredUploads, 'the saved upload receipt avoids another transfer');
  await assert.rejects(target().poll(), /declared reservation revisions/);
  assert.equal(new BotWorkspaceTransfer(newHome, TARGET, () => {}).blocked(), false);
  await assert.rejects(target().poll(), /lost claim reply/);
  assert.equal(new BotWorkspaceTransfer(newHome, TARGET, () => {}).blocked(), true);
  await target().poll();
  await target().poll();
  await sender().poll();
  assert.equal(adopted, 1);
  assert.deepEqual(f.rows('schedules').map(row => [row.runnerId, row.id, row.nextRunAt]), [[TARGET, schedule.id, schedule.nextRunAt]]);
  assert.deepEqual(new BotRepository(join(newHome, 'bots'), TARGET).get(bot.id), bot);
  assert.equal(new BotWorkspaceTransfer(oldHome, SOURCE, () => {}).blocked(), true);
  assert.equal(await outcome(f.publish(SOURCE, 1)), 'forbidden');
  await f.publish(TARGET, 2);
  assert.equal((await f.deviceList()).length, 1);
});

test('the workspace claim switches every declared Bot Thread in the same transaction', async () => {
  const first = '19cd3fa6-f62c-4e26-8f5d-2648d4ecf221';
  const second = '4196b521-d031-4686-99ef-6f42c2802cca';
  const f = await fixture(WORKSPACE, DIGEST, Buffer.from('sealed fixture'), [first, second]);
  const makeThread = async (threadId: string, linked: boolean) => {
    const row = { ...THREAD_BASICS, threadId, runnerId: SOURCE, view: 'inbox', title: 'Test chat', needsYou: false };
    await call(f.ctx, sync.upsertThreads, { key: f.key(SOURCE), threads: [linked ? { ...row, botLink: { botId: 'bot-id', conversationId: threadId } } : row] });
    return row;
  };
  const source = await makeThread(first, true);
  await makeThread(second, false);
  await f.begin();
  await f.upload();
  assert.equal(await outcome(f.claim()), 'conflict', 'an ordinary Thread cannot join the workspace move');
  assert.deepEqual(f.rows('threads').map(row => row.runnerId), [SOURCE, SOURCE]);
  await makeThread(second, true);
  const done = await f.claim();
  assert.equal(done.ownerRunnerId, TARGET);
  assert.deepEqual(f.rows('threads').map(row => row.runnerId), [TARGET, TARGET]);
  assert.ok(f.rows('threads').every(row => typeof row.botLink?.botId === 'string'));
  assert.deepEqual(await call(f.ctx, load('moves').moves, { key: f.key(TARGET), runnerId: TARGET }), []);
  assert.equal(await outcome(call(f.ctx, sync.upsertThreads, { key: f.key(SOURCE), threads: [{ ...source, title: 'Stale update' }] })), 'forbidden');
  assert.equal(f.rows('threads').find(row => row.threadId === first)?.title, 'Test chat');
  assert.equal(f.rows('threadMoves').length, 2);
  assert.deepEqual(await f.claim(), done);
  assert.equal(f.rows('threadMoves').length, 2);
});

test('a workspace move reopens direct and Group conversations after losing the claim and restarting during adoption', async () => {
  const withProjects = (home = tmpDir()) => {
    const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
    const h = makeHarness(home, {}, { projects });
    projects.start(h.runner);
    return { ...h, projects };
  };
  const source = withProjects();
  const destination = withProjects();
  const sourceProject = source.projects.create({ title: 'Editorial', by: 'mike' });
  destination.projects.create({ title: 'Editorial', by: 'mike' });
  const targetProject = destination.projects.create({ title: 'Destination desk', by: 'mike' });
  const workspace = join(source.home, 'bots');
  const repo = new BotRepository(workspace, SOURCE);
  const conversations = new BotConversations(source.runner, repo, workspace);
  const bot = repo.create({ name: 'Editor' });
  const chat = conversations.create(bot.id, 'original');
  conversations.remember(bot.id, chat.threadId, '短い見出し');
  source.projects.changeMembership(chat.threadId, { add: [sourceProject.id], by: 'mike' });
  const projectMemory = join(workspace, 'memory', 'project-' + sourceProject.id);
  mkdirSync(projectMemory, { recursive: true });
  writeFileSync(join(projectMemory, 'memo.md'), '編集部の引き継ぎ');
  const groups = new GroupStore(workspace, repo, () => {});
  const group = groups.create({ title: 'Desk', teamId: repo.workspaceId(), memberIds: [bot.id], adminId: bot.id });
  const member = { id: randomUUID(), threadId: randomUUID(), sessionId: randomUUID() };
  const groupLink = { botId: bot.id, conversationId: member.id, groupId: group.id };
  groups.change(group.id, book => {
    book.threads[bot.id] = member;
    return groups.append(book, 'result', source.runner.isoNow(), { text: 'レビュー済み' });
  });
  source.runner.makeThread({ text: '', title: 'Desk · Editor', worktree: false }, {
    id: member.threadId, sessionId: member.sessionId, botLink: groupLink,
  });
  const identity = repo.workspaceIdentity();
  const layout = { workspaceId: identity.workspaceId, epoch: identity.epoch, moveId: 'move-1', target: TARGET, projects: { assign: { [sourceProject.id]: targetProject.id } } };
  const backend = await fixture(identity.workspaceId);
  await call(backend.ctx, sync.upsertThreads, {
    key: backend.key(SOURCE), threads: [
      { threadId: chat.threadId, botLink: { botId: bot.id, conversationId: chat.id } },
      { threadId: member.threadId, botLink: groupLink },
    ].map(row => ({ ...THREAD_BASICS, runnerId: SOURCE, view: 'inbox', title: 'Editor', needsYou: false, ...row })),
  });
  const senderStore = new BotWorkspaceTransfer(source.home, SOURCE, () => {});
  let wrongReceipt = false;
  const sender = connectNativeWorkspaceRunner(source.runner, {
    runnerId: SOURCE, store: senderStore,
    key: async () => destination.runner.secrets.publicKey(),
    call: async (_kind, method, args) => {
      const result = await backend.invoke(SOURCE, method, args);
      if (wrongReceipt && method === 'botWorkspaceMoves:state') {
        wrongReceipt = false;
        return { ...result, epoch: identity.epoch + 2 };
      }
      return result;
    },
    open: () => assert.fail('The source cannot decrypt the target bundle'),
    validateTarget: () => assert.fail('The source cannot validate the target'),
    adopted: () => assert.fail('The source cannot accept its old workspace'),
  });
  const threadIds = [chat.threadId, member.threadId];
  await sender.start({
    ...layout, identity,
    idle: () => true,
  });
  assert.equal(senderStore.blocked(), true);
  const targetStore = new BotWorkspaceTransfer(destination.home, TARGET, () => {});
  let loseReply = true;
  let interruptAdoption = true;
  const openTarget = (runner: typeof destination.runner) => {
    const adopt = runner.adoptMoved.bind(runner);
    runner.adoptMoved = async row => {
      const result = await adopt(row);
      if (interruptAdoption) {
        interruptAdoption = false;
        throw new Error('stopped after the conversation was adopted');
      }
      return result;
    };
    return connectNativeWorkspaceRunner(runner, {
      runnerId: TARGET, store: targetStore,
      key: async () => assert.fail('The target is not sending a new workspace'),
      call: async (_kind, method, args) => {
        const answer = await backend.invoke(TARGET, method, args);
        if (method === 'botWorkspaceMoves:claim' && loseReply) {
          loseReply = false;
          assert.ok(threadIds.every(id => !runner.threads.has(id)), 'placed Threads have not gone live');
          throw new Error('lost workspace claim acknowledgement');
        }
        return answer;
      },
      open: (bytes, info) => runner.secrets.openBytes(bytes, info),
      validateTarget: manifest => assert.equal(manifest.target, TARGET),
      adopted: moved => assert.equal(moved.epoch, identity.epoch + 1),
    });
  };
  const emptyTarget = makeHarness(destination.home);
  await assert.rejects(openTarget(emptyTarget.runner).poll(), /does not have an active Project/);
  assert.ok(backend.rows('threads').every(row => row.runnerId === SOURCE));
  await assert.rejects(openTarget(destination.runner).poll(), /lost workspace claim acknowledgement/);
  assert.ok(threadIds.every(id => !destination.runner.threads.has(id)));
  assert.equal(backend.rows('threads').length, 2);
  assert.ok(backend.rows('threads').every(row => row.runnerId === TARGET));
  await assert.rejects(openTarget(withProjects(destination.home).runner).poll(), /stopped after the conversation was adopted/);
  assert.equal(targetStore.blocked(), true);
  const restarted = withProjects(destination.home);
  await openTarget(restarted.runner).poll();
  wrongReceipt = true;
  await assert.rejects(sender.poll(), /does not match the moving/);
  assert.ok(threadIds.every(id => source.store.load(id) && source.runner.threads.has(id)));
  const retire = source.runner.putAwayMoved.bind(source.runner);
  let lostRetirement = true;
  source.runner.putAwayMoved = async id => {
    await retire(id);
    if (lostRetirement) {
      lostRetirement = false;
      throw new Error('stopped after retiring one conversation');
    }
  };
  await assert.rejects(sender.poll(), /stopped after retiring one conversation/);
  assert.equal(senderStore.progress()?.state, 'frozen');
  await sender.poll();
  await tick();

  assert.equal(senderStore.progress()?.state, 'moved');
  assert.ok(threadIds.every(id => !source.store.load(id) && !source.runner.threads.has(id)));
  assert.equal(targetStore.progress()?.state, 'accepted');
  assert.equal(restarted.store.load(chat.threadId)?.botLink?.conversationId, chat.id);
  assert.deepEqual(restarted.store.load(chat.threadId)?.projects?.map(project => project.id), [targetProject.id]);
  assert.deepEqual(restarted.store.load(member.threadId)?.botLink, groupLink);
  const newWorkspace = join(restarted.home, 'bots');
  assert.equal(readFileSync(join(newWorkspace, 'memory', 'project-' + targetProject.id, 'memo.md'), 'utf8'), '編集部の引き継ぎ');
  const newRepo = new BotRepository(newWorkspace, TARGET);
  assert.equal(newRepo.workspaceIdentity().epoch, identity.epoch + 1);
  assert.deepEqual(new BotConversations(restarted.runner, newRepo, newWorkspace).notes(bot.id, chat.threadId).map(note => note.text), ['短い見出し']);
  const recoveredGroup = new GroupStore(newWorkspace, newRepo, () => {}).get(group.id);
  assert.deepEqual(recoveredGroup.threads[bot.id], member);
  assert.equal(recoveredGroup.events[0]?.text, 'レビュー済み');
});

test('the native owner can cancel an unclaimed transfer and keep the source workspace', async () => {
  const source = makeHarness(tmpDir());
  const target = makeHarness(tmpDir());
  const root = join(source.home, 'bots');
  const repo = new BotRepository(root, SOURCE);
  const bot = repo.create({ name: 'Editor' });
  const chat = new BotConversations(source.runner, repo, root).create(bot.id, 'to-cancel');
  const identity = repo.workspaceIdentity();
  const backend = await fixture(identity.workspaceId);
  const store = new BotWorkspaceTransfer(source.home, SOURCE, () => {});
  const mover = connectNativeWorkspaceRunner(source.runner, {
    runnerId: SOURCE, store,
    key: async () => target.runner.secrets.publicKey(),
    call: (_kind, method, args) => backend.invoke(SOURCE, method, args),
    open: () => assert.fail('The source does not open its offer'),
    validateTarget: () => assert.fail('The source does not place its offer'),
    adopted: () => assert.fail('The source does not adopt its old workspace'),
  });
  const moveId = 'owner-cancel';
  await mover.start({ moveId, target: TARGET, identity, projects: 'detach', idle: () => true });
  assert.equal(store.blocked(), true);
  const incoming = new BotWorkspaceTransfer(target.home, TARGET, () => {});
  let discarded = 0;
  const discardMove = target.runner.discardMove.bind(target.runner);
  target.runner.discardMove = async row => {
    if (target.runner.movePlaced(row)) discarded++;
    await discardMove(row);
  };
  const receiver = connectNativeWorkspaceRunner(target.runner, {
    runnerId: TARGET, store: incoming,
    key: async () => assert.fail('The target does not send the offer'),
    call: (_kind, method, args) => {
      if (method === 'botWorkspaceMoves:claim') return Promise.reject(new Error('connection lost before the claim'));
      return backend.invoke(TARGET, method, args);
    },
    open: (bytes, info) => target.runner.secrets.openBytes(bytes, info),
    validateTarget: manifest => assert.equal(manifest.target, TARGET),
    adopted: () => assert.fail('The cancelled offer did not have a claim'),
  });
  await assert.rejects(receiver.poll(), /connection lost before the claim/);
  assert.equal(incoming.progress()?.state, 'receiving');
  await assert.rejects(mover.cancel('another-move'), /outgoing workspace move/);
  await mover.cancel(moveId);
  assert.equal(store.progress()?.state, 'cancelled');
  assert.equal(store.blocked(), false);
  assert.deepEqual(new BotRepository(root, SOURCE).get(bot.id), bot);
  assert.deepEqual(await backend.invoke(SOURCE, 'botWorkspaceMoves:state', { moveId, workspaceId: identity.workspaceId }), {
    moveId, workspaceId: identity.workspaceId, ownerRunnerId: SOURCE, epoch: identity.epoch, state: 'cancelled',
  });
  assert.equal(await backend.invoke(TARGET, 'botWorkspaceMoves:pending', {}), null);
  await receiver.poll();
  assert.equal(incoming.progress()?.state, 'cancelled');
  assert.equal(discarded, 1, 'the placed Thread is discarded at the target');
  assert.equal(target.runner.threads.has(chat.threadId), false);
  assert.equal(source.runner.threads.has(chat.threadId), true);
});

test('a protected move authenticates the current erasure revision and exposes it only to the participating Runners', async () => {
  const f = await fixture();
  const scope = { kind: 'bot', id: 'editor' };
  const entryId = 'a10b';
  const erase = () => call(f.ctx, sync.eraseBotWorkspaceNote, { key: f.key(SOURCE), runnerId: SOURCE, startedAt: RELEASE,
    workspaceId: WORKSPACE, epoch: 1, scope, entryId });
  await erase();
  await erase();
  const lookup = (id: string, moveId?: string) => f.invoke(id, 'botWorkspaceMoves:verifyBotWorkspaceNoteErasures', { workspaceId: WORKSPACE, moveId });
  assert.deepEqual(await lookup(SOURCE), { revision: 1, epoch: 1, ownerRunnerId: SOURCE, rows: [{ scope, entryId }], cursor: null });
  assert.equal(await outcome(lookup(TARGET, 'move-1')), 'forbidden');
  assert.equal(await outcome(f.begin()), 'conflict', 'old senders cannot stage unverified packs');
  const binding = { key: f.key(SOURCE), runnerId: SOURCE, startedAt: RELEASE };
  const sealed = Buffer.from('sealed fixture');
  const offer = { ...binding, workspaceId: WORKSPACE, moveId: 'move-1', epoch: 1, targetRunnerId: TARGET, checksum: DIGEST,
    bytes: sealed.length, parts: 1, sealedChecksum: digest(sealed), threadIds: [] };
  await call(f.ctx, moves.begin, { ...offer, noteErasureRevision: 1 });
  assert.deepEqual(await lookup(TARGET, 'move-1'), await lookup(SOURCE));
  assert.equal(await outcome(lookup(OTHER, 'move-1')), 'forbidden');
  assert.equal(await outcome(erase()), 'forbidden', 'erasures cannot change during a staged offer');
  await f.upload();
  assert.equal(await outcome(f.claim()), 'conflict', 'old receivers cannot claim without examining the pack');
  await f.invoke(TARGET, 'botWorkspaceMoves:claim', { workspaceId: WORKSPACE, moveId: 'move-1', checksum: DIGEST, noteErasureRevision: 1 });
  assert.deepEqual(await lookup(TARGET), { revision: 1, epoch: 2, ownerRunnerId: TARGET, rows: [{ scope, entryId }], cursor: null });
});

test('a native move stops an older backup at the source and carries the erasure to the target', async () => {
  const home = tmpDir();
  const stale = tmpDir();
  const target = tmpDir();
  const root = join(home, 'bots');
  const repo = new BotRepository(root, SOURCE);
  const editor = repo.create({ name: 'Editor' });
  const identity = repo.workspaceIdentity();
  const memory = new PersonalMemory(join(root, 'memory', editor.id));
  const time = '2026-11-27T00:00:00Z';
  const input = { op: 'add' as const, text: '古い保存から復元されない合成覚書' };
  const stored = memory.change(input, 'first-operation', 'empty', time);
  assert.ok(stored.note);
  cpSync(root, join(stale, 'bots'), { recursive: true });
  memory.erase(stored.note.id, 'erase-on-owner', stored.revision, time, () => {});
  const backend = await fixture(identity.workspaceId);
  await call(backend.ctx, sync.eraseBotWorkspaceNote, { key: backend.key(SOURCE), runnerId: SOURCE, startedAt: RELEASE,
    workspaceId: identity.workspaceId, epoch: identity.epoch, scope: { kind: 'bot', id: editor.id }, entryId: stored.note.id });
  const keys = new SecretStore(join(target, 'secrets'));
  const store = new BotWorkspaceTransfer(target, TARGET, () => {});
  const sender = (local: string) => new BotWorkspaceWire({
    runnerId: SOURCE, store: new BotWorkspaceTransfer(local, SOURCE, () => {}), supportsNoteErasures: () => true,
    key: async () => keys.publicKey(), call: (_kind, method, args) => backend.invoke(SOURCE, method, args),
    open: () => assert.fail('sender must not open an incoming pack'), validateTarget: () => {}, adopted: () => {},
  });
  const offer = { identity, target: TARGET, moveId: 'after-erasure', idle: () => true, threadFiles: () => [] };
  const oldBackup = readTree(join(stale, 'bots'), 'bots');
  const currentBackup = readTree(root, 'bots');
  const check = sender(home);
  await assert.rejects(check.verifyMemoryRestore(oldBackup, identity), /required memory erasure/);
  await assert.rejects(check.verifyMemoryRestore(currentBackup, { ...identity, epoch: identity.epoch + 1 }), /saved Bot workspace identity/);
  await check.verifyMemoryRestore(currentBackup, identity);
  const copy = currentBackup.find(file => file.path === 'bots/state.json')!;
  await assert.rejects(check.verifyMemoryRestore([...currentBackup, { ...copy, path: 'bots/STATE.JSON' }], identity), /duplicate file/);
  const oldTools = new BotWorkspaceWire({
    runnerId: SOURCE, store: new BotWorkspaceTransfer(home, SOURCE, () => {}),
    key: async () => keys.publicKey(), call: (_kind, method, args) => backend.invoke(SOURCE, method, args),
    open: () => assert.fail('restore checking does not open a sealed offer'), validateTarget: () => {}, adopted: () => {},
  });
  await assert.rejects(oldTools.verifyMemoryRestore(currentBackup, identity), /updated sync/);
  await assert.rejects(sender(stale).send(offer), /required memory erasure/);
  assert.equal(await backend.invoke(TARGET, 'botWorkspaceMoves:pending', {}), null);
  const staleStore = new BotWorkspaceTransfer(stale, SOURCE, () => {});
  staleStore.abandonPreparation(offer.moveId);
  const unverified = new BotWorkspaceWire({
    runnerId: SOURCE, store: staleStore, key: async () => keys.publicKey(),
    call: (_kind, method, args) => backend.invoke(SOURCE, method,
      method === 'botWorkspaceMoves:begin' ? { ...args, noteErasureRevision: 1 } : args),
    open: () => assert.fail('sender must not open an incoming pack'), validateTarget: () => {}, adopted: () => {},
  });
  await unverified.send({ ...offer, moveId: 'stale-candidate' });
  let loseClaimReply = true;
  const receiver = () => new BotWorkspaceWire({
    runnerId: TARGET, store, supportsNoteErasures: () => true,
    key: async () => assert.fail('receiver must not send its own offer'),
    call: async (_kind, method, args) => {
      const reply = await backend.invoke(TARGET, method, args);
      if (method === 'botWorkspaceMoves:claim' && loseClaimReply) {
        loseClaimReply = false;
        throw new Error('claim reply lost');
      }
      return reply;
    },
    open: (bytes, info) => keys.openBytes(bytes, info), validateTarget: () => {}, adopted: () => {},
  });
  await assert.rejects(receiver().poll(), /required memory erasure/);
  assert.equal(store.progress(), undefined, 'the recipient never saves the stale candidate');
  await unverified.cancel('stale-candidate');
  await sender(home).send(offer);
  await assert.rejects(receiver().poll(), /claim reply lost/);
  assert.equal(store.progress()?.state, 'receiving');
  await receiver().poll();
  const moved = new PersonalMemory(join(target, 'bots', 'memory', editor.id));
  assert.deepEqual(moved.list('2026-11-27'), []);
  assert.deepEqual(moved.change(input, 'first-operation', 'empty', time), { revision: stored.revision });
  assert.equal(store.progress()?.state, 'accepted');
});

test('an owner restores one selected note only after the archive and current workspace agree', async () => {
  const h = makeHarness(tmpDir());
  const root = join(h.home, 'bots');
  const repo = new BotRepository(root, SOURCE);
  const bot = repo.create({ name: 'Editor' });
  const other = repo.create({ name: 'Other' });
  const identity = repo.workspaceIdentity();
  const folder = join(root, 'memory', bot.id);
  const memory = new PersonalMemory(folder);
  const time = '2026-11-27T00:00:00Z';
  const saved = memory.change({ op: 'add', text: 'バックアップの覚書' }, 'original', 'empty', time);
  const outside = new PersonalMemory(join(root, 'memory', other.id));
  outside.change({ op: 'add', text: '別のBotの覚書' }, 'other-original', 'empty', time);
  assert.ok(saved.note);
  const id = saved.note.id;
  const backupRoot = join(h.home, 'bot-backups');
  mkdirSync(backupRoot);
  const backupId = randomUUID();
  const path = join(backupRoot, backupId + '.pack');
  const pack = archive(readTree(root, 'bots'));
  writeFileSync(path, pack);
  const removed = memory.change({ op: 'remove', entryId: id }, 'forget', saved.revision, time);
  const current = memory.change({ op: 'add', text: '現在の覚書' }, 'current', removed.revision, time);
  const input = backupMemoryRestoreInput.parse({
    backupId, checksum: digest(pack), scope: { kind: 'bot', id: bot.id }, entryId: id,
    operationId: 'backup-recovery', expectedRevision: current.revision,
  });

  assert.throws(() => readManagedMemoryBackup(h.home, { ...input, checksum: DIGEST }), /selected checksum/);
  const symlink = randomUUID();
  symlinkSync(path, join(backupRoot, symlink + '.pack'));
  assert.throws(() => readManagedMemoryBackup(h.home, { ...input, backupId: symlink }), /unavailable/);
  const files = readManagedMemoryBackup(h.home, input);
  assert.deepEqual(listManagedMemoryBackups(h.home).map(row => row.id), [backupId]);
  const preview = scopedBackupNotes(files, input.scope, input.checksum);
  assert.deepEqual(memory.previewBackupNotes(preview), [{ id, text: 'バックアップの覚書' }]);
  const redact = new PersonalMemory(folder, { redact: text => text.replaceAll('バックアップ', '[redacted]') });
  assert.deepEqual(redact.previewBackupNotes(preview), []);
  assert.throws(() => selectBackupMemoryNote(files, { ...input, scope: { kind: 'bot', id: other.id } }), /one matching note/);
  const backend = await fixture(identity.workspaceId);
  const wire = connectNativeWorkspaceRunner(h.runner, {
    runnerId: SOURCE, store: new BotWorkspaceTransfer(h.home, SOURCE, () => {}),
    supportsNoteErasures: () => true,
    key: async () => assert.fail('restoring a local backup does not use delivery keys'),
    call: (_kind, method, args) => backend.invoke(SOURCE, method, args),
    open: () => assert.fail('restoring a local backup does not open a move'),
    validateTarget: () => {}, adopted: () => {},
  });
  const apply = () => memory.restoreBackupNote(selectBackupMemoryNote(files, input), input.operationId, input.expectedRevision, time, () => {});
  await assert.rejects(wire.recoverMemory(files, { ...identity, ownerRunnerId: TARGET }, () => assert.fail('foreign owner wrote')),
    /workspace owner/);
  await assert.rejects(wire.recoverMemory(files, { ...identity, epoch: 2 }, () => assert.fail('stale epoch wrote')),
    /saved Bot workspace identity/);
  const result = await wire.recoverMemory(files, identity, apply);
  assert.deepEqual(await wire.recoverMemory(files, identity, apply), result);
  assert.deepEqual(memory.previewBackupNotes(preview), []);
  assert.deepEqual(memory.list('2026-11-27').map(note => note.text).sort(), ['バックアップの覚書', '現在の覚書']);
  assert.equal(outside.list('2026-11-27')[0]?.text, '別のBotの覚書');
  assert.deepEqual(readFileSync(path), pack);
});
