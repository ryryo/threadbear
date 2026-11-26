import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import supported from './format.json' with { type: 'json' };
import { atomicWriteFileSync } from '../fsutil.ts';
import { supervised } from '../release.ts';

// launch.mjs is installed on its own. Keep its reader in step with this one.
export function checkBotDataFormat(home: string, supportedFormat: number = supported): boolean {
  const marker = join(home, 'bots-format.json');
  let required: unknown;
  try {
    if (!lstatSync(marker).isFile()) throw new Error('The Bot data format marker must be a regular file');
    required = JSON.parse(readFileSync(marker, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('Could not read the required Bot data format', { cause: error });
  }
  if (typeof required !== 'number' || !Number.isSafeInteger(required) || required < 1 || required !== supportedFormat) {
    throw new Error('This release does not support the required Bot data format');
  }
  return true;
}

export function supervisorGuardsBotData(home: string): boolean {
  const guardedHome = process.env.THREADBEAR_BOT_FORMAT_HOME;
  if (!supervised() || !process.connected || process.env.THREADBEAR_BOT_FORMAT_GUARD !== '1' || !guardedHome) return false;
  try {
    return realpathSync(home) === realpathSync(guardedHome);
  } catch {
    return false;
  }
}

// Only called by the primary Runner while it holds the normal data lock.
export function protectBotData(home: string): void {
  if (supported < 1) throw new Error('This release cannot write Bot data');
  if (!checkBotDataFormat(home)) atomicWriteFileSync(join(home, 'bots-format.json'), `${supported}\n`, 0o600);
}
