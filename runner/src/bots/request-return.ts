// Route a completed request back to its original conversation. Like
// DS-Bot's answerSender (Apache-2.0, see ported/NOTICE), the durable
// request and recipient identify a delivery across normal completion and recovery.
import { keepResult, resultText, type KeptResult } from './handoff-result.ts';
import type { RequestRow, RequestStateStore } from './request-state.ts';

import type { InputEvidence } from './request-events.ts';

type ReturnState = 'queued' | 'sent' | 'missing' | 'unknown' | 'blocked';
type Ports = {
  requests: RequestStateStore;
  inspectInput: (row: RequestRow) => InputEvidence;
  inspectReply: (row: RequestRow, replyId: string) => ReturnState;
  deliverReply: (row: RequestRow, replyId: string, text: string) => void;
  readResult: (source: KeptResult['source']) => string | undefined;
  removeQueuedInput: (row: RequestRow) => void;
};

export class BotRequestReturn {
  private readonly ports: Readonly<Ports>;

  constructor(ports: Ports) { this.ports = ports; }

  // The Runner calls this outside its turn event handler and again after
  // taking ownership of the recovered queue. A failure before the reply is
  // recorded stays retryable by looking for its durable replyId.
  settle(id: string, recovery = false): RequestRow {
    const { requests, inspectInput } = this.ports;
    let row = requests.get(id);
    if (row.state.status === 'returning') return this.returnReply(row);
    if (row.state.status === 'uncertain' && row.state.reply) {
      const reply = row.state.reply;
      const proof = this.ports.inspectReply(row, reply.replyId);
      return proof === 'queued' || proof === 'sent'
        ? requests.advance(row.id, row.revision, { ...reply, status: 'returned' })
        : row;
    }
    if (!['admitted', 'queued', 'running', 'uncertain'].includes(row.state.status)) return row;
    const input = inspectInput(row);
    if (input.kind === 'waiting') return row;
    if (input.kind === 'blocked') return row.state.status === 'uncertain' ? row : requests.advance(id, row.revision, { status: 'failed', reason: 'The recipient is no longer allowed to run this request' });
    if (input.kind === 'unknown' || input.kind === 'missing') {
      return recovery && row.state.status !== 'uncertain' ? requests.advance(id, row.revision, { status: 'uncertain', reason: 'The Runner cannot confirm whether the recipient read the request' }) : row;
    }
    if (row.state.status === 'admitted' || row.state.status === 'uncertain') {
      row = requests.advance(id, row.revision, { status: input.kind === 'queued' ? 'queued' : 'running', turnId: input.turnId });
    }
    if (input.kind === 'queued') return row;
    if (input.kind === 'running') {
      return row.state.status === 'queued' ? requests.advance(id, row.revision, { status: 'running', turnId: row.state.turnId }) : row;
    }
    // A failed turn can contain more than one request for different parent
    // work. Each has its own replyId even if it shares the same recipient.
    const failed = input.kind === 'failed';
    const text = failed ? input.message : input.text;
    const result = keepResult({ threadId: row.targetThreadId, seq: input.seq }, text);
    const turnId = 'turnId' in row.state ? row.state.turnId : input.turnId;
    row = requests.advance(id, row.revision, { status: 'returning', turnId, replyId: `bot-reply:${id}`, result, failed });
    return this.returnReply(row);
  }

  private returnReply(row: RequestRow): RequestRow {
    const { requests, inspectReply, deliverReply, readResult } = this.ports;
    if (row.state.status !== 'returning') return row;
    const { replyId, result, failed } = row.state;
    const found = inspectReply(row, replyId);
    if (found === 'unknown') {
      const { status: _status, ...reply } = row.state;
      return requests.advance(row.id, row.revision, { status: 'uncertain', reason: 'The Runner cannot confirm whether the original conversation received the reply', reply });
    }
    if (found === 'blocked') return row;
    if (found === 'missing') {
      const { text, whole } = resultText(result, readResult);
      const prefix = failed ? 'The Bot could not complete the request.\n\n' : '';
      deliverReply(row, replyId, prefix + (whole ? text : `${text}\n\n[The full result is unavailable.]`));
    }
    return requests.advance(row.id, row.revision, { ...row.state, status: 'returned' });
  }

  cancel(id: string, revision: number): RequestRow {
    const { requests, removeQueuedInput } = this.ports;
    const row = requests.advance(id, revision, { status: 'cancelled', reason: 'Cancelled by the owner' });
    // Use the stored cancellation even if thread.json could not be saved.
    // The queue checks this state again before CLI input.
    removeQueuedInput(row);
    return row;
  }
}
