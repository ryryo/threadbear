// Derived from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a,
// ds-bot/test/memory.test.js. Apache-2.0, Fei2411 and the DS Bot contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isExpired, isPinned, parseMemory } from '../../src/bots/ported/memory-entries.js';
import { draftTidy, parseTidy } from '../../src/bots/ported/tidy-draft.js';

const facts = Array.from({ length: 20 }, (_, at) => `- Fact number ${at + 1} [id: a${String(at).padStart(3, '0')}; added: 2026-10-01]`);
const original = `# Memory\n\n${facts.join('\n')}\n- Keep this forever [id: beef; added: 2026-01-01; pinned: user]\n- Over now [id: dead; added: 2026-01-01; until: 2020-01-01]\n\n## Index\n`;
const time = '2026-11-27T00:00:00Z';

function snapshot(content) {
  const file = { file: 'MEMORY.md', content, ...parseMemory(content) };
  const offered = file.entries.filter(entry => !isPinned(entry)).map(entry => ({ ...entry, file }));
  return { files: [file], offered, ended: offered.filter(entry => isExpired(entry, time.slice(0, 10))), open: offered.filter(entry => !isExpired(entry, time.slice(0, 10))) };
}

test('the tidy merges and archives within a fifth of the entries and leaves a pin', () => {
  const { files, offered, ended, open } = snapshot(original);
  const changes = [
    { op: 'merge', entries: [1, 2], text: 'Facts one and two' },
    { op: 'move', entry: 3, topic: 'details' },
    { op: 'about', topic: 'details', text: 'Small details' },
    { op: 'retire', entry: 4, why: 'over' },
    { op: 'retire', entry: 5, why: 'past the limit' },
    { op: 'retire', entry: 99 },
  ];
  const result = draftTidy({ files, offered, numbered: open, ended, changes, batch: 'batch', time, entryProblem: () => undefined, scrub: text => text });
  const main = result.touched.find(item => item.file === 'MEMORY.md');
  assert.equal(main.before, original);
  assert.match(main.after, /- Facts one and two \[id: a000;.*merged: a000 a001/);
  assert.doesNotMatch(main.after, /Fact number 2 |Fact number 3 |Fact number 4 |Over now/);
  assert.match(main.after, /Fact number 5 /);
  assert.match(main.after, /- Keep this forever \[/);
  const details = result.touched.find(item => item.file === 'details.md');
  assert.equal(details.before, null, 'undo removes the newly made topic');
  assert.match(details.after, /> Small details\n[\s\S]*- Fact number 3 /);
  assert.deepEqual(result.retired.map(row => row.why).sort(), ['ended', 'merged', 'merged', 'over']);
  assert.deepEqual(result.counts, { merged: 2, moved: 1, retired: 2 });
});

test('a tidy preserves entries changed after the model read them and redacts a retirement reason', () => {
  const earlier = snapshot(original);
  const latest = snapshot(original.replace('Fact number 1 ', 'An updated fact '));
  const changes = parseTidy('{"changes":[{"op":"retire","entry":1,"why":"old"},{"op":"retire","entry":2,"why":"fixture token"}]}');
  const result = draftTidy({
    ...latest, numbered: earlier.open, changes, batch: 'batch', time, entryProblem: () => undefined,
    scrub: text => text.replace('fixture token', '[redacted]'),
  });
  assert.match(result.touched[0].after, /An updated fact/);
  assert.equal(result.retired.some(row => row.why === '[redacted]'), true);
  assert.equal(result.retired.some(row => row.why === 'fixture token'), false);
});
