import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBotDataFormat } from '../../../src/bots/format.ts';
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
