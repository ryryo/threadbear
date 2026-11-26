import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function runPorted(files: string[], count: number): void {
  const tests = files.map(file => fileURLToPath(new URL(`../../ported-dsbot/${file}`, import.meta.url)));
  // This is a separate test runner. Inheriting its parent's context makes
  // node:test skip nested test files and exit successfully without tests.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const report = execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { encoding: 'utf8', env });
  assert.match(report, new RegExp(`^# tests ${count}\\r?$`, 'm'));
  assert.match(report, new RegExp(`^# pass ${count}\\r?$`, 'm'));
}

test('the ported DS-Bot memory format and recovery tests pass in the Runner', () => {
  runPorted(['memory-entries.test.js', 'memory-journal.test.js', 'personal-memory.test.js', 'review-lines.test.js', 'tidy-draft.test.js'], 19);
});

test('the ported DS-Bot request and delivery tests pass in the Runner', () => {
  runPorted([
    'request-receipts.test.js', 'request-ledger.test.ts', 'request-dispatch.test.ts', 'request-events.test.ts',
    'request-graph.test.ts', 'request-return.test.ts', 'request-state.test.ts', 'handoff-result.test.ts',
  ], 13);
});

test('the pinned DS-Bot baseline and direct ports match their recorded source', () => {
  const root = new URL('../../../../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('third_party/dsbot/manifest.json', root), 'utf8')) as {
    files: { baselinePath: string; sha256: string; upstreamBlob: string; portMode: string; portPath?: string }[];
  };
  for (const entry of manifest.files) {
    const baseline = readFileSync(new URL(entry.baselinePath, root));
    assert.equal(createHash('sha256').update(baseline).digest('hex'), entry.sha256, entry.baselinePath);
    assert.equal(createHash('sha1').update(`blob ${baseline.length}\0`).update(baseline).digest('hex'), entry.upstreamBlob, entry.baselinePath);
    if (entry.portMode !== 'A' || entry.portPath === undefined) continue;
    const port = readFileSync(new URL(entry.portPath, root));
    assert.ok(port.subarray(port.indexOf('\n\n') + 2).equals(baseline), entry.portPath);
  }
});
