import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../../../src/clock.ts';
import { ReviewQueue, reviewBatch } from '../../../src/bots/memory-review.ts';

test('an idle conversation waits two seconds, gets queued once, and shares one reviewer', async () => {
  const clock = new FakeClock();
  const started: string[] = [];
  const release = Promise.withResolvers<void>();
  const queue = new ReviewQueue(clock, async key => {
    started.push(key);
    if (key === 'a') await release.promise;
  }, assert.fail);
  queue.status('a', true);
  clock.advance(1_900);
  queue.status('a', false);
  clock.advance(500);
  assert.deepEqual(started, []);
  queue.status('a', true);
  queue.status('b', true);
  clock.advance(2_000);
  await Promise.resolve();
  assert.deepEqual(started, ['a']);
  queue.status('b', true);
  clock.advance(2_000);
  release.resolve();
  await queue.settled();
  assert.deepEqual(started, ['a', 'b']);
});

test('a review only requests a model for new owner words and retains Japanese and its source range', async () => {
  const said = { who: 'user' as const, seq: 20, text: 'User: 日本語で見出しを短くする' };
  const reply = { who: 'you' as const, seq: 21, text: '承知しました' };
  const ask = async (system: string, prompt: string) => {
    assert.match(system, /You keep the long-term memory/);
    assert.match(prompt, /日本語で見出しを短くする/);
    assert.match(prompt, /Japanese \(日本語\)/);
    return '{"changes":[{"op":"add","text":"ユーザーは短い見出しを好む"}]}';
  };
  const dropped = await reviewBatch({ bot: { name: 'Writer' }, lines: [reply], through: 21, notes: [], redact: String, ask: async () => assert.fail('called for Bot-only messages') });
  assert.deepEqual(dropped, { through: 21, more: false, rejected: 0, changes: [] });
  const result = await reviewBatch({ bot: { name: 'Writer' }, lines: [said, reply], through: 22, notes: [], redact: String, ask });
  assert.deepEqual(result, { first: 20, through: 22, more: false, rejected: 0, changes: [{ op: 'add', text: 'ユーザーは短い見出しを好む' }] });
});

test('the review response never routes writes, modifies a pin, or keeps an identified secret', async () => {
  const result = await reviewBatch({
    bot: { name: 'Writer' }, lines: [{ who: 'user', seq: 20, text: 'User: Use short headings' }], through: 21,
    notes: [{ id: 'a', text: 'Permanent style', pinned: true }, { id: 'b', text: 'Use long headings', pinned: false }],
    redact: text => text.replaceAll('fixture-value', '[redacted]'),
    ask: async (_system, _prompt) => JSON.stringify({ changes: [
      { op: 'edit', entry: 2, text: 'Use short headings' },
      { op: 'remove', entry: 1 },
      { op: 'add', text: 'fixture-value' },
      { op: 'add', text: 'Everyone can read this', team: true },
    ] }),
  });
  assert.deepEqual(result, {
    first: 20, through: 21, more: false, rejected: 3,
    changes: [{ op: 'edit', id: 'b', before: 'Use long headings', text: 'Use short headings' }],
  });
});

test('a malformed reply has a bounded diagnostic while a transport failure remains retryable', async () => {
  const options = { bot: { name: 'Writer' }, lines: [{ who: 'user' as const, seq: 20, text: 'User: Use short headings' }], through: 21, notes: [], redact: String };
  const invalid = await reviewBatch({ ...options, ask: async () => 'unparsed tool output with fixture-value' });
  assert.deepEqual(invalid, { first: 20, through: 21, more: false, rejected: 0, changes: [], diagnostic: 'invalid-reply' });
  await assert.rejects(reviewBatch({ ...options, ask: async () => { throw new Error('temporary I/O failure'); } }), /temporary I\/O/);
});
