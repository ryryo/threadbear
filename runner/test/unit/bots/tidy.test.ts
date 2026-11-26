import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersonalMemory } from '../../../src/bots/ported/personal-memory.js';
import { tmpDir } from '../../helpers/fakes.ts';

test('tidy applies and undoes a topic move through the original memory journal', () => {
  const root = tmpDir();
  const at = '2026-11-27T00:00:00.000Z';
  const memory = new PersonalMemory(root);
  memory.add('Pinned by the owner', {}, at);
  const text = Array.from({ length: 10 }, (_, index) => `- Release detail ${index} [id: release${index}; added: 2026-11-01]`);
  // The imported store normally inserts these before the original Index.
  const main = join(root, 'MEMORY.md');
  const originalIndex = '\n## Imported notes\n';
  appendFileSync(main, `${originalIndex}${text.join('\n')}\n`);
  const previous = memory.list('2026-11-27');
  const input = memory.tidyInput('2026-11-27')!;
  const operationId = randomUUID();
  const reply = '{"changes":[{"op":"move","entry":1,"topic":"release"},{"op":"retire","entry":2,"why":"the release shipped"},{"op":"retire","entry":3}]}';
  assert.equal(input.numbered.length, 10);
  const result = memory.tidy(input, reply, operationId, at);
  assert.deepEqual(result.counts, { merged: 0, moved: 1, retired: 1 });
  assert.deepEqual(memory.tidyResult(operationId), result);
  assert.equal(memory.search('release detail', '2026-11-27').find(note => note.text === 'Release detail 0')?.topic, 'release');
  assert.equal(memory.list('2026-11-27').some(note => note.pinned), true);
  assert.equal(memory.tidyInput('2026-11-27'), undefined, 'an unchanged scope is not reviewed again');
  const reopened = new PersonalMemory(root);
  reopened.restore(result.revision, at);
  assert.equal(existsSync(join(root, 'release.md')), false);
  assert.deepEqual(reopened.list('2026-11-27'), previous);
  assert.throws(() => reopened.restore(result.revision, at), /already restored/);
});
