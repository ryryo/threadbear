// DS-Bot groupSessionFor, groups.js L828–861. The durable member reservation
// uses Threadbear's Thread, queue and event log instead of a DSH group Session.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
import { randomUUID } from 'node:crypto';
import { ceilingMode, lowerMode } from '../access.ts';
import type { BotInputRef } from '../protocol.ts';
import type { Runner } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import { botThreadOptions } from './conversations.ts';
import { keepResult, resultText, type KeptResult } from './handoff-result.ts';
import type { GroupCall } from './group-round.ts';
import type { GroupBook, GroupStore } from './group-store.ts';

export type GroupInput = NonNullable<BotInputRef['group']>;
type Proof =
  | { kind: 'new' | 'waiting' | 'unknown' }
  | { kind: 'done'; result?: KeptResult; worked: boolean }
  | { kind: 'failed'; reason: string };

export class GroupThreads {
  private readonly runner: Runner;
  private readonly groups: GroupStore;

  constructor(runner: Runner, groups: GroupStore) {
    this.runner = runner;
    this.groups = groups;
  }

  check(rec: ThreadRecord): GroupBook {
    const link = rec.botLink;
    if (!link?.groupId || rec.copied || rec.privateBotId) throw new Error('This is not a Group participant Thread.');
    const book = this.groups.get(link.groupId);
    const saved = book.threads[link.botId];
    if (book.group.archivedAt || saved?.threadId !== rec.id || saved.id !== link.conversationId || !this.groups.member(book.group, link.botId)) {
      throw new Error('This Thread no longer belongs to an active Group member.');
    }
    return book;
  }

  reserve(groupId: string, slot: GroupCall): string {
    const book = this.groups.get(groupId);
    const current = book.round?.slots.find(call => call.callId === slot.callId && call.status === 'waiting');
    if (!current || book.frozen || !this.groups.member(book.group, current.id)) throw new Error('This Group call is no longer waiting for a member.');
    return this.groups.change(groupId, next => {
      const link = next.threads[slot.id] ??= { id: randomUUID(), threadId: randomUUID(), sessionId: randomUUID() };
      const reserved = next.round?.slots.find(call => call.callId === slot.callId && call.status === 'waiting');
      if (!reserved) throw new Error('This Group call changed before reservation.');
      reserved.threadId = link.threadId;
      reserved.turnId = this.messageId(slot.callId);
      reserved.status = 'speaking';
      return link.threadId;
    });
  }

  messageId(callId: string): string {
    return `bot-group:${callId}`;
  }

  private open(book: GroupBook, slot: GroupCall): ThreadRecord | undefined {
    const { runner, groups } = this;
    const link = book.threads[slot.id];
    const bot = groups.member(book.group, slot.id);
    if (!link || !bot || slot.threadId !== link.threadId || book.frozen || book.group.archivedAt) return undefined;
    const existing = runner.threads.get(link.threadId);
    if (existing) {
      this.check(existing.rec);
      return existing.rec;
    }
    // A draining Runner can still own a kept Thread. Never recreate its
    // record, nor read absence from this process as proof of no delivery.
    if (runner.store.load(link.threadId)) return undefined;
    const ceiling = lowerMode(book.group.ceiling, book.round?.schedule?.ceiling ?? 'full');
    const defaults = botThreadOptions(runner, bot, ceiling);
    const rec = runner.makeThread({ ...defaults, text: '', title: `${book.group.title} · ${bot.name}`, worktree: false }, {
      id: link.threadId, sessionId: link.sessionId,
      botLink: { botId: bot.id, groupId: book.group.id, conversationId: link.id },
    }).st.rec;
    this.check(rec);
    return rec;
  }

  take(book: GroupBook, slot: GroupCall, roundId: string, text: string): boolean {
    const rec = this.open(book, slot);
    if (!rec) return false;
    const bot = this.groups.member(book.group, slot.id);
    if (!bot) return false;
    const scheduled = book.round?.schedule;
    const savedLimit = lowerMode(book.group.ceiling, scheduled?.ceiling ?? 'full');
    const ceiling = ceilingMode(lowerMode(savedLimit, bot.permissionCeiling ?? 'full'));
    // As in DS-Bot's unseenLines, the member already has its own messages.
    const others = book.events.filter(row => row.roundId === roundId && row.memberId !== bot.id &&
      ['result', 'task-result'].includes(row.kind) && typeof row.text === 'string').slice(-12);
    const nearby = others.map(row => {
      const member = typeof row.memberId === 'string' && this.groups.member(book.group, row.memberId);
      return `${member ? member.name : 'Former member'}: ${String(row.text)}`;
    });
    const body = nearby.length && !slot.summary ? [
      text, '', 'Updates from the current Group call:', ...nearby,
    ].join('\n') : text;
    this.runner.send(rec.id, body, [], {
      origin: scheduled ? 'schedule' : 'runner', scheduleId: scheduled?.id, queue: true, messageId: this.messageId(slot.callId), ceiling,
      botSource: { kind: 'runner' }, botGroup: { groupId: book.group.id, roundId, callId: slot.callId },
    });
    return true;
  }

  read(slot: GroupCall): Proof {
    if (!slot.threadId) return { kind: 'new' };
    const { runner } = this;
    const st = runner.threads.get(slot.threadId);
    if (!st) return runner.store.load(slot.threadId) ? { kind: 'waiting' } : { kind: 'new' };
    if (st.rt.deleted) return { kind: 'failed', reason: 'This Group member’s Thread was deleted.' };
    const log = runner.store.log(st.rec.id);
    const lines = log.read(1, log.lastSeq);
    if (lines.length !== log.lastSeq) return { kind: 'unknown' };
    const input = lines.find(row => row.type === 'user.message' && row.botInput?.group?.callId === slot.callId);
    if (!input) {
      if (st.rec.queue.some(queued => queued.botInput?.group?.callId === slot.callId)) {
        runner.kickQueue(st);
        return { kind: 'waiting' };
      }
      return { kind: 'new' };
    }
    if (!input.turnId) return { kind: 'unknown' };
    const end = lines.findLast(row => row.seq > input.seq && row.turnId === input.turnId && row.type === 'turn.completed');
    if (end?.type !== 'turn.completed' || end.needs === 'you') return { kind: 'waiting' };
    if (end.outcome !== 'completed') return { kind: 'failed', reason: end.error ?? 'The Group member stopped before replying.' };
    const reply = lines.findLast(row => row.seq > input.seq && row.seq < end.seq && row.turnId === input.turnId &&
      row.type === 'assistant.text' && !row.narration && !row.summary && row.text.trim());
    const worked = lines.some(row => row.seq > input.seq && row.seq < end.seq && row.turnId === input.turnId && row.type === 'tool.call');
    return { kind: 'done', worked, ...(reply?.type === 'assistant.text' && { result: keepResult({ threadId: st.rec.id, seq: reply.seq }, reply.text) }) };
  }

  result(value: KeptResult) {
    return resultText(value, source => {
      const row = this.runner.store.log(source.threadId).read(source.seq, source.seq)[0];
      return row?.type === 'assistant.text' ? row.text : undefined;
    });
  }

  stop(groupId: string, threadId: string): void {
    const { runner } = this;
    const st = runner.threads.get(threadId);
    if (!st || st.rec.botLink?.groupId !== groupId || st.rec.copied) return;
    st.rec.queue = st.rec.queue.filter(input => input.botInput?.group?.groupId !== groupId);
    try {
      runner.store.save(st.rec);
    } finally {
      try { runner.interrupt(threadId, { byMike: true }); }
      finally {
        try { st.rt.session?.kill(); }
        finally { runner.stopSubagents(st); runner.markDirty(st); }
      }
    }
  }
}
