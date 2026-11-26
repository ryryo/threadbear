// The recipient's user.message is the durable correlation. A turn ID
// alone is insufficient when one turn took several steered inputs.
import type { PersistedEvent } from '../protocol.ts';

export type InputEvidence =
  | { kind: 'queued'; turnId: string }
  | { kind: 'running'; turnId: string }
  | { kind: 'complete'; turnId: string; seq: number; text: string }
  | { kind: 'failed'; turnId: string; seq: number; message: string }
  | { kind: 'missing' }
  | { kind: 'unknown' }
  | { kind: 'blocked' }
  | { kind: 'waiting' };

export function requestEvidence(events: readonly PersistedEvent[], requestId: string, liveTurnId?: string, childIds: ReadonlySet<string> = new Set(), taskIds: ReadonlySet<string> = new Set()): InputEvidence {
  const accepted = events.findLast(event => event.type === 'user.message' &&
    event.botInput?.request?.id === requestId && event.botInput.request.role === 'request');
  if (!accepted) return { kind: 'missing' };
  const continuation = childIds.size || taskIds.size ? events.findLast(event => event.type === 'user.message' && event.seq > accepted.seq &&
    ((event.botInput?.request?.role === 'result' && childIds.has(event.botInput.request.id)) ||
     (event.botInput?.task?.role === 'result' && taskIds.has(event.botInput.task.id)))) : undefined;
  const input = continuation ?? accepted;
  const turnId = input.turnId;
  if (!turnId) return { kind: 'unknown' };
  if ((childIds.size || taskIds.size) && !continuation) return { kind: 'waiting' };
  const completed = events.findLast(event => event.type === 'turn.completed' && event.turnId === turnId && event.seq > input.seq);
  if (!completed || completed.type !== 'turn.completed') return liveTurnId === turnId ? { kind: 'running', turnId } : { kind: 'unknown' };
  if (completed.outcome !== 'completed') {
    const message = completed.error?.slice(0, 1_000).toWellFormed() || 'The recipient turn stopped before completing.';
    return { kind: 'failed', turnId, seq: completed.seq, message };
  }
  if (completed.needs === 'you') return { kind: 'running', turnId };
  const output = events.filter(event => event.type === 'assistant.text' && event.turnId === turnId &&
    event.seq > input.seq && event.seq < completed.seq && !event.narration && !event.summary && event.text.trim());
  const answer = output.findLast(event => event.type === 'assistant.text' && event.final) ?? output.at(-1);
  if (answer?.type !== 'assistant.text') {
    return { kind: 'failed', turnId, seq: completed.seq, message: 'The recipient did not provide a recorded reply.' };
  }
  return { kind: 'complete', turnId, seq: answer.seq, text: answer.text };
}
