// Runner integration of DS-Bot's request-id identity and persistence tests.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RequestReceipts } from '../../src/bots/request-receipts.ts';

const receipt = { requestId: 'request', threadId: 'writer-thread', turnId: 'first-turn', when: 'queue' as const };
const input = { caller: 'chief', context: 'chief-chat', name: 'deliver-document', payload: { target: 'writer-thread', text: 'Review headings' } };
const noop = () => {};
const owner = () => true;
function folder(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'tb-bot-requests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('simultaneous requests admit once and retries after restart return the same receipt', async t => {
  const root = folder(t);
  const ledger = new RequestReceipts(root, owner, noop, noop);
  const request = ledger.identity(input);
  let deliveries = 0;
  const send = async () => { deliveries++; return receipt; };
  const outcomes = await Promise.all([ledger.admit(request, send), ledger.admit(request, send)]);
  assert.deepEqual(outcomes.map(result => result.status).sort(), ['replay', 'sent']);
  const restarted = new RequestReceipts(root, owner, noop, noop);
  assert.deepEqual(await restarted.admit(request, send), { status: 'replay', receipt });
  assert.deepEqual(await restarted.admit(restarted.identity({ ...input, payload: { target: 'different' } }), send), { status: 'conflict' });
  assert.equal(deliveries, 1);
});

test('failure to persist acceptance does not send and a restarted pending receipt is uncertain', async t => {
  const root = folder(t);
  const neverSend = async () => assert.fail('The request cannot be delivered again');
  const unavailable = new RequestReceipts(root, owner, noop, noop, () => { throw new Error('fixture I/O failure'); });
  await assert.rejects(unavailable.admit(unavailable.identity(input), neverSend), /fixture I\/O failure/);
  const ledger = new RequestReceipts(root, owner, noop, noop);
  const request = ledger.identity(input);
  const refusal = new RequestReceipts(root, () => false, noop, noop);
  assert.deepEqual(await refusal.admit(request, neverSend), { status: 'readonly' });
  const pending = Promise.withResolvers<typeof receipt>();
  const waiting = ledger.admit(request, () => pending.promise);
  const file = join(root, 'request-receipts.json');
  assert.match(readFileSync(file, 'utf8'), /"outcome":"pending"/);
  const restarted = new RequestReceipts(root, owner, noop, noop);
  assert.deepEqual(await restarted.admit(request, neverSend), { status: 'uncertain' });
  pending.resolve(receipt);
  await waiting;
  writeFileSync(file, 'corrupt storage');
  assert.throws(() => new RequestReceipts(root, owner, noop, noop), SyntaxError);
});
