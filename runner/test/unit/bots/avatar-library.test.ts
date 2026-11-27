import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { install } from '../../../src/bots/ported/avatar-library.js';
import { tmpDir } from '../../helpers/fakes.ts';

const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJhsAAAAASUVORK5CYII=';

test('a library replaced during an asynchronous read cannot receive an old write', async t => {
  const home = tmpDir();
  const library = install({ home });
  const directory = join(home, 'avatars');
  const moved = join(home, 'moved');
  const outside = join(home, 'outside');
  await library.avatarLibraryImport([{ name: 'initial', image: photo }]);
  mkdirSync(outside);
  writeFileSync(join(outside, 'index.json'), 'private placeholder');
  const readFile = fsp.readFile;
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const patch = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof readFile>) => {
    const result = await readFile(...args);
    if (args[0] === join(directory, 'index.json')) {
      started.resolve();
      await finish.promise;
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { patch.mock.restore(); syncBuiltinESMExports(); });
  const write = library.avatarLibraryImport([{ name: 'duplicate', image: photo }]);
  await started.promise;
  renameSync(directory, moved);
  symlinkSync(outside, directory, 'junction');
  finish.resolve();
  await assert.rejects(write, /avatar library directory changed/i);
  assert.equal(existsSync(join(outside, 'files')), false);
  await assert.rejects(library.avatarLibraryView(), /avatar library directory/i);
});
