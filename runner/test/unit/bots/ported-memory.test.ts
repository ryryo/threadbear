import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the ported DS-Bot memory format tests pass in the Runner', () => {
  const tests = fileURLToPath(new URL('../../ported-dsbot/memory-entries.test.js', import.meta.url));
  execFileSync(process.execPath, ['--test', tests], { stdio: 'pipe' });
});
