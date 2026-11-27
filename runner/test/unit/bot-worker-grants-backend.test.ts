import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BotWorkers, requestBotWorker, type BotWorkerGrant } from '../../src/bots/worker.ts';
import { SecretStore } from '../../src/secrets.ts';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { test } from 'node:test';
import { call, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const grants = load('botWorkerGrants');
const sync = load('sync');
const workspaceId = 'workspace';
const runnerIds = ['owner', 'worker', 'other'];
const startedAt = 'current';
const threadId = 'source-thread';
const workerThread = 'worker-thread';
const requestId = 'request';
const resultSeq = 12;

async function fixture() {
  process.env.RUNNER_KEY = 'fixture-owner-key';
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  const binding = (runnerId: string) => ({ runnerId, startedAt, key: `tbr_${runnerId}` });
  const key = (runnerId: string) => binding(runnerId).key;
  for (const runnerId of runnerIds) {
    await b.ctx.db.insert('runnerKeys', { runnerId, keyHash: await sha256(key(runnerId)), name: runnerId, createdAt: 1 });
    await b.ctx.db.insert('runners', { runnerId, name: runnerId, version: 'v', startedAt, draining: false, threadCount: 1, lastSeenAt: Date.now() });
  }
  await call(b.ctx, sync.setBotWorkspace, { ...binding('owner'), workspace: {
    workspaceId, ownerRunnerId: 'owner', epoch: 1, profiles: [{ id: 'bot', name: 'Editor', instructions: '', role: '', revision: 1 }],
    notes: [], tasks: [], requests: [], groups: [],
  } });
  await call(b.ctx, sync.upsertThreads, { key: key('owner'), threads: [
    { ...THREAD_BASICS, runnerId: 'owner', threadId, title: 'Source', view: 'inbox', needsYou: false, botLink: { botId: 'bot', conversationId: 'chat' } },
  ] });
  const targetKey = Buffer.alloc(32, 1).toString('base64');
  await call(b.ctx, grants.advertise, { ...binding('worker'), sealingKey: targetKey });
  assert.equal(await call(b.ctx, grants.target, { ...binding('owner'), workspaceId, epoch: 1, targetRunnerId: 'worker' }), targetKey);
  assert.equal(await outcome(call(b.ctx, grants.target, { ...binding('other'), workspaceId, epoch: 1, targetRunnerId: 'worker' })), 'forbidden');
  const grant = {
    workspaceId, epoch: 1, botId: 'bot', threadId, targetRunnerId: 'worker', workerThread,
    requestId, profileRevision: 1, ceiling: 'ask', expiresAt: Date.now() + 60_000, sealed: 'FixtureSealedSnapshot',
  };
  const issue = (caller = 'owner', override = {}) => call(b.ctx, grants.issue, { ...binding(caller), grant: { ...grant, ...override } });
  const take = (caller = 'worker', attempt = 'attempt') => call(b.ctx, grants.take, { ...binding(caller), workspaceId, requestId, attempt });
  const complete = (caller = 'worker', seq = resultSeq) => call(b.ctx, grants.complete, {
    ...binding(caller), workspaceId, requestId, threadId: workerThread, seq, attempt: 'attempt',
  });
  const read = (caller = 'owner', fromThread = threadId) => call(b.ctx, grants.result, {
    ...binding(caller), workspaceId, requestId, threadId: fromThread,
  });
  const history = (caller = 'owner', fromThread = threadId) => call(b.ctx, grants.history, {
    ...binding(caller), workspaceId, threadId: fromThread,
  });
  return { ...b, grant, binding, issue, take, complete, read, history };
}

test('a workspace owner using a Runner key lists only eligible live Bot Runners', async () => {
  const f = await fixture();
  const list = (who: string, forMove: boolean) => call(f.ctx, grants.targets, {
    ...f.binding(who), workspaceId, epoch: 1, forMove,
  });
  await call(f.ctx, grants.advertise, { ...f.binding('other'), sealingKey: Buffer.alloc(32, 2).toString('base64') });
  await f.ctx.db.insert('botWorkspaceOwners', { workspaceId: 'other-workspace', ownerRunnerId: 'other', epoch: 1 });
  assert.deepEqual((await list('owner', false)).map((row: { id: string }) => row.id).sort(), ['other', 'worker']);
  assert.deepEqual(await list('owner', true), [{ id: 'worker', name: 'worker' }]);
  assert.equal(await outcome(list('worker', true)), 'forbidden');
  const worker = f.rows('runners').find(row => row.runnerId === 'worker')!;
  await f.ctx.db.patch('runners', worker._id, { startedAt: 'replaced' });
  assert.deepEqual(await list('owner', true), []);
});

test('a limited Runner gets only the one bound Bot grant and can report the one saved answer', async () => {
  const f = await fixture();
  assert.equal(await outcome(f.issue('other')), 'forbidden');
  assert.equal(await outcome(f.issue('owner', { epoch: 2 })), 'forbidden');
  assert.equal(await outcome(f.issue('owner', { expiresAt: Date.now() - 1 })), 'badArgs');
  assert.equal(await outcome(f.issue('owner', { botId: 'private-or-unlinked' })), 'forbidden');
  const queued = await f.issue();
  assert.deepEqual(await f.issue(), queued);
  assert.equal(await outcome(f.issue('owner', { ceiling: 'full' })), 'conflict');
  assert.deepEqual(f.rows('commands').map(row => [row.runnerId, row.kind, row.args]), [
    ['worker', 'botWorker', { workspaceId, requestId }],
  ]);
  assert.equal(await outcome(f.take('other')), 'forbidden');
  assert.equal(await outcome(f.read('worker')), 'forbidden');
  assert.equal((await f.take()).sealed, f.grant.sealed);
  assert.deepEqual(await f.take(), await f.take());
  assert.equal(await f.take('worker', 'another-attempt'), null);
  assert.equal(await outcome(f.complete('other')), 'forbidden');
  assert.equal(await outcome(f.complete()), 'notFound');
  await call(f.ctx, sync.upsertThreads, { key: f.binding('worker').key, threads: [
    { ...THREAD_BASICS, runnerId: 'worker', threadId: workerThread, title: 'Worker', view: 'inbox', needsYou: false },
  ] });
  const result = await f.complete();
  assert.equal(result.resultId, `${workspaceId}:${requestId}`);
  assert.deepEqual(await f.complete(), result);
  assert.equal(await outcome(f.complete('worker', resultSeq + 1)), 'conflict');
  assert.deepEqual(await f.read(), result);
  assert.equal(await f.read('owner', 'another-conversation'), null);
  assert.deepEqual(await f.history(), [{ requestId, targetRunnerId: 'worker', state: 'done', result }]);
  assert.deepEqual(await f.history('owner', 'another-conversation'), []);
  assert.equal(await outcome(f.history('worker')), 'forbidden');
  assert.equal(await outcome(call(f.ctx, sync.setBotWorkspace, { ...f.binding('worker'), workspace: {
    workspaceId, ownerRunnerId: 'worker', epoch: 1, profiles: [], notes: [], tasks: [], groups: [], requests: [],
  } })), 'forbidden');
});

test('an expired grant cannot start a worker and a frozen workspace rejects new grants', async () => {
  const f = await fixture();
  const begin = load('botWorkspaceMoves').begin;
  const now = Date.now();
  await f.issue('owner', { expiresAt: now + 1000 });
  const real = Date.now;
  Date.now = () => now + 1001;
  try {
    assert.equal(await f.take(), null);
    await call(f.ctx, begin, { ...f.binding('owner'), workspaceId, epoch: 1, moveId: 'move', targetRunnerId: 'other', checksum: '1'.repeat(64), sealedChecksum: '2'.repeat(64), bytes: 100, parts: 1, threadIds: [] });
    assert.equal(await outcome(f.issue('owner', { requestId: 'new-request', expiresAt: now + 60_000 })), 'forbidden');
  } finally {
    Date.now = real;
  }
});

test('the existing command queue delivers the confined native worker and publishes its saved reference once', async () => {
  const f = await fixture();
  const home = tmpDir();
  const box = new SecretStore(join(home, 'secrets'));
  let native: BotWorkers;
  const workerRunner = makeHarness(home, {}, {
    botContext: rec => native.context(rec), botPermissionCeiling: rec => rec.botWorker?.ceiling,
    botWorkerQueue: (id, op) => native.queue(id, op),
  });
  native = new BotWorkers({
    home, runner: workerRunner.runner, runnerId: 'worker', canWrite: () => true, protect: () => {},
    open: (bytes, info) => box.openBytes(bytes, info),
  });
  const destination = f.binding('worker');
  const origin = f.binding('owner');
  await call(f.ctx, grants.advertise, { ...destination, sealingKey: box.publicKey() });
  const receipt = await requestBotWorker({
    home: tmpDir(), now: Date.now, protect: () => {},
    source: () => ({
      workspaceId, ownerRunnerId: 'owner', epoch: 1, botId: 'bot', profileRevision: 1, threadId, ceiling: 'ask',
      title: 'Japanese editor', instructions: '承認済みの覚書に従う',
    }),
    target: (workspace, epoch, targetRunnerId) => call(f.ctx, grants.target, { ...origin, workspaceId: workspace, epoch, targetRunnerId }),
    issue: ({ ownerRunnerId, ...grant }: BotWorkerGrant) => {
      assert.equal(ownerRunnerId, 'owner');
      return call(f.ctx, grants.issue, { ...origin, grant });
    },
  }, { threadId, targetRunnerId: 'worker', operationId: requestId, text: '見出しを確認してください' }) as { commandId: string };
  const attempt = 'retry-safe';
  assert.equal(await call(f.ctx, sync.takeCommand, { key: destination.key, commandId: receipt.commandId, attempt }), true);
  const claimed = await call(f.ctx, grants.take, { ...destination, workspaceId, requestId, attempt });
  const child = native.admit(claimed);
  assert.deepEqual(native.admit(claimed), child);
  await tick();
  const session = workerRunner.adapter.last;
  assert.match(session.opts.instructions ?? '', /承認済みの覚書/);
  assert.equal(workerRunner.runner.get(child.threadId).permissionMode, 'ask');
  session.init();
  session.text('review', '見出しを確認しました');
  session.result();
  await tick();
  const ref = native.result(child.threadId);
  assert.ok(ref);
  await call(f.ctx, sync.upsertThreads, { key: destination.key, threads: [
    { ...THREAD_BASICS, runnerId: 'worker', threadId: child.threadId, title: 'Japanese editor', needsYou: false, view: 'inbox' },
  ] });
  const saved = await call(f.ctx, grants.complete, { ...destination, ...ref, attempt });
  assert.deepEqual(await call(f.ctx, grants.complete, { ...destination, ...ref, attempt }), saved);
  assert.deepEqual(await f.read(), saved);
  assert.equal(workerRunner.adapter.sessions.length, 1);
});
