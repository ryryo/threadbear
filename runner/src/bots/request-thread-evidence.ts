import type { PersistedEvent } from '../protocol.ts';
import type { Runner } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import type { KeptResult } from './handoff-result.ts';
import { requestEvidence, type InputEvidence } from './request-events.ts';
import type { SavedTask } from './task-journal.ts';
import type { RequestRow } from './request-state.ts';

function events(runner: Runner, threadId: string, kept = false): PersistedEvent[] | undefined {
  try {
    const log = kept ? runner.store.peerLog(threadId) : runner.store.log(threadId);
    const list = log.read(1, log.lastSeq);
    if (list.length !== log.lastSeq) return undefined;
    return list;
  } catch {
    return undefined;
  }
}

function matches(rec: ThreadRecord | undefined, row: RequestRow, reply: boolean): rec is ThreadRecord {
  const conversationId = reply ? row.sourceConversationId : row.targetConversationId;
  const botId = reply ? row.sourceBotId : row.targetBotId;
  return Boolean(rec && !rec.copied && rec.botLink?.conversationId === conversationId &&
    (botId === undefined || rec.botLink.botId === botId));
}

function recipient(runner: Runner, row: RequestRow, reply: boolean) {
  const threadId = reply ? row.sourceThreadId : row.targetThreadId;
  const state = runner.threads.get(threadId);
  return state && !state.rt.deleted && matches(state.rec, row, reply) ? state : undefined;
}

export class RequestThreadEvidence {
  private readonly runner: Runner;
  private readonly peerOwns?: (id: string) => boolean;

  constructor(runner: Runner, peerOwns?: (id: string) => boolean) {
    this.runner = runner;
    this.peerOwns = peerOwns;
  }

  input(row: RequestRow, children: readonly RequestRow[] = [], tasks: readonly SavedTask[] = []): InputEvidence {
    const st = recipient(this.runner, row, false);
    const id = row.targetThreadId;
    const kept = !st && !this.runner.threads.has(id) && this.peerOwns?.(id) === true;
    const rec = st?.rec ?? (kept ? this.runner.store.load(id) : undefined);
    if (!matches(rec, row, false) || (kept && rec.privateBotId !== row.targetPrivateBotId)) return { kind: 'waiting' };
    const journal = events(this.runner, id, kept);
    if (!journal) return { kind: kept ? 'waiting' : 'unknown' };
    // Check saved events before a stale queue snapshot; the existing Runner
    // flushes the authenticated input event before calling the CLI.
    const childIds = new Set(children.filter(child => child.state.status === 'returned' && child.sourceThreadId === row.targetThreadId).map(child => child.id));
    const taskIds = new Set(tasks.filter(task => 'outcome' in task.state && task.state.reply?.sent && task.sourceThreadId === row.targetThreadId).map(task => task.id));
    const waitsForChild = children.some(child => !['returned', 'failed', 'cancelled'].includes(child.state.status)) ||
      tasks.some(task => !('outcome' in task.state) || (task.state.reply && !task.state.reply.sent));
    const waitsForResult = rec.queue.some(input =>
      (input.botInput?.request?.role === 'result' && childIds.has(input.botInput.request.id)) ||
      (input.botInput?.task?.role === 'result' && taskIds.has(input.botInput.task.id)));
    const evidence = waitsForChild || waitsForResult ? { kind: 'waiting' as const } : requestEvidence(journal, row.id, st?.rt.turn?.turnId, childIds, taskIds);
    if (kept && evidence.kind !== 'complete' && evidence.kind !== 'failed') return { kind: 'waiting' };
    if (evidence.kind !== 'missing') return evidence;
    const queued = rec.queue.find(entry => entry.botInput?.request?.id === row.id && entry.botInput.request.role === 'request');
    return queued ? { kind: 'queued', turnId: queued.turnId } : { kind: 'missing' };
  }

  reply(row: RequestRow, replyId: string): 'queued' | 'sent' | 'missing' | 'unknown' | 'blocked' {
    const st = recipient(this.runner, row, true);
    if (!st) return 'blocked';
    const journal = events(this.runner, st.rec.id);
    if (!journal) return 'unknown';
    if (journal.some(event => event.type === 'user.message' && event.botInput?.id === replyId &&
        event.botInput.request?.id === row.id && event.botInput.request.role === 'result')) return 'sent';
    return st.rec.queue.some(entry => entry.botInput?.id === replyId &&
      entry.botInput.request?.id === row.id && entry.botInput.request.role === 'result') ? 'queued' : 'missing';
  }

  readResult({ threadId, seq }: KeptResult['source']): string | undefined {
    const local = this.runner.threads.has(threadId);
    if (!local && !this.peerOwns?.(threadId)) return undefined;
    try {
      const log = local ? this.runner.store.log(threadId) : this.runner.store.peerLog(threadId);
      const event = log.read(seq, seq)[0];
      return event?.seq === seq && event.type === 'assistant.text' ? event.text : undefined;
    } catch {
      return undefined;
    }
  }

  removeQueued(row: RequestRow): void {
    for (const reply of [false, true]) {
      const st = recipient(this.runner, row, reply);
      if (!st) continue;
      const queue = st.rec.queue.filter(item => item.botInput?.request?.id !== row.id);
      if (queue.length === st.rec.queue.length) continue;
      const before = st.rec.queue;
      st.rec.queue = queue;
      try {
        this.runner.store.save(st.rec);
      } catch (error) {
        st.rec.queue = before;
        throw error;
      }
      this.runner.markDirty(st);
    }
  }
}
