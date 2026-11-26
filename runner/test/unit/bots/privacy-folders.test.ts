import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { foldersOverlap } from '../../../src/bots/privacy-folders.ts';

// From DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a,
// ds-bot/test/privacy.test.js: a private Bot has a folder of its own.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
function folders(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bot-privacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const diary = join(root, 'diary');
  const team = join(root, 'team');
  const project = join(root, 'project');
  for (const directory of [diary, team, project]) mkdirSync(directory);
  mkdirSync(join(diary, 'inside'));
  return { root, diary, team, project };
}

test('a private Bot has a folder that no other folder is in or around', t => {
  const { root, diary, project } = folders(t);
  assert.equal(foldersOverlap(diary, project), false);
  assert.equal(foldersOverlap(diary, diary), true);
  assert.equal(foldersOverlap(diary, join(diary, 'inside')), true);
  assert.equal(foldersOverlap(join(diary, 'inside'), diary), true);
  assert.equal(foldersOverlap(diary, root), true);
  assert.equal(foldersOverlap(diary, join(root, 'diary-other')), false);
});

test('a link into the folder of a private Bot is closed too', t => {
  const { diary, project } = folders(t);
  const alias = join(project, 'diary-link');
  symlinkSync(diary, alias, 'junction');
  assert.equal(foldersOverlap(diary, alias), true);
  assert.equal(foldersOverlap(diary, join(alias, 'new', 'notes.md')), true);
});

test('an unresolved symlink cannot establish a separate private folder', t => {
  if (process.platform === 'win32') return t.skip('Creating a dangling link may need Developer Mode');
  const { diary, project } = folders(t);
  const alias = join(project, 'broken');
  symlinkSync(join(project, 'not-made'), alias);
  assert.throws(() => foldersOverlap(join(alias, 'nested'), diary), /resolve/);
});
