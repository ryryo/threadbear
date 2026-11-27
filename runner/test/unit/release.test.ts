import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { markGood, pointCurrentAt, readState, releaseHome, runnerVersion, staleRelease, statePath, takeRollbackNotice, type RunnerState } from '../../src/release.ts';
import { restartPath, threadBinDir } from '../../src/restart.ts';
import { execFileSync } from 'node:child_process';
import { NO_LINKS_ON_WINDOWS } from '../helpers/platform.ts';
import { RunnerClient } from '../../src/client.ts';
import { nullLogger } from '../../src/log.ts';
import { PATIENCE_MS, patiently } from '../helpers/patience.ts';
import { BOT_FIXTURE_REPLY, cleanRunnerEnv, configureBotFixture, installBotFixtureCli, installLaunch, isolatedRunnerEnv, makeRelease, RUNNER_DIR } from '../helpers/managed-runner.ts';

const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, 'package.json'), 'utf8')).version as string;

function writeState(home: string, state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(statePath(home)), { recursive: true });
  fs.writeFileSync(statePath(home), JSON.stringify(state));
}

test('the version is <package version>+<release id> in a release, +source otherwise', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  assert.deepEqual(runnerVersion(root), { version: '1.2.3+source' });
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({ id: '20261026T101500Z-abc1234', commit: 'abc1234', dirty: false, builtAt: '', node: 'v24' }));
  assert.deepEqual(runnerVersion(root), { version: '1.2.3+20261026T101500Z-abc1234', release: '20261026T101500Z-abc1234' });
  // A release.json with no id doesn't count.
  fs.writeFileSync(path.join(root, 'release.json'), '{}');
  assert.deepEqual(runnerVersion(root), { version: '1.2.3+source' });
});

test('lastGood is set in place, keeping everything else; a missing state.json is left alone', () => {
  const home = tmpDir();
  assert.equal(markGood(home, 'r2', nullLogger), false);
  assert.equal(fs.existsSync(path.join(home, 'runner')), false, 'no runner folder made for a source run');
  writeState(home, { current: 'r2', previous: 'r1', lastGood: 'r1', boots: [{ release: 'r2', at: 'x' }], somethingNew: 1 });
  assert.equal(markGood(home, undefined, nullLogger), false, 'nothing to mark from source');
  assert.equal(markGood(home, 'r2', nullLogger), true);
  const s = readState(home) as RunnerState & { somethingNew: number };
  assert.equal(s.lastGood, 'r2');
  assert.equal(s.previous, 'r1');
  assert.equal(s.somethingNew, 1);
  assert.deepEqual(s.boots, [{ release: 'r2', at: 'x' }]);
  assert.equal(markGood(home, 'r2', nullLogger), false, 'already good: no write');
  assert.deepEqual(fs.readdirSync(path.join(home, 'runner')), ['state.json'], 'no temp files left');
});

test('a rollback is reported once', () => {
  const home = tmpDir();
  assert.equal(takeRollbackNotice(home, nullLogger), undefined);
  writeState(home, { current: 'r1', previous: 'r2', lastGood: 'r1', boots: [], rolledBack: { from: 'r2', to: 'r1', at: '2026-10-26T10:00:00.000Z' } });
  assert.deepEqual(takeRollbackNotice(home, nullLogger, Date.parse('2026-10-26T10:01:00.000Z')), { message: 'Release r2 kept crashing at startup, so the runner went back to r1.', from: 'r2' });
  assert.equal(readState(home)?.rolledBack?.reportedAt, '2026-10-26T10:01:00.000Z');
  assert.equal(takeRollbackNotice(home, nullLogger), undefined);
});

// ------------------------------------------------- the real entry point

function startRunner(entry: string, home: string, extra: Record<string, string> = {}) {
  let out = '';
  const proc: ChildProcess = spawn(process.execPath, [entry], {
    env: { ...isolatedRunnerEnv(home), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)));
  const listening = new Promise<number>((resolve, reject) => {
    proc.stdout!.on('data', () => {
      const m = /listening on (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    void exited.then((code) => reject(new Error(`exited ${code}: ${out}`)));
  });
  listening.catch(() => {});
  return { proc, out: () => out, listening, exited };
}

async function connectOnce(home: string, port: number) {
  const token = fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim();
  // The supervised child runs at background priority during the check.
  const c = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, token, { authTimeoutMs: PATIENCE_MS });
  const notices: string[] = [];
  c.onNotification((m, p) => m === 'runner.notice' && notices.push(p.message));
  const hello = await c.call('hello', { client: 'test', version: '1' });
  await new Promise((r) => setTimeout(r, 50));
  return { c, hello, notices };
}

async function connect(home: string, port: number) {
  const until = Date.now() + PATIENCE_MS;
  for (;;) {
    try {
      return await connectOnce(home, port);
    } catch (error) {
      // A busy machine can time out identifying the socket's process. The
      // desktop retries that specific refusal without changing credentials.
      if (!(error instanceof Error) || !error.message.includes('connection closed (4503)') || Date.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

test('a release reports its id, marks itself good, reports a rollback, and restarts by exiting 0', async () => {
  const home = tmpDir();
  const id = '20261026T101500Z-abc1234';
  const dir = makeRelease(home, id);
  writeState(home, { current: id, previous: 'older', lastGood: 'older', boots: [{ release: id, at: new Date().toISOString() }], rolledBack: { from: 'broken', to: id, at: new Date().toISOString() } });
  // Long enough that a busy Mac still gets through the checks below before
  // the release marks itself good (3 s wasn't, at background priority).
  const a = startRunner(path.join(dir, 'src', 'main.ts'), home, { THREADBEAR_GOOD_AFTER_MS: '10000' });
  try {
    const port = await a.listening;
    const { c, hello, notices } = await connect(home, port);
    assert.equal(hello.runnerVersion, `${PKG_VERSION}+${id}`);
    const rollback = `Release broken kept crashing at startup, so the runner went back to ${id}.`;
    await patiently(() => notices.includes(rollback));
    assert.ok(notices.includes(rollback), notices.join('; '));
    const status = await c.call('runner.status');
    assert.equal(status.release, id);
    assert.equal(status.version, `${PKG_VERSION}+${id}`);
    assert.equal(status.home, home);
    assert.deepEqual(status.running, []);

    assert.equal(readState(home)?.lastGood, 'older', 'not good yet');
    for (const until = Date.now() + PATIENCE_MS; readState(home)?.lastGood !== id && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const s = readState(home)!;
    assert.equal(s.lastGood, id);
    assert.ok(s.rolledBack?.reportedAt);
    assert.equal(s.previous, 'older');

    // Nothing running, so the restart is immediate: the reply, then exit 0.
    assert.deepEqual(await c.call('runner.restart', { reason: 'test' }), { scheduled: true, waitingFor: [] });
    assert.equal(await a.exited, 0);
    assert.match(a.out(), /listening/);
    const saved = JSON.parse(fs.readFileSync(restartPath(home), 'utf8'));
    assert.equal(saved.fromVersion, `${PKG_VERSION}+${id}`);
    assert.ok(saved.shutdownAt);
    c.close();

    // launchd would start it again: the restart is handled and the rollback
    // isn't reported a second time.
    const b = startRunner(path.join(dir, 'src', 'main.ts'), home);
    try {
      const port2 = await b.listening;
      const second = await connect(home, port2);
      assert.deepEqual(second.notices.filter((n) => /crashing/.test(n)), []);
      assert.equal(fs.existsSync(restartPath(home)), false);
      second.c.close();
      b.proc.kill('SIGTERM');
      assert.equal(await b.exited, 0);
    } finally {
      b.proc.kill('SIGKILL');
    }
  } finally {
    a.proc.kill('SIGKILL');
  }
});

test('a runner run from source says +source and leaves state.json alone', async () => {
  const home = tmpDir();
  const state = { current: 'r1', previous: null, lastGood: 'r1', boots: [] };
  writeState(home, state);
  const r = startRunner(path.join(RUNNER_DIR, 'src', 'main.ts'), home, { THREADBEAR_GOOD_AFTER_MS: '50' });
  try {
    const port = await r.listening;
    const { c, hello } = await connect(home, port);
    assert.equal(hello.runnerVersion, `${PKG_VERSION}+source`);
    assert.equal((await c.call('runner.status')).release, undefined);
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(readState(home), state);
    c.close();
    r.proc.kill('SIGTERM');
    assert.equal(await r.exited, 0);
  } finally {
    r.proc.kill('SIGKILL');
  }
});

// ------------------------------------------------- under launch.mjs

// The port the nth runner the supervisor started listens on.
async function nthListening(out: () => string, n: number, ms = PATIENCE_MS): Promise<number> {
  const end = Date.now() + ms;
  for (;;) {
    const ports = [...out().matchAll(/listening on (\d+)/g)].map((m) => Number(m[1]));
    if (ports.length >= n) return ports[n - 1];
    if (Date.now() > end) throw new Error(`no listening line #${n}:\n${out()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a managed Bot release protects both storage formats and reopens its private workspace after restarting', async () => {
  const home = tmpDir();
  const id = '20261127T000000Z-abc1234';
  const release = makeRelease(home, id);
  for (const file of ['LICENSE', 'NOTICE']) {
    assert.deepEqual(fs.readFileSync(path.join(release, 'src', 'bots', 'ported', file)), fs.readFileSync(path.join(RUNNER_DIR, '..', 'third_party', 'dsbot', file)));
  }
  const launch = installLaunch(home, id);
  configureBotFixture(home);
  const marker = path.join(home, 'bots-format.json');
  const r = startRunner(launch, home, { THREADBEAR_RESTART_MS: '50' });
  try {
    const { c } = await connect(home, await nthListening(r.out, 1));
    try {
      assert.equal((await c.call('bots.status')).available, true);
      assert.deepEqual(await c.call('bots.list'), { bots: [] });
      assert.equal(fs.existsSync(marker), false);
      const { bot } = await c.call('bots.create', { name: '編集者' });
      assert.equal(fs.readFileSync(marker, 'utf8').trim(), '1');
      const { conversation: a } = await c.call('bots.conversations.create', { botId: bot.id, operationId: 'conversation-a' });
      const { note } = await c.call('bots.memory.add', { botId: bot.id, threadId: a.threadId, text: '見出しは短くする' });
      const { conversation: b } = await c.call('bots.conversations.create', { botId: bot.id, operationId: 'conversation-b' });
      assert.notEqual(a.threadId, b.threadId);
      const folder = fs.realpathSync.native(tmpDir());
      const { bot: protectedBot } = await c.call('bots.settings.privacy', { botId: bot.id, expectedRevision: bot.revision, folder, operationId: randomUUID() });
      assert.equal(protectedBot.privacy.moving, undefined);
      assert.equal(fs.readFileSync(marker, 'utf8').trim(), '2');
      await c.call('runner.restart', { reason: 'Bot workspace verification' });
      const { c: after } = await connect(home, await nthListening(r.out, 2));
      try {
        assert.deepEqual(await after.call('bots.list'), { bots: [protectedBot] });
        assert.deepEqual(await after.call('bots.memory.read', { botId: bot.id, threadId: b.threadId }), { notes: [note] });
        const { threads } = await after.call('threads.list', { ids: [a.threadId, b.threadId] });
        assert.equal(threads.length, 2);
        assert.ok(threads.every((thread: { cwd: string; privateBotId?: string }) => thread.cwd === folder && thread.privateBotId === bot.id));
      } finally {
        after.close();
      }
    } finally {
      c.close();
    }
    r.proc.kill('SIGTERM');
    assert.equal(await r.exited, 0);
  } finally {
    if (r.proc.exitCode === null && r.proc.signalCode === null) r.proc.kill('SIGTERM');
  }
});

test('a managed Bot request keeps its full result and receipt after a Runner restart', { skip: process.platform === 'win32' }, async () => {
  const home = tmpDir();
  const id = '20261127T000000Z-abc1234';
  makeRelease(home, id);
  const launch = installLaunch(home, id);
  configureBotFixture(home);
  const fake = installBotFixtureCli(home);
  const marker = path.join(home, 'bots-format.json');
  const run = startRunner(launch, home, { THREADBEAR_CLAUDE_PATH: fake, THREADBEAR_RESTART_MS: '50' });
  try {
    const { c } = await connect(home, await nthListening(run.out, 1));
    try {
      assert.equal((await c.call('bots.status')).requests, true);
      const { bot: editor } = await c.call('bots.create', { name: '編集者' });
      const { bot: writer } = await c.call('bots.create', { name: 'ライター' });
      const { conversation: source } = await c.call('bots.conversations.create', { botId: editor.id, operationId: 'source' });
      const { conversation: destination } = await c.call('bots.conversations.create', { botId: writer.id, operationId: 'destination' });
      assert.equal(fs.readFileSync(marker, 'utf8').trim(), '1');
      const params = { threadId: source.threadId, botId: writer.id, name: '見出し', text: '見出しを提案してください。', when: 'queue' };
      const accepted = await c.call('bots.requests.send', params);
      assert.equal(accepted.threadId, destination.threadId);
      assert.equal(fs.readFileSync(marker, 'utf8').trim(), '3');
      const read = { threadId: source.threadId, requestId: accepted.requestId };
      const statePath = path.join(home, 'bots', 'requests.json');
      await patiently(() => fs.existsSync(statePath) && fs.readFileSync(statePath, 'utf8').includes('"status":"returned"'));
      assert.deepEqual((await c.call('bots.requests.get', read)).result, { text: BOT_FIXTURE_REPLY, whole: true }, run.out());
      await c.call('runner.restart', { reason: 'Bot request receipt verification' });
      const { c: reopened } = await connect(home, await nthListening(run.out, 2));
      try {
        assert.deepEqual(await reopened.call('bots.requests.send', params), accepted);
        assert.deepEqual((await reopened.call('bots.requests.get', read)).result, { text: BOT_FIXTURE_REPLY, whole: true });
        const { events } = await reopened.call('threads.events', { threadId: destination.threadId, limit: 100 });
        assert.equal(events.filter((event: { type: string; text?: string }) => event.type === 'user.message' && event.text === params.text).length, 1);
      } finally {
        reopened.close();
      }
    } finally {
      c.close();
    }
    run.proc.kill('SIGTERM');
    assert.equal(await run.exited, 0);
  } finally {
    if (run.proc.exitCode === null && run.proc.signalCode === null) run.proc.kill('SIGTERM');
  }
});

test('a supervised handover keeps a running Bot request and the new primary reads its reply once', { skip: process.platform === 'win32' }, async () => {
  const home = tmpDir();
  const id = '20261127T000000Z-abc1234';
  makeRelease(home, id);
  const launch = installLaunch(home, id);
  configureBotFixture(home);
  const gate = path.join(home, 'reply-ready');
  const fake = installBotFixtureCli(home, gate);
  const run = startRunner(launch, home, { THREADBEAR_CLAUDE_PATH: fake, THREADBEAR_RESTART_MS: '50', THREADBEAR_LOG_STDERR: '1' });
  try {
    const { c } = await connectAfterRestart(home, await nthListening(run.out, 1));
    try {
      const { bot: editor } = await c.call('bots.create', { name: '編集者' });
      const { bot: writer } = await c.call('bots.create', { name: 'ライター' });
      const { conversation: source } = await c.call('bots.conversations.create', { botId: editor.id, operationId: 'source' });
      const { conversation: target } = await c.call('bots.conversations.create', { botId: writer.id, operationId: 'target' });
      const params = { threadId: source.threadId, botId: writer.id, name: 'handed-over', text: '見出しを提案してください。', when: 'queue' };
      const accepted = await c.call('bots.requests.send', params);
      const read = { threadId: source.threadId, requestId: accepted.requestId };
      await patiently(() => fs.existsSync(gate + '.waiting'));
      assert.ok(fs.existsSync(gate + '.waiting'), 'the fixture CLI received the request and is still waiting to reply');
      const restart = await c.call('runner.restart', { when: 'idle', reason: 'Isolated Bot handover verification' });
      assert.ok(restart.handover?.keeps.includes(target.threadId));
      const { c: primary } = await connectAfterRestart(home, await nthListening(run.out, 2));
      try {
        const status = await primary.call('runner.status');
        assert.ok(status.draining?.some((peer: { threads: string[] }) => peer.threads.includes(target.threadId)), 'the new primary should see the old process keeping the receiving thread');
        assert.equal((await primary.call('bots.requests.get', read)).result, undefined);
        fs.writeFileSync(gate, '');
        const requests = path.join(home, 'bots', 'requests.json');
        await patiently(() => fs.readFileSync(requests, 'utf8').includes('"status":"returned"'));
        const reply = (await primary.call('bots.requests.get', read)).result;
        assert.ok(reply?.whole && reply.text === BOT_FIXTURE_REPLY);
        assert.deepEqual(await primary.call('bots.requests.send', params), accepted);
        const { events } = await primary.call('threads.events', { threadId: target.threadId, limit: 100 });
        assert.equal(events.filter((event: { type: string; text?: string }) => event.type === 'user.message' && event.text === params.text).length, 1);
      } finally {
        primary.close();
      }
    } finally {
      c.close();
    }
    run.proc.kill('SIGTERM');
    assert.equal(await run.exited, 0);
  } catch (error) {
    throw new Error(`Isolated Bot handover failed:\n${run.out()}`, { cause: error });
  } finally {
    if (run.proc.exitCode === null && run.proc.signalCode === null) run.proc.kill('SIGTERM');
  }
});

test('a kept Bot uses its original tools to save a note and send a new request through the primary', { skip: process.platform === 'win32' }, async () => {
  const home = tmpDir();
  const id = '20261127T000000Z-abc1234';
  makeRelease(home, id);
  const launch = installLaunch(home, id);
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  configureBotFixture(home, port);
  const gate = path.join(home, 'handover-tools');
  const trigger = 'Use the tools after the handover';
  const note = { name: 'bot_remember', arguments: { operationId: 'edit-style', text: '見出しは短くする' } };
  const request = { name: 'message_bot', arguments: {
    bot: 'Writer', request: 'handover-edit', text: '見出し案を一つください。', when: 'queue',
  } };
  const fake = installBotFixtureCli(home, gate, { trigger, calls: [note, note, request, request] });
  const run = startRunner(launch, home, { THREADBEAR_CLAUDE_PATH: fake, THREADBEAR_PORT: String(port), THREADBEAR_LOG_STDERR: '1' });
  try {
    const { c } = await connectAfterRestart(home, await nthListening(run.out, 1));
    try {
      const { bot: editor } = await c.call('bots.create', { name: 'Editor' });
      const { bot: writer } = await c.call('bots.create', { name: 'Writer' });
      const { conversation: source } = await c.call('bots.conversations.create', { botId: editor.id, operationId: 'source' });
      const { conversation: target } = await c.call('bots.conversations.create', { botId: writer.id, operationId: 'target' });
      for (const threadId of [source.threadId, target.threadId]) await c.call('threads.update', { threadId, permissionMode: 'full' });
      await c.call('threads.send', { threadId: source.threadId, text: trigger });
      await patiently(() => fs.existsSync(gate + '.waiting'));
      assert.ok(fs.existsSync(gate + '.waiting'), 'the kept CLI should hold its original tool bindings');
      const restart = await c.call('runner.restart', { when: 'idle', reason: 'Isolated Bot tools handover' });
      assert.ok(restart.handover?.keeps.includes(source.threadId));
      const { c: primary } = await connectAfterRestart(home, await nthListening(run.out, 2));
      try {
        const status = await primary.call('runner.status');
        assert.ok(status.draining?.some((peer: { threads: string[] }) => peer.threads.includes(source.threadId)));
        fs.writeFileSync(gate, '');
        await patiently(() => fs.existsSync(gate + '.tools-result'));
        assert.ok(fs.existsSync(gate + '.tools-result'), 'the old CLI should get all tool responses');
        const responses: { response?: { mcp_response?: { result?: { content?: { text: string }[]; isError?: boolean } } } }[] =
          JSON.parse(fs.readFileSync(gate + '.tools-result', 'utf8'));
        const results = responses.map(reply => reply.response?.mcp_response?.result);
        assert.ok(results.every(result => result && !result.isError), JSON.stringify(responses));
        const texts = results.map(result => result!.content?.[0]?.text);
        assert.match(texts[0] ?? '', /Saved note/);
        assert.equal(texts[0], texts[1]);
        assert.match(texts[2] ?? '', /Request /);
        assert.equal(texts[2], texts[3]);
        const { notes } = await primary.call('bots.memory.read', { botId: editor.id, threadId: source.threadId });
        assert.deepEqual(notes.map((note: { text: string }) => note.text), ['見出しは短くする']);
        const requests = path.join(home, 'bots', 'requests.json');
        await patiently(() => fs.readFileSync(requests, 'utf8').includes('"status":"returned"'));
        const { requests: rows } = await primary.call('bots.requests.list', { threadId: source.threadId });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].state.status, 'returned');
        const { events } = await primary.call('threads.events', { threadId: target.threadId, limit: 100 });
        assert.equal(events.filter((event: { type: string; text?: string }) =>
          event.type === 'user.message' && event.text === request.arguments.text).length, 1);
      } finally {
        primary.close();
      }
    } finally {
      c.close();
    }
    run.proc.kill('SIGTERM');
    assert.equal(await run.exited, 0);
  } catch (error) {
    throw new Error(`Isolated Bot tools handover failed:\n${run.out()}`, { cause: error });
  } finally {
    if (run.proc.exitCode === null && run.proc.signalCode === null) run.proc.kill('SIGTERM');
  }
});

test('planned restarts under launch.mjs are clean stops, so several in a row are not a crash loop', async () => {
  const home = tmpDir();
  const older = '20261025T101500Z-0000001';
  const id = '20261026T101500Z-abc1234';
  makeRelease(home, older);
  makeRelease(home, id);
  const launch = installLaunch(home, id);
  writeState(home, { current: id, previous: older, lastGood: older, boots: [] });
  // The supervisor starts it again after each planned restart; four of
  // them well inside a minute, none long enough to be marked good.
  const r = startRunner(launch, home, { THREADBEAR_GOOD_AFTER_MS: '600000', THREADBEAR_RESTART_MS: '50' });
  try {
    for (let i = 0; i < 5; i++) {
      const port = await nthListening(r.out, i + 1);
      const { c, hello } = await connect(home, port);
      assert.equal(hello.runnerVersion, `${PKG_VERSION}+${id}`, `start ${i + 1} runs the new release`);
      if (i < 4) assert.deepEqual(await c.call('runner.restart', { reason: `restart ${i + 1}` }), { scheduled: true, waitingFor: [] });
      c.close();
    }
    // Stopping the supervisor stops its runner cleanly too.
    r.proc.kill('SIGTERM');
    assert.equal(await r.exited, 0);
  } finally {
    r.proc.kill('SIGKILL');
  }
  const s = readState(home)!;
  assert.equal(s.rolledBack, undefined);
  assert.equal(s.current, id);
  assert.equal(s.lastGood, older);
  assert.deepEqual(
    s.boots.map((b) => [b.release, b.clean]),
    Array.from({ length: 5 }, () => [id, true]),
  );
  // Each boot is the child's pid, not the supervisor's.
  assert.ok(s.boots.every((b) => typeof b.pid === 'number' && b.pid !== r.proc.pid));
});

test('launch.mjs stops a release that never starts listening, and that start counts as a crash', async () => {
  const home = tmpDir();
  const id = '20261026T101500Z-0000002';
  const dir = path.join(home, 'runner', 'releases', id);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  // Says it reports listening, then hangs at startup.
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), 'export const REPORTS_LISTENING = true;\nsetInterval(() => {}, 1000);\n');
  const launch = installLaunch(home, id);
  writeState(home, { current: id, previous: null, lastGood: null, boots: [] });
  const r = startRunner(launch, home, { THREADBEAR_START_TIMEOUT_MS: '300' });
  try {
    assert.equal(await r.exited, 1);
    assert.match(r.out(), new RegExp(`release ${id} wasn't listening after 0 s; stopping it so it counts as a failed start`));
    const s = readState(home)!;
    assert.equal(s.boots.length, 1);
    assert.equal(s.boots[0].clean, undefined);
  } finally {
    r.proc.kill('SIGKILL');
  }
});

// ------------------------------------------------- the supervisor channel

// Runs `code` (an ES module importing release.ts) as a child with an IPC
// channel, the way launch.mjs starts a runner.
function ipcChild(code: string, env: Record<string, string> = { THREADBEAR_SUPERVISED: '1' }) {
  const src = path.join(RUNNER_DIR, 'src', 'release.ts');
  const proc = spawn(process.execPath, ['--input-type=module', '-e', `import * as release from ${JSON.stringify(src)};\n${code}`], {
    env: { ...cleanRunnerEnv(), ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const messages: unknown[] = [];
  proc.on('message', (m) => messages.push(m));
  const exited = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
  return { proc, out: () => out, messages, exited };
}

async function until(what: string, fn: () => boolean, ms = PATIENCE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('supervised() needs both THREADBEAR_SUPERVISED and an IPC channel', async () => {
  const a = ipcChild('console.log(JSON.stringify(release.supervised())); process.disconnect();');
  assert.equal(await a.exited, 0, a.out());
  assert.equal(a.out().trim(), 'true');
  const b = ipcChild('console.log(JSON.stringify(release.supervised())); process.disconnect();', {});
  assert.equal(await b.exited, 0, b.out());
  assert.equal(b.out().trim(), 'false');
  const reply = ipcChild('const r = await release.requestHandover(); console.log(JSON.stringify(r)); process.disconnect();', {});
  assert.equal(await reply.exited, 0, reply.out());
  assert.deepEqual(JSON.parse(reply.out()), { ok: false, error: 'not started by a launch.mjs that supervises' });
});

test('tellLaunchListening tells the supervisor over IPC', async () => {
  const c = ipcChild('release.tellLaunchListening(); setTimeout(() => process.disconnect(), 100);');
  assert.equal(await c.exited, 0, c.out());
  assert.deepEqual(c.messages, [{ type: 'listening' }]);
});

test("requestHandover: the supervisor's answer, a refusal, and no answer in time", async () => {
  const code = 'const r = await release.requestHandover(Number(process.env.WAIT_MS)); console.log(JSON.stringify(r)); process.disconnect();';
  const ok = ipcChild(code, { THREADBEAR_SUPERVISED: '1', WAIT_MS: '5000' });
  await until('the handover request', () => ok.messages.length > 0);
  assert.deepEqual(ok.messages, [{ type: 'handover' }]);
  // Something else first is ignored.
  ok.proc.send({ type: 'other' });
  ok.proc.send({ type: 'handover', ok: true, pid: 4242 });
  assert.equal(await ok.exited, 0, ok.out());
  assert.deepEqual(JSON.parse(ok.out()), { ok: true, pid: 4242 });

  const no = ipcChild(code, { THREADBEAR_SUPERVISED: '1', WAIT_MS: '5000' });
  await until('the handover request', () => no.messages.length > 0);
  no.proc.send({ type: 'handover', ok: false, error: 'only the newest runner can hand over' });
  assert.equal(await no.exited, 0, no.out());
  assert.deepEqual(JSON.parse(no.out()), { ok: false, error: 'only the newest runner can hand over' });

  const slow = ipcChild(code, { THREADBEAR_SUPERVISED: '1', WAIT_MS: '200' });
  assert.equal(await slow.exited, 0, slow.out());
  assert.deepEqual(JSON.parse(slow.out()), { ok: false, error: 'no answer from the supervisor in 0 s' });
});

test('onSupervisorGone fires when the IPC channel closes', async () => {
  const c = ipcChild("release.onSupervisorGone(() => { console.log('gone'); process.exit(0); }); setInterval(() => {}, 1000);");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.out(), '');
  c.proc.disconnect();
  assert.equal(await c.exited, 0, c.out());
  assert.equal(c.out().trim(), 'gone');
});

// A data dir with releases whose bin/tb prints its release's id, like the
// LaunchAgent's (<home>/runner/releases/<id>/ with release.json).
function releasesHome(ids: string[]): { home: string; root: (id: string) => string } {
  const home = tmpDir();
  const root = (id: string) => path.join(home, 'runner', 'releases', id);
  for (const id of ids) {
    fs.mkdirSync(path.join(root(id), 'src'), { recursive: true });
    fs.mkdirSync(path.join(root(id), 'bin'));
    fs.writeFileSync(path.join(root(id), 'src', 'main.ts'), '');
    fs.writeFileSync(path.join(root(id), 'release.json'), JSON.stringify({ id, commit: 'abc', dirty: false, builtAt: '', node: 'v24' }));
    fs.writeFileSync(path.join(root(id), 'bin', 'tb'), `#!/bin/sh\necho ${id}\n`, { mode: 0o755 });
  }
  return { home, root };
}

test("a thread's PATH follows the current release, so a CLI that outlives a runner update runs the new tb", NO_LINKS_ON_WINDOWS, () => {
  const { home, root } = releasesHome(['r1', 'r2', 'r3']);
  pointCurrentAt(home, 'r1');
  // The r1 runner starts a thread: its PATH names current/bin, not r1's own.
  const first = threadBinDir(path.join(root('r1'), 'bin'));
  assert.equal(first, path.join(home, 'runner', 'current', 'bin'));
  assert.equal(releaseHome(root('r1')), home);
  const env = { PATH: [first, '/usr/bin', '/bin'].join(path.delimiter) };
  const tb = () => execFileSync('sh', ['-c', 'tb'], { env, encoding: 'utf8' }).trim();
  assert.equal(tb(), 'r1');
  // Two deploys later, with the CLI's PATH as it started (24 Nov: a day-old
  // thread's tb land still had a hold main had taken out), and r1 pruned.
  pointCurrentAt(home, 'r2');
  pointCurrentAt(home, 'r3');
  fs.rmSync(root('r1'), { recursive: true });
  assert.equal(tb(), 'r3');
  // A rollback moves the link back the same way (launch.mjs, pointCurrent).
  pointCurrentAt(home, 'r2');
  assert.equal(tb(), 'r2');
});

test("a checkout's runner, Windows, and a release with no current link keep the runner's own bin/", () => {
  const { home, root } = releasesHome(['r1']);
  const own = path.join(root('r1'), 'bin');
  // No current link yet.
  assert.equal(threadBinDir(own), own);
  if (process.platform !== 'win32') pointCurrentAt(home, 'r1');
  // Windows has a text file for current, which can't go on a PATH.
  assert.equal(threadBinDir(own, 'win32'), own);
  // A checkout (a dev runner): no release.json, not under releases/.
  const checkout = path.join(tmpDir(), 'runner');
  fs.mkdirSync(path.join(checkout, 'bin'), { recursive: true });
  assert.equal(threadBinDir(path.join(checkout, 'bin')), path.join(checkout, 'bin'));
  assert.equal(releaseHome(checkout), undefined);
  // This test's own runner code is a checkout's too.
  assert.equal(threadBinDir(), path.join(RUNNER_DIR, 'bin'));
});

test('tb knows when it is not the release current names', NO_LINKS_ON_WINDOWS, () => {
  const { home, root } = releasesHome(['r1', 'r2']);
  pointCurrentAt(home, 'r1');
  assert.equal(staleRelease(root('r1')), undefined);
  pointCurrentAt(home, 'r2');
  assert.deepEqual(staleRelease(root('r1')), { mine: 'r1', current: 'r2', tb: path.join(home, 'runner', 'current', 'bin', 'tb') });
  assert.equal(staleRelease(root('r2')), undefined);
  // A link to a release that isn't there says nothing.
  fs.rmSync(root('r2'), { recursive: true });
  assert.equal(staleRelease(root('r1')), undefined);
  // Nor does a checkout's tb.
  assert.equal(staleRelease(RUNNER_DIR), undefined);
});

test("on Windows tb names the current release's tb.cmd", () => {
  const { home, root } = releasesHome(['r1', 'r2']);
  fs.mkdirSync(path.join(home, 'runner'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runner', 'current'), 'r2\n');
  assert.deepEqual(staleRelease(root('r1'), 'win32'), { mine: 'r1', current: 'r2', tb: path.join(root('r2'), 'bin', 'tb.cmd') });
});
test('a managed Bot background task reopens its own Thread and result without replacing its origin', { skip: process.platform === 'win32' }, async () => {
  const home = tmpDir();
  const id = '20261127T000000Z-abc1234';
  makeRelease(home, id);
  const launch = installLaunch(home, id);
  configureBotFixture(home);
  const cli = installBotFixtureCli(home);
  const run = startRunner(launch, home, { THREADBEAR_CLAUDE_PATH: cli, THREADBEAR_RESTART_MS: '50' });
  try {
    const { c } = await connect(home, await nthListening(run.out, 1));
    try {
      assert.equal((await c.call('bots.status')).tasks, true);
      const { bot } = await c.call('bots.create', { name: '編集者' });
      const { conversation } = await c.call('bots.conversations.create', { botId: bot.id, operationId: 'conversation' });
      const input = { threadId: conversation.threadId, title: '見出し案', brief: '背景で見出しを考える', operationId: 'test-task' };
      const { task } = await c.call('bots.tasks.start', input);
      assert.notEqual(task.threadId, conversation.threadId);
      assert.equal(fs.readFileSync(path.join(home, 'bots-format.json'), 'utf8').trim(), '4');
      const file = path.join(home, 'bots', 'tasks.json');
      await patiently(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"sent":true'));
      assert.deepEqual((await c.call('bots.tasks.read', { taskId: task.id })).result, { text: BOT_FIXTURE_REPLY, whole: true }, run.out());
      await c.call('runner.restart', { reason: 'Bot task verification' });
      const { c: reopened } = await connect(home, await nthListening(run.out, 2));
      try {
        const { task: replayed } = await reopened.call('bots.tasks.start', input);
        assert.equal(replayed.id, task.id);
        assert.equal(replayed.threadId, task.threadId);
        assert.deepEqual((await reopened.call('bots.get', { botId: bot.id })).conversations, [conversation]);
        assert.deepEqual((await reopened.call('bots.tasks.read', { taskId: task.id })).result, { text: BOT_FIXTURE_REPLY, whole: true });
        const { events } = await reopened.call('threads.events', { threadId: conversation.threadId, limit: 100 });
        assert.equal(events.filter((event: { type: string; botInput?: { task?: { id: string; role: string } } }) =>
          event.type === 'user.message' && event.botInput?.task?.id === task.id && event.botInput?.task?.role === 'result').length, 1);
      } finally {
        reopened.close();
      }
    } finally {
      c.close();
    }
    run.proc.kill('SIGTERM');
    assert.equal(await run.exited, 0);
  } finally {
    if (run.proc.exitCode === null && run.proc.signalCode === null) run.proc.kill('SIGTERM');
  }
});

test('a managed Bot team and permission limit persist after restart and a failed write restores the prior Thread mode', { skip: process.platform === 'win32' }, async () => {
  const home = tmpDir();
  const id = '20261127T000000Z-abc1234';
  makeRelease(home, id);
  const launch = installLaunch(home, id);
  configureBotFixture(home);
  const cli = installBotFixtureCli(home);
  const run = startRunner(launch, home, { THREADBEAR_CLAUDE_PATH: cli, THREADBEAR_RESTART_MS: '50' });
  try {
    const { c } = await connect(home, await nthListening(run.out, 1));
    try {
      assert.equal((await c.call('bots.status')).teams, true);
      const { bot } = await c.call('bots.create', { name: '編集者' });
      const { conversation } = await c.call('bots.conversations.create', { botId: bot.id, operationId: 'team-chat' });
      const from = { threadId: conversation.threadId };
      await c.call('threads.update', { ...from, permissionMode: 'full' });
      const cap = { botId: bot.id, expectedRevision: bot.revision, ceiling: 'ask' };
      const file = path.join(home, 'bots', 'state.json');
      fs.renameSync(file, file + '.saved');
      fs.mkdirSync(file);
      try {
        await assert.rejects(c.call('bots.settings.permissionCeiling', cap));
        assert.equal((await c.call('threads.list', { ids: [from.threadId] })).threads[0]?.permissionMode, 'full');
      } finally {
        fs.rmdirSync(file);
        fs.renameSync(file + '.saved', file);
      }
      await c.call('bots.settings.permissionCeiling', cap);
      assert.equal((await c.call('threads.list', { ids: [from.threadId] })).threads[0]?.permissionMode, 'ask');
      await assert.rejects(c.call('threads.update', { ...from, permissionMode: 'full' }), /permission limit/);
      const { team } = await c.call('bots.teams.create', { title: '編集チーム', memberIds: [bot.id] });
      const { team: assigned } = await c.call('bots.teams.setChief', { teamId: team.id, expectedRevision: team.revision, botId: bot.id, main: true });
      assert.equal(fs.readFileSync(path.join(home, 'bots-format.json'), 'utf8').trim(), '5');
      await c.call('runner.restart', { reason: 'Bot team verification' });
      const { c: reopened } = await connect(home, await nthListening(run.out, 2));
      try {
        assert.deepEqual((await reopened.call('bots.teams.get', { teamId: team.id })).team, assigned);
        assert.equal((await reopened.call('bots.get', { botId: bot.id })).bot.permissionCeiling, 'ask');
        assert.equal((await reopened.call('threads.list', { ids: [from.threadId] })).threads[0]?.permissionMode, 'ask');
      } finally {
        reopened.close();
      }
    } finally {
      c.close();
    }
    run.proc.kill('SIGTERM');
    assert.equal(await run.exited, 0);
  } finally {
    if (run.proc.exitCode === null && run.proc.signalCode === null) run.proc.kill('SIGTERM');
  }
});
