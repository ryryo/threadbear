import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import supported from './format.json' with { type: 'json' };

// launch.mjs is installed on its own. Keep its reader in step with this one.
export function checkBotDataFormat(home: string, supportedFormat: number = supported): void {
  const marker = join(home, 'bots-format.json');
  let required: unknown;
  try {
    if (!lstatSync(marker).isFile()) throw new Error('The Bot data format marker must be a regular file');
    required = JSON.parse(readFileSync(marker, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Could not read the required Bot data format', { cause: error });
  }
  if (typeof required !== 'number' || !Number.isSafeInteger(required) || required < 1 || required !== supportedFormat) {
    throw new Error('This release does not support the required Bot data format');
  }
}
