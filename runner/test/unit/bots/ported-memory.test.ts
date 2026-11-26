import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the ported DS-Bot memory format and recovery tests pass in the Runner', () => {
  const files = ['memory-entries.test.js', 'memory-journal.test.js', 'personal-memory.test.js'];
  const tests = files.map(file => fileURLToPath(new URL(`../../ported-dsbot/${file}`, import.meta.url)));
  execFileSync(process.execPath, ['--test', ...tests], { stdio: 'pipe' });
});
