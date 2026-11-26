import fs from 'node:fs';
import path from 'node:path';
import { MARK_NAMES } from '../../src/peer.ts';
import { pointCurrentAt } from '../../src/release.ts';

export const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

export function cleanRunnerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^THREADB(EAR|ARE)_/.test(key)));
}

export function isolatedRunnerEnv(home: string): NodeJS.ProcessEnv {
  // Keep the owner marks so a developer running the test from a Threadbear
  // thread can still reach its own isolated Runner.
  const owner = Object.fromEntries(MARK_NAMES.map(name => [name, process.env[name]]));
  return {
    ...cleanRunnerEnv(),
    ...owner,
    THREADBEAR_HOME: home,
    THREADBEAR_PORT: '0',
    THREADBEAR_LOG: path.join(home, 'runner.log'),
    THREADBEAR_CLAUDE_PATH: path.join(home, 'no-claude'),
    THREADBEAR_CODEX_MAIN_DIR: path.join(home, 'no-codex'),
    THREADBEAR_ACCOUNTS_DIR: path.join(home, 'no-accounts'),
    THREADBEAR_CLAUDE_MAIN_DIR: path.join(home, 'no-main'),
    THREADBEAR_CLAUDE_MAIN_JSON: path.join(home, 'no-main.json'),
    THREADBEAR_CLI_UPDATES: 'off',
    THREADBEAR_SENTRY: 'off',
    THREADBEAR_SYNC: 'off',
    THREADBEAR_FOLLOW_MAIN: '0',
  };
}

export function configureBotFixture(home: string, port?: number): void {
  // Account discovery needs a configured account for an empty conversation.
  // No CLI runs in the fixture and the account has no login data.
  fs.mkdirSync(path.join(home, 'no-main'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({
    port, defaults: { cwd: home, accountId: 'claude-main' }, experiments: { nativeBots: true },
  }));
}

export const BOT_FIXTURE_REPLY = '日本語の見出し案。'.repeat(300);

export function installBotFixtureCli(home: string): string {
  const cli = path.join(home, 'claude-fixture');
  fs.writeFileSync(cli, `#!${process.execPath}
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const session = randomUUID();
const next = (frame) => console.log(JSON.stringify({ session_id: session, uuid: randomUUID(), ...frame }));
const model = 'claude-haiku-5-5';
const reply = ${JSON.stringify(BOT_FIXTURE_REPLY)};
let started = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    next({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
  }
  if (frame.type !== 'user') return;
  if (!started) {
    next({ type: 'system', subtype: 'init', model });
    started = true;
  }
  next({ type: 'assistant', message: { id: randomUUID(), role: 'assistant', model, content: [{ type: 'text', text: reply }] } });
  next({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', duration_ms: 1, result: reply });
});
`, { mode: 0o700 });
  return cli;
}

// Deploy's release layout, using the dependencies of this same checkout.
export function makeRelease(home: string, id: string): string {
  const dir = path.join(home, 'runner', 'releases', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(RUNNER_DIR, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(RUNNER_DIR, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(RUNNER_DIR, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ id, commit: 'abc1234', dirty: false, builtAt: new Date().toISOString(), node: process.version }));
  return dir;
}

export function installLaunch(home: string, current: string): string {
  const launch = path.join(home, 'runner', 'launch.mjs');
  fs.copyFileSync(path.join(RUNNER_DIR, 'launch.mjs'), launch);
  pointCurrentAt(home, current);
  return launch;
}
