import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import baseline from './format.json' with { type: 'json' };
import supported from './format-compatible.json' with { type: 'json' };
import { atomicWriteFileSync } from '../fsutil.ts';
import { supervised } from '../release.ts';

export const PRIVATE_BOT_FORMAT = 2;
export const BOT_REQUEST_FORMAT = 3;
export const BOT_TASK_FORMAT = 4;
export const BOT_TEAM_FORMAT = 5;
export const BOT_GROUP_FORMAT = 6;

// launch.mjs is installed on its own. Keep its reader in step with this one.
function readFormatRequirement(home: string): number | undefined {
  const marker = join(home, 'bots-format.json');
  let required: unknown;
  try {
    if (!lstatSync(marker).isFile()) throw new Error('The Bot data format marker must be a regular file');
    required = JSON.parse(readFileSync(marker, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Could not read the required Bot data format', { cause: error });
  }
  if (typeof required !== 'number' || !Number.isSafeInteger(required) || required < 1) {
    throw new Error('This release does not support the required Bot data format');
  }
  return required;
}

export function checkBotDataFormat(home: string, expected: number | readonly number[] = supported): boolean {
  const required = readFormatRequirement(home);
  if (required === undefined) return false;
  const versions = typeof expected === 'number' ? [expected] : expected;
  if (!versions.includes(required)) throw new Error('This release does not support the required Bot data format');
  return true;
}

export function hasPrivateBotData(home: string): boolean {
  return (readFormatRequirement(home) ?? 0) >= PRIVATE_BOT_FORMAT;
}

export function supervisorGuardsBotData(home: string, required = baseline): boolean {
  const guardedHome = process.env.THREADBEAR_BOT_FORMAT_HOME;
  if (!supervised() || !process.connected || process.env.THREADBEAR_BOT_FORMAT_GUARD !== '1' || !guardedHome) return false;
  const supported = Number(process.env.THREADBEAR_BOT_FORMAT_GUARD_VERSION ?? baseline);
  if (required > baseline && (!Number.isSafeInteger(supported) || supported < required)) return false;
  try {
    return realpathSync(home) === realpathSync(guardedHome);
  } catch {
    return false;
  }
}

// Only called by the primary Runner while it holds the normal data lock.
export function protectBotData(home: string, required = baseline): void {
  if (baseline < 1 || !supported.includes(required)) throw new Error('This release cannot write the requested Bot data format');
  const current = readFormatRequirement(home);
  if (current !== undefined && !supported.includes(current)) throw new Error('This release does not support the required Bot data format');
  if (required > baseline && !supervisorGuardsBotData(home, required)) {
    throw new Error('This Bot feature needs the updated Bot supervisor to be running');
  }
  if (current === undefined || current < required) atomicWriteFileSync(join(home, 'bots-format.json'), `${required}\n`, 0o600);
}
