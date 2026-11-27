import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BOT_ABANDON_FORMAT, BOT_ERASE_FORMAT, BOT_GROUP_FORMAT, BOT_REQUEST_FORMAT, BOT_TRANSFER_FORMAT, checkBotDataFormat, hasPrivateBotData, PRIVATE_BOT_FORMAT, protectBotData } from '../../../src/bots/format.ts';
import { test, type TestContext } from 'node:test';

const launch = await import(pathToFileURL(join(import.meta.dirname, '../../../launch.mjs')).href);

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'threadbear-bot-format-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'runner');
  for (const id of ['old', 'new']) {
    const src = join(dir, 'releases', id, 'src');
    mkdirSync(join(src, 'bots'), { recursive: true });
    writeFileSync(join(src, 'main.ts'), '');
    if (id === 'new') writeFileSync(join(src, 'bots', 'format.json'), '1\n');
  }
  return { home, dir, marker: join(home, 'bots-format.json') };
}

test('ordinary data permits the previous release, protected data refuses an incompatible activation', t => {
  const { home, dir, marker } = fixture(t);
  assert.doesNotThrow(() => checkBotDataFormat(home, 1));
  launch.pointCurrent(dir, 'old');
  writeFileSync(marker, '1\n');
  assert.throws(() => launch.pointCurrent(dir, 'old'), /Bot data format/);
  launch.pointCurrent(dir, 'new');
  assert.equal(launch.readCurrentLink(dir), 'new');
  assert.doesNotThrow(() => checkBotDataFormat(home, 1));
  writeFileSync(marker, '2\n');
  assert.throws(() => checkBotDataFormat(home, 1), /Bot data format/);
});

test('the supervisor will not start or roll back to an incompatible release', t => {
  const { dir, marker } = fixture(t);
  writeFileSync(marker, '1\n');
  const now = Date.now();
  const attempts = Array.from({ length: 2 }, () => ({ release: 'new', at: new Date(now - 1_000).toISOString() }));
  const exists = (id: string) => launch.releaseExists(dir, id);
  const compatible = (id: string) => launch.releaseCanUseBotData(dir, id);

  const retry = launch.planBoot({ current: 'new', lastGood: 'old', boots: attempts }, now, exists, 0, false, compatible);
  assert.equal(retry.start, 'new');
  assert.equal(retry.rolledBack, null);
  const migrate = launch.planBoot({ current: 'old', lastGood: 'new', boots: [] }, now, exists, 0, false, compatible);
  assert.equal(migrate.start, 'new');
  assert.equal(migrate.rolledBack?.to, 'new');
  const blocked = launch.planBoot({ current: 'old', lastGood: 'old', boots: [] }, now, exists, 0, false, compatible);
  assert.equal(blocked.start, null);
  assert.deepEqual(blocked.state.boots, []);
});

test('a corrupt format requirement stops Runner boot and leaves current untouched', t => {
  const { home, dir, marker } = fixture(t);
  launch.pointCurrent(dir, 'old');
  writeFileSync(marker, '{');
  assert.throws(() => checkBotDataFormat(home, 1), /Bot data format/);
  assert.throws(() => launch.pointCurrent(dir, 'new'), /Bot data format/);
  assert.equal(launch.readCurrentLink(dir), 'old');
});

test('a supervisor exits before running a child or recording a boot for an incompatible release', t => {
  const { dir, marker } = fixture(t);
  const program = join(dir, 'launch.mjs');
  copyFileSync(join(import.meta.dirname, '../../../launch.mjs'), program);
  launch.pointCurrent(dir, 'old');
  writeFileSync(marker, '1\n');

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^THREADB(?:EAR|ARE)_/.test(key)));
  const result = spawnSync(process.execPath, [program], { cwd: dir, env, encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout + result.stderr, /no release that can open the required Bot data format/);
  assert.equal(existsSync(join(dir, 'state.json')), false);
  assert.equal(launch.readCurrentLink(dir), 'old');
});

test('private data needs the new supervisor and private-capable releases cannot roll back to P1', t => {
  const { home, dir, marker } = fixture(t);
  const privateRelease = join(dir, 'releases', 'private', 'src');
  mkdirSync(join(privateRelease, 'bots'), { recursive: true });
  writeFileSync(join(privateRelease, 'main.ts'), '');
  writeFileSync(join(privateRelease, 'bots', 'format.json'), '1\n');
  writeFileSync(join(privateRelease, 'bots', 'format-compatible.json'), '[1,2]\n');
  writeFileSync(marker, '1\n');
  // The legacy launcher's check was just a read of format.json and integer equality.
  assert.equal(JSON.parse(readFileSync(join(privateRelease, 'bots', 'format.json'), 'utf8')), 1);
  assert.equal(launch.releaseCanUseBotData(dir, 'private'), true);
  assert.throws(() => protectBotData(home, PRIVATE_BOT_FORMAT), /updated Bot supervisor/);
  assert.equal(readFileSync(marker, 'utf8').trim(), '1');

  writeFileSync(marker, '2\n');
  assert.equal(launch.releaseCanUseBotData(dir, 'new'), false);
  assert.throws(() => launch.pointCurrent(dir, 'new'), /Bot data format/);
  assert.equal(launch.releaseCanUseBotData(dir, 'private'), true);
  assert.equal(checkBotDataFormat(home), true);
  protectBotData(home, 1);
  assert.equal(readFileSync(marker, 'utf8').trim(), '2');
});


test('request data requires a compatible supervisor and preserves the prior Private requirement', t => {
  const { home, dir, marker } = fixture(t);
  for (const [id, versions] of [['private', [1, 2]], ['requests', [1, 2, 3]]] as const) {
    const release = join(dir, 'releases', id, 'src', 'bots');
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'format.json'), '1\n');
    writeFileSync(join(release, 'format-compatible.json'), JSON.stringify(versions) + '\n');
  }
  writeFileSync(marker, '2\n');
  assert.throws(() => protectBotData(home, BOT_REQUEST_FORMAT), /updated Bot supervisor/);
  assert.equal(readFileSync(marker, 'utf8').trim(), '2');
  writeFileSync(marker, '3\n');
  assert.equal(launch.releaseCanUseBotData(dir, 'private'), false);
  assert.equal(launch.releaseCanUseBotData(dir, 'requests'), true);
  assert.equal(checkBotDataFormat(home), true);
  assert.equal(hasPrivateBotData(home), true);
  protectBotData(home, 1);
  assert.equal(readFileSync(marker, 'utf8').trim(), '3');
});

test('a Group book requires a format-6 supervisor and keeps the team format readable', t => {
  const { home, dir, marker } = fixture(t);
  for (const [id, formats] of [['teams', [1, 2, 3, 4, 5]], ['groups', [1, 2, 3, 4, 5, 6]]] as const) {
    const release = join(dir, 'releases', id, 'src', 'bots');
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'format.json'), '1\n');
    writeFileSync(join(release, 'format-compatible.json'), JSON.stringify(formats) + '\n');
  }
  writeFileSync(marker, '5\n');
  assert.ok(launch.releaseCanUseBotData(dir, 'groups'));
  assert.throws(() => protectBotData(home, BOT_GROUP_FORMAT), /updated Bot supervisor/);
  assert.equal(readFileSync(marker, 'utf8').trim(), '5');
  writeFileSync(marker, '6\n');
  assert.equal(launch.releaseCanUseBotData(dir, 'teams'), false);
  assert.throws(() => launch.pointCurrent(dir, 'teams'), /Bot data format/);
  assert.ok(launch.releaseCanUseBotData(dir, 'groups'));
  assert.equal(checkBotDataFormat(home), true);
});

test('worker and transfer data prevents rolling back to the device-only release', t => {
  const { home, dir, marker } = fixture(t);
  for (const [id, last] of [['devices', 8], ['transfers', 9]] as const) {
    const bot = join(dir, 'releases', id, 'src', 'bots');
    mkdirSync(bot, { recursive: true });
    writeFileSync(join(bot, 'format.json'), '1\n');
    writeFileSync(join(bot, 'format-compatible.json'), JSON.stringify(Array.from({ length: last }, (_, n) => n + 1)));
  }
  writeFileSync(marker, '8\n');
  assert.equal(launch.releaseCanUseBotData(dir, 'transfers'), true);
  assert.throws(() => protectBotData(home, BOT_TRANSFER_FORMAT), /updated Bot supervisor/);
  assert.equal(readFileSync(marker, 'utf8').trim(), '8');
  writeFileSync(marker, '9\n');
  assert.equal(launch.releaseCanUseBotData(dir, 'devices'), false);
  assert.throws(() => launch.pointCurrent(dir, 'devices'), /Bot data format/);
  assert.equal(checkBotDataFormat(home), true);
});

test('a supervised upgrade can write abandonment state and earlier releases cannot open it', async t => {
  const { home, dir, marker } = fixture(t);
  const formats = Array.from({ length: BOT_TRANSFER_FORMAT }, (_, index) => index + 1);
  for (const [id, versions] of [['transfer', formats], ['abandon', [...formats, BOT_ABANDON_FORMAT]]] as const) {
    const release = join(dir, 'releases', id, 'src', 'bots');
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'format.json'), '1\n');
    writeFileSync(join(release, 'format-compatible.json'), JSON.stringify(versions) + '\n');
  }
  writeFileSync(marker, '9\n');
  assert.throws(() => protectBotData(home, BOT_ABANDON_FORMAT), /updated Bot supervisor/);
  assert.equal(readFileSync(marker, 'utf8').trim(), '9');
  const check = join(home, 'publish-bot-format.mjs');
  const formatModule = new URL('../../../src/bots/format.ts', import.meta.url);
  writeFileSync(check, `import { BOT_ABANDON_FORMAT, protectBotData } from ${JSON.stringify(formatModule.href)};
protectBotData(process.argv[2], BOT_ABANDON_FORMAT);
process.disconnect();
`);
  const child = fork(check, [home], {
    env: { ...process.env, THREADBEAR_SUPERVISED: '1', THREADBEAR_BOT_FORMAT_GUARD: '1',
      THREADBEAR_BOT_FORMAT_GUARD_VERSION: '10', THREADBEAR_BOT_FORMAT_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.equal(readFileSync(marker, 'utf8').trim(), '10');
  assert.equal(checkBotDataFormat(home), true);
  assert.equal(launch.releaseCanUseBotData(dir, 'abandon'), true);
  assert.throws(() => launch.pointCurrent(dir, 'transfer'), /Bot data format/);
});

test('a supervisor that only knows abandonment cannot activate permanent erasure or start an older release after it', async t => {
  const { home, dir, marker } = fixture(t);
  for (const [id, last] of [['abandon', 10], ['erase', 11]] as const) {
    const release = join(dir, 'releases', id, 'src', 'bots');
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'format.json'), '1\n');
    writeFileSync(join(release, 'format-compatible.json'), JSON.stringify(Array.from({ length: last }, (_, index) => index + 1)));
  }
  writeFileSync(marker, '10\n');
  const check = join(home, 'publish-erasure-format.mjs');
  const formatModule = new URL('../../../src/bots/format.ts', import.meta.url);
  writeFileSync(check, `import { BOT_ERASE_FORMAT, protectBotData } from ${JSON.stringify(formatModule.href)};
protectBotData(process.argv[2], BOT_ERASE_FORMAT);
process.disconnect();
`);
  const trySupervisor = (version: number) => {
    const child = fork(check, [home], {
      env: { ...process.env, THREADBEAR_SUPERVISED: '1', THREADBEAR_BOT_FORMAT_GUARD: '1',
        THREADBEAR_BOT_FORMAT_GUARD_VERSION: String(version), THREADBEAR_BOT_FORMAT_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child.stderr?.resume();
    return once(child, 'close');
  };
  assert.equal((await trySupervisor(BOT_ABANDON_FORMAT))[0], 1);
  assert.equal(readFileSync(marker, 'utf8').trim(), '10');
  assert.equal((await trySupervisor(BOT_ERASE_FORMAT))[0], 0);
  assert.equal(readFileSync(marker, 'utf8').trim(), '11');
  assert.equal(checkBotDataFormat(home), true);
  assert.equal(launch.releaseCanUseBotData(dir, 'erase'), true);
  assert.throws(() => launch.pointCurrent(dir, 'abandon'), /Bot data format/);
});
