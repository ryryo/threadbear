import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookFile, parseBook, range } from '../../../src/bots/group-ledger.ts';

test('a book with an id that is not a plain name gets a file name of its own', () => {
  assert.equal(bookFile('group-a'), 'group-a.jsonl');
  assert.match(bookFile('日本語のGroup/'), /^[a-f0-9]{32}\.jsonl$/);
  assert.notEqual(bookFile('日本語のGroup/'), bookFile('日本語のGroup'));
});

test('a line cut by an interruption is left out and the book goes on after it', () => {
  const before = '{"seq":1,"id":"a"}\n{"se';
  assert.deepEqual(parseBook(before), { rows: [{ seq: 1, id: 'a' }], torn: true });
  assert.deepEqual(parseBook('{"seq":1,"id":"a"}\n{"seq":2,"id":"b"}\n').rows.map(row => row.id), ['a', 'b']);
  assert.throws(() => parseBook('{"seq":1,"id":"a"}\n{"se\n{"seq":3,"id":"c"}\n'), /record 2/);
});

test('range reads the same records as a scan for a regular and a sparse book', () => {
  const rows = [1, 2, 3, 15, 1200].map(seq => ({ seq, id: String(seq) }));
  for (const [from, to] of [[1, 3], [2, 16], [16, 1200], [2, undefined]] as const) {
    assert.deepEqual(range(rows, from, to), rows.filter(row => row.seq >= from && (to === undefined || row.seq <= to)));
  }
});
