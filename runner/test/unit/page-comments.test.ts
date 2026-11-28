import assert from 'node:assert/strict';
import test from 'node:test';
import { pageCommentsInText, type PageCommentRef } from '../../src/page-comments.ts';
import { userMessage } from '../../src/runner/messages.ts';
import { toMessageDoc } from '../../src/sync.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { nullLogger } from '../../src/log.ts';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { patiently } from '../helpers/patience.ts';

const text = '前\n\nPage comment on 頁\nhttps://example.com\nElement: <button>\n修正🦊 [Picture 1]\n\n後';
const target = 'Element: <button>';
function range(part: string): [number, number] {
  const start = text.indexOf(part);
  return [Buffer.byteLength(text.slice(0, start)), Buffer.byteLength(text.slice(0, start + part.length))];
}
const ref = {
  block: range(text.slice(text.indexOf('Page comment'), text.indexOf('\n\n後'))),
  title: range('頁'), url: range('https://example.com'), target: range(target),
  comment: range('修正🦊'), image: 0,
};

test('page comment display ranges use UTF-8 and reject incomplete or forged ranges', () => {
  assert.deepEqual(pageCommentsInText([{ ...ref, imagePath: '/private/file' }], text, 1), [ref]);
  assert.equal(pageCommentsInText([{ ...ref, title: [ref.title[0] + 1, ref.title[1]] }], text, 1), undefined);
  assert.equal(pageCommentsInText([{ ...ref, comment: range('前') }], text, 1), undefined);
  assert.equal(pageCommentsInText([ref, ref], text, 1), undefined);
  assert.equal(pageCommentsInText([ref], text, 0), undefined);
});

test('the annotation survives user.message and only its public ranges may reach the mirror', () => {
  const event = userMessage({ text, turnId: 'turn', images: [{ path: '/private/test.png', mediaType: 'image/png' }], pageComments: [ref] });
  assert.equal(event.type, 'user.message');
  if (event.type !== 'user.message') return;
  assert.deepEqual(event.pageComments, [ref]);
  const row = { ...event, seq: 5, threadId: 'thread', ts: '2026-11-28T00:00:00Z' };
  const doc = toMessageDoc('thread', row);
  assert.deepEqual(doc?.pageComments, [ref]);
  assert.ok(!JSON.stringify(doc).includes('/private/test.png'));
  const scrubbed = toMessageDoc('thread', row, (body) => body.replace(target, '[redacted]'));
  assert.equal(scrubbed?.pageComments, undefined);
  assert.ok(scrubbed?.text.includes('[redacted]'));
});


test('the owner can send a page comment through the runner and reload its display ranges', async () => {
  const h = makeHarness();
  const token = 'test-token-page-comment';
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token, runner: h.runner, log: nullLogger });
  const { port } = await server.listen();
  const client = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, token);
  try {
    const { thread } = await client.call('threads.create', { text: 'Review this page', accountId: 'claude-3' });
    h.adapter.last.init();
    h.adapter.last.result('completed');
    await tick();
    const words = text.replace(' [Picture 1]', '');
    const range: PageCommentRef = { ...ref, block: [ref.block[0], ref.comment[1]] };
    delete range.image;
    await client.call('threads.send', { threadId: thread.id, text: words, pageComments: [range] });
    await patiently(() => h.events(thread.id).some((event) => event.type === 'user.message' && event.text === words));
    const page = await client.call('threads.events', { threadId: thread.id });
    const message = page.events.find((event: { type: string; text?: string }) => event.type === 'user.message' && event.text === words);
    assert.deepEqual(message?.pageComments, [range]);
  } finally {
    client.close();
    await server.close();
  }
});
