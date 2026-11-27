import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotNoteErasureQueue, type NoteErasureIntent } from '../../../src/bots/memory-erasure-queue.ts';
import { BotRepository } from '../../../src/bots/repository.ts';
import { ReviewCheckpoints, type ReviewEvidence } from '../../../src/bots/review-checkpoints.ts';
import { atomicWriteFileSync } from '../../../src/fsutil.ts';
import { ScopedMemory } from '../../../src/bots/scoped-memory.ts';
import type { BotNoteErasure } from '../../../src/bots/device-workspace.ts';
import { tmpDir } from '../../helpers/fakes.ts';

function fixture() {
  const home = tmpDir();
  const root = join(home, 'bots');
  const repo = new BotRepository(root, 'runner');
  const bot = repo.create({ name: 'Editor' });
  const access = new ScopedMemory({ root, repo, protectErasure: () => {} });
  const owner = { kind: 'owner' } as const;
  const scope = { kind: 'bot', id: bot.id } as const;
  const memory = access.open(scope, owner, 'write');
  const time = '2026-11-27T00:00:00Z';
  const phrase = '再送しても復活しない覚書';
  const saved = memory.change({ op: 'add', text: phrase }, 'initial-write', 'empty', time);
  assert.ok(saved.note);
  let owns = true;
  let beforeJournal: (() => void) | undefined;
  const identity = repo.workspaceIdentity();
  const calls: BotNoteErasure[] = [];
  const queue = (answer: (input: BotNoteErasure) => Promise<{ done: boolean; waitingForLegacy?: true }>, eraseLocalReviews?: (intent: NoteErasureIntent) => void) => new BotNoteErasureQueue({
    home, identity: () => identity, canWrite: () => owns,
    eraseLocal: (intent, beforeWrite) => access.erase(intent.scope, owner, intent, () => {
      beforeWrite();
      beforeJournal?.();
    }),
    eraseLocalReviews,
    eraseMirror: input => { calls.push(input); return answer(input); },
  });
  const input: NoteErasureIntent = { ...identity, scope, entryId: saved.note.id, expectedRevision: saved.revision, operationId: 'erase-note-1', time };
  return { queue, input, memory, time, phrase, calls, home, root, repo, bot,
    interrupt: (fn?: () => void) => { beforeJournal = fn; }, ownership: (ownsNow: boolean) => { owns = ownsNow; } };
}

test('a saved intent completes the real journal and resumes the same remote deletion after restart and lost reply', async () => {
  const f = fixture();
  const outage = () => Promise.reject(new Error('mirror reply lost'));
  f.interrupt(() => { throw new Error('stopped after saving the intent'); });
  assert.throws(() => f.queue(outage).begin(f.input), /stopped after saving/);
  assert.equal(f.memory.list('2026-11-27').length, 1);
  const saved = readFileSync(join(f.home, 'bot-note-erasures.json'), 'utf8');
  assert.ok(saved.includes(f.input.operationId));
  assert.ok(!saved.includes(f.phrase));
  assert.equal(f.queue(outage).progress(f.input, f.input.scope)[0]?.state, 'queued');
  f.interrupt();
  await assert.rejects(f.queue(outage).resume(), /reply lost/);
  assert.equal(f.queue(outage).progress(f.input, f.input.scope)[0]?.state, 'waitingForSync');
  assert.deepEqual(f.memory.list('2026-11-27'), []);
  assert.deepEqual(await f.queue(async () => ({ done: false, waitingForLegacy: true })).resume(),
    { done: false, waitingForLegacy: true });
  assert.equal(f.queue(outage).progress(f.input, f.input.scope)[0]?.state, 'waitingForLegacy');
  assert.equal(f.queue(outage).pending(), true);
  assert.deepEqual(await f.queue(async () => ({ done: true })).resume(), { done: true });
  assert.equal(f.queue(outage).pending(), false);
  assert.deepEqual(f.queue(outage).progress(f.input, f.input.scope), []);
  assert.equal(await f.queue(outage).resume(), undefined);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.deepEqual(f.calls[1], f.calls[2]);
  assert.deepEqual(Object.keys(f.calls[0]!).sort(), ['entryId', 'epoch', 'scope', 'workspaceId']);
});

test('a refused local revision leaves no erasure, and a draining reply cannot remove an existing intent', async () => {
  const f = fixture();
  const starts = f.queue(async () => ({ done: true }));
  assert.throws(() => starts.begin({ ...f.input, expectedRevision: 'obsolete' }), /notes changed/);
  assert.equal(starts.pending(), false);
  assert.equal(f.calls.length, 0);
  starts.begin(f.input);
  let respond!: (value: { done: boolean }) => void;
  const inFlight = new Promise<{ done: boolean }>(resolve => { respond = resolve; });
  const draining = f.queue(() => inFlight);
  const prior = draining.resume();
  assert.equal(draining.resume(), prior, 'concurrent retries share the same delivery');
  f.ownership(false);
  respond({ done: true });
  assert.deepEqual(await prior, { done: false });
  assert.equal(starts.pending(), true);
  assert.equal(await draining.resume(), undefined);
  f.ownership(true);
  assert.deepEqual(await starts.resume(), { done: true });
  assert.equal(starts.pending(), false);
});

test('a supervised Bot runtime resumes the saved erasure in a new process and keeps the format requirement', async () => {
  const f = fixture();
  const script = join(f.home, 'run-erasure.mjs');
  const modulePath = (specifier: string) => JSON.stringify(new URL(specifier, import.meta.url).href);
  writeFileSync(script, `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { BotRuntime } from ${modulePath('../../../src/bots/runtime.ts')};
    import { RpcServer } from ${modulePath('../../../src/rpc.ts')};
    import { threadKey } from ${modulePath('../../../src/rpc-auth.ts')};
    import { CallerGate } from ${modulePath('../../../src/rpc-gate.ts')};
    import { nullLogger } from ${modulePath('../../../src/log.ts')};
    import { RunnerClient } from ${modulePath('../../../src/client.ts')};
    import { openManagedMemoryBackup } from ${modulePath('../../../src/bots/managed-memory-restore.ts')};
    import { PersonalMemory } from ${modulePath('../../../src/bots/ported/personal-memory.js')};
    import { makeHarness } from ${modulePath('../../helpers/fakes.ts')};
    const [home, mode] = process.argv.slice(2);
    const input = JSON.parse(process.env.TB_BOT_ERASE_TEST_INPUT);
    const harness = makeHarness(home);
    const runtime = new BotRuntime({
      home, runner: () => harness.runner, owner: () => 'runner',
      enabled: () => true, guarded: () => true, owns: () => true,
      canChangePrivacy: () => true,
      readyForNoteErasure: () => mode !== 'offline',
      eraseNoteFromMirror: async (sent) => {
        assert.deepEqual(sent, { workspaceId: input.workspaceId, epoch: input.epoch, scope: input.scope, entryId: input.entryId });
        if (mode === 'lost') throw new Error('interrupted after sync submission');
        return { done: true };
      },
    });
    const savedQueue = () => JSON.parse(readFileSync(join(home, 'bot-note-erasures.json'), 'utf8'));
    if (mode === 'old') {
      assert.throws(() => runtime.beginNoteErasure(input), /current Bot workspace owner/);
    } else if (mode === 'offline') {
      assert.equal(runtime.methods['bots.memory.erasureStatus']({ scope: input.scope }).available, false);
      assert.throws(() => runtime.methods['bots.memory.erase']({ ...input, confirmed: true }), /updated backend/);
    } else if (mode === 'backup') {
      const memory = new PersonalMemory(join(home, 'bots', 'memory', input.scope.id));
      const create = { scope: input.scope, expectedRevision: input.expectedRevision, operationId: 'create-backup' };
      const afterDrift = async (_files, _identity, apply) => {
        memory.change({ op: 'edit', entryId: input.entryId, text: 'changed while verifying' }, 'newer', create.expectedRevision, input.time);
        return apply();
      };
      await assert.rejects(runtime.createMemoryBackup(create, afterDrift), /notes changed/);
      assert.deepEqual(runtime.listMemoryBackups().backups, []);
      const edited = memory.revision();
      const backup = { ...create, expectedRevision: edited };
      const created = await runtime.createMemoryBackup(backup, async (_files, _identity, apply) => apply());
      assert.equal(created.backups.length, 1);
      assert.deepEqual(await runtime.createMemoryBackup(backup, async () => assert.fail('a retry must use the pack')), created);
      memory.change({ op: 'edit', entryId: input.entryId, text: 'follow-up' }, 'more-recent', edited, input.time);
      assert.deepEqual(await runtime.createMemoryBackup(backup, async () => assert.fail('a retry must use the pack')), created);
      await assert.rejects(runtime.createMemoryBackup({ ...backup, expectedRevision: memory.revision() }, async () => assert.fail('operation conflict')), /different Bot backup/);
    } else if (mode === 'lost') {
      input.expectedRevision = new PersonalMemory(join(home, 'bots', 'memory', input.scope.id)).revision();
      assert.throws(() => runtime.methods['bots.memory.erase']({ ...input }), /confirmed/);
      assert.throws(() => runtime.methods['bots.memory.erase']({ ...input, confirmed: true, epoch: 2 }), /ownership/);
      const token = 'isolated-note-erasure-owner';
      const server = new RpcServer({ host: '127.0.0.1', port: 0, token, runner: harness.runner,
        log: nullLogger, gate: new CallerGate({ runner: harness.runner }), methods: runtime.methods });
      const { port } = await server.listen();
      const url = 'ws://127.0.0.1:' + port + '/rpc';
      const caller = harness.runner.makeThread({ text: '', permissionMode: 'full' }).st.rec.id;
      const client = await RunnerClient.connect(url, token);
      const thread = await RunnerClient.connect(url, threadKey(token, caller), { threadId: caller });
      try {
        await assert.rejects(thread.call('bots.memory.erase', { ...input, confirmed: true }), /owner/);
        await assert.rejects(thread.call('bots.memory.erasureStatus', { scope: input.scope }), /owner/);
        const first = await client.call('bots.memory.erase', { ...input, confirmed: true });
        assert.deepEqual(await client.call('bots.memory.erase', { ...input, confirmed: true }), first);
      } finally {
        thread.close();
        client.close();
        await server.close();
      }
      assert.equal(runtime.methods['bots.memory.erasureStatus']({ scope: input.scope }).pending[0].entryId, input.entryId);
      assert.equal(runtime.workspaceIdleForMove(), false);
      await assert.rejects(runtime.resumeNoteErasures(), /interrupted after sync submission/);
      assert.equal(savedQueue().length, 1);
      assert.equal(readFileSync(join(home, 'bots-format.json'), 'utf8').trim(), '11');
      const [pack] = await import('node:fs').then(fs => fs.readdirSync(join(home, 'bot-backups')));
      const entries = openManagedMemoryBackup(home, { backupId: pack.replace(/\\.pack$/, '') }).files;
      assert.doesNotMatch(Buffer.concat(entries.map(file => file.data)).toString('utf8'), /changed while verifying|follow-up/);
    } else {
      assert.equal(savedQueue().length, 1);
      await runtime.resumeNoteErasures();
      assert.equal(savedQueue().length, 0);
    }
    process.disconnect();
  `);
  for (const [mode, guard] of [['old', '10'], ['offline', '11'], ['backup', '11'], ['lost', '11'], ['resume', '11']]) {
    const child = fork(script, [f.home, mode!], {
      env: { ...process.env, THREADBEAR_SUPERVISED: '1', THREADBEAR_BOT_FORMAT_GUARD: '1',
        THREADBEAR_BOT_FORMAT_GUARD_VERSION: guard, THREADBEAR_BOT_FORMAT_HOME: f.home, TB_BOT_ERASE_TEST_INPUT: JSON.stringify(f.input) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let details = '';
    child.stderr?.on('data', data => { details += String(data); });
    assert.equal((await once(child, 'close'))[0], 0, details);
  }
  assert.deepEqual(f.memory.list('2026-11-27'), []);
  assert.ok(!JSON.stringify(f.memory.history()).includes(f.phrase));
});

test('a note waiting for legacy retention does not block another saved erasure', async () => {
  const f = fixture();
  const queue = f.queue(async input => input.entryId === f.input.entryId
    ? { done: false, waitingForLegacy: true }
    : { done: true });
  queue.begin(f.input);
  const other = f.memory.change({ op: 'add', text: '続けて削除する別件の覚書' }, 'another-write', f.memory.revision(), f.time);
  assert.ok(other.note);
  queue.begin({ ...f.input, entryId: other.note.id, expectedRevision: other.revision, operationId: 'erase-note-2' });
  assert.deepEqual(await queue.resume(), { done: false, waitingForLegacy: true });
  assert.deepEqual(await queue.resume(), { done: true });
  assert.equal(queue.pending(), true);
  assert.deepEqual(f.calls.map(call => call.entryId), [f.input.entryId, other.note.id]);
});

test('all linked review files are cleared before the mirror can acknowledge the erasure', async () => {
  const f = fixture();
  const other = f.repo.create({ name: 'Reader' });
  const reviews = join(f.root, 'reviews');
  const store = new ReviewCheckpoints(reviews);
  const review = (botId: string, key: string) => {
    const reserved = f.repo.reserveConversation(botId, key);
    const link = f.repo.confirmConversation(key, reserved.threadId);
    const source: ReviewEvidence = { purpose: 'bot-memory-review', botId, conversationId: link.id,
      threadId: link.threadId, configRevision: 1, scopeRevision: f.input.expectedRevision,
      first: 1, through: 2, provider: 'claude', model: 'test', accountId: 'fixture' };
    store.record(source, 0, { rejected: 0, changes: [
      { op: 'edit', id: f.input.entryId, before: f.phrase, text: '同じ覚書の旧レビュー' },
      { op: 'add', text: '別の提案' },
    ] });
    return link;
  };
  const first = review(f.bot.id, 'memory-review-a');
  const second = review(f.bot.id, 'memory-review-b');
  const foreign = review(other.id, 'other-scope-review');
  let interrupt = true;
  const reopen = () => f.queue(async () => {
    assert.equal(store.reports(first.id)[0]?.changes[0]?.op, 'erased');
    assert.equal(store.reports(second.id)[0]?.changes[0]?.op, 'erased');
    return { done: true };
  }, () => {
    new ReviewCheckpoints(reviews, (file, body, mode) => {
      if (interrupt && file === join(reviews, second.id + '.json')) throw new Error('checkpoint interrupted');
      atomicWriteFileSync(file, body, mode);
    }).eraseMemoryCopies(f.bot.id, f.repo.conversations(f.bot.id), f.memory.history());
  });
  reopen().begin(f.input);
  await assert.rejects(reopen().resume(), /checkpoint interrupted/);
  assert.equal(reopen().progress(f.input, f.input.scope)[0]?.state, 'waitingForLocalCopies');
  assert.equal(f.calls.length, 0);
  assert.equal(store.reports(first.id)[0]?.changes[0]?.op, 'erased');
  assert.equal(store.reports(second.id)[0]?.changes[0]?.op, 'edit');
  interrupt = false;
  assert.deepEqual(await reopen().resume(), { done: true });
  assert.equal(store.reports(second.id)[0]?.changes[1]?.op, 'add');
  assert.equal(store.cursor(second.id), 2);
  assert.ok(JSON.stringify(store.reports(foreign.id)).includes(f.phrase));
});
