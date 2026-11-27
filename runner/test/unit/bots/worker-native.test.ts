import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotWorkers, requestBotWorker, workerSealInfo, type BotWorkerGrant } from '../../../src/bots/worker.ts';
import { sealBytes, SecretStore } from '../../../src/secrets.ts';
import { makeHarness, tick, tmpDir } from '../../helpers/fakes.ts';

test('a scoped worker has one native Thread, uses its approved ceiling, and reopens its result without another input', async () => {
  const home = tmpDir();
  const secrets = new SecretStore(join(home, 'secrets'));
  let workers: BotWorkers;
  const open = () => makeHarness(home, {}, {
    botContext: record => workers.context(record),
    botPermissionCeiling: record => record.botWorker?.ceiling,
    botWorkerQueue: (threadId, requestId) => workers.queue(threadId, requestId),
  });
  const h = open();
  const connect = (target: typeof h) => new BotWorkers({
    home, runner: target.runner, runnerId: 'worker', canWrite: () => true, protect: () => {},
    open: (bytes, info) => secrets.openBytes(bytes, info),
  });
  workers = connect(h);
  const grant: BotWorkerGrant = {
    workspaceId: 'test-workspace', ownerRunnerId: 'owner', epoch: 2, botId: 'editor', threadId: 'source',
    targetRunnerId: 'worker', workerThread: 'work', requestId: 'alpha', profileRevision: 3,
    ceiling: 'ask', expiresAt: h.clock.now() + 60_000, sealed: '',
  };
  const payload = { ...grant, title: 'Review headline', instructions: '指示と承認済みの覚書', text: '見出しを確認してください' };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  grant.sealed = sealBytes(secrets.publicKey(), bytes, workerSealInfo(grant)).toString('base64');
  assert.throws(() => workers.admit({ ...grant, ceiling: 'full' }), /match|sealed/);
  assert.equal(workers.admit(grant).threadId, 'work');
  assert.equal(workers.admit(grant).threadId, 'work');
  await tick();
  assert.equal(h.adapter.sessions.length, 1);
  const session = h.adapter.last;
  session.init();
  assert.match(session.opts.instructions ?? '', /承認済みの覚書/);
  assert.equal(h.runner.get('work').permissionMode, 'ask');
  assert.throws(() => h.runner.send('work', 'another input'), /worker/);
  session.text('answer', '確定結果');
  session.result();
  await tick();
  const ref = workers.result('work');
  assert.ok(ref);
  assert.equal(h.events('work').find(row => row.seq === ref.seq)?.type, 'assistant.text');
  const restarted = open();
  workers = connect(restarted);
  assert.deepEqual(workers.result('work'), ref);
  assert.equal(workers.admit(grant).threadId, 'work');
  assert.equal(restarted.adapter.sessions.length, 0);
});

test('a lost request reply reuses the sealed snapshot unless the owner narrowed the scope', async () => {
  const home = tmpDir();
  const secrets = new SecretStore(join(home, 'target'));
  const now = 1_788_019_200_000;
  let ceiling: 'full' | 'ask' = 'full';
  const submitted: BotWorkerGrant[] = [];
  const ports = {
    home, now: () => now, protect: () => {},
    source: () => ({
      workspaceId: 'scope', ownerRunnerId: 'source-runner', epoch: 1, profileRevision: 7, botId: 'editor', threadId: 'chat',
      title: 'Copy desk', instructions: 'Use the approved Bot notes.', ceiling,
    }),
    target: async () => secrets.publicKey(),
    issue: async (request: BotWorkerGrant) => {
      submitted.push(request);
      if (submitted.length === 1) throw new Error('response lost');
      return { requestId: request.requestId };
    },
  };
  const draft = { threadId: 'chat', targetRunnerId: 'destination-runner', operationId: 'known', text: 'Edit the opening' };
  await assert.rejects(requestBotWorker(ports, draft), /response lost/);
  assert.deepEqual(await requestBotWorker(ports, draft), { requestId: 'known' });
  assert.deepEqual(submitted[0], submitted[1]);
  await assert.rejects(requestBotWorker(ports, { ...draft, text: 'A different input' }), /different Bot worker/);
  ceiling = 'ask';
  await assert.rejects(requestBotWorker(ports, draft), /scope changed/);
  assert.equal(submitted.length, 2);
});
