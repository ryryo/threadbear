// Cases from DS-Bot's handoff-results.test.js, using ThreadStore event references.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepResult, resultText } from '../../src/bots/handoff-result.ts';

const source = { threadId: 'writer-thread', seq: 22 };
const text = '見出しを短くする。'.repeat(500);

test('a result over the original preview limit survives serialization with the full event', () => {
  const snapshot = JSON.parse(JSON.stringify(keepResult(source, text)));
  assert.ok(snapshot.text.length <= 2_000);
  assert.deepEqual(resultText(snapshot, ref => {
    assert.deepEqual(ref, source);
    return text;
  }), { text, whole: true });
});

test('a preview stops before a character that straddles the original limit', () => {
  const head = '見'.repeat(1_999);
  const text = head + '😀全文';
  const saved = keepResult(source, text);
  assert.equal(saved.text, head);
  assert.deepEqual(resultText(saved, () => text), { text, whole: true });
});

test('a missing, truncated or edited result is explicitly incomplete', () => {
  const saved = keepResult(source, text);
  for (const rebuilt of [undefined, text.slice(1), 'a' + text.slice(1)]) {
    assert.deepEqual(resultText(saved, () => rebuilt), { text: saved.text, whole: false });
  }
  assert.deepEqual(resultText(keepResult(source, 'done'), () => undefined), { text: 'done', whole: true });
});
