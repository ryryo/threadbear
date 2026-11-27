// Round and batch coordination adapts DS-Bot groups.js at d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
import { randomUUID } from 'node:crypto';
import { ErrorCode, RpcError, type PermissionMode } from '../protocol.ts';
import { raises } from '../access.ts';
import type { Runner } from '../runner.ts';
import { isIdleRelayText, normalizeRelayBody } from './group-idle.ts';
import { range } from './group-ledger.ts';
import { groupMentions } from './group-mentions.ts';
import { callIn, startable, type GroupCall } from './group-round.ts';
import { GroupThreads, type GroupInput } from './group-threads.ts';
import type { KeptResult } from './handoff-result.ts';
import { BOT_WORKSPACE_CONCURRENCY, type SavedTask } from './task-journal.ts';
import type { GroupBook, GroupDraft, GroupSchedule, GroupStore } from './group-store.ts';

const ROUND_CALLS = 32;
const IDLE_RELAY_LIMIT = 6;
type Options = {
  runner: Runner; store: GroupStore; owns: () => boolean; otherActive?: () => number;
  narrow?: (id: string, cap: PermissionMode) => void;
  tasks?: (id: string, roundId?: string) => SavedTask[];
  stopTasks?: (id: string, threads?: readonly string[]) => Promise<boolean>;
};

function live(slot: GroupCall): boolean {
  return slot.status === 'speaking' || slot.status === 'waiting';
}

export class BotGroups {
  readonly store: GroupStore;
  readonly threads: GroupThreads;
  private readonly runner: Runner;
  private readonly owns: () => boolean;
  private readonly otherActive: () => number;
  private readonly narrow?: Options['narrow'];
  private readonly tasks: NonNullable<Options['tasks']>;
  private readonly stopTasks?: Options['stopTasks'];

  constructor({ runner, store, owns, otherActive = () => 0, narrow, tasks = () => [], stopTasks }: Options) {
    this.runner = runner;
    this.store = store;
    this.threads = new GroupThreads(runner, store);
    this.owns = owns;
    this.otherActive = otherActive;
    this.narrow = narrow;
    this.tasks = tasks;
    this.stopTasks = stopTasks;
  }

  create(draft: GroupDraft, operationId?: string) { return this.store.create(draft, operationId); }

  async update(id: string, revision: number, draft: Partial<Omit<GroupDraft, 'teamId'>>) {
    const old = this.store.get(id);
    const profile = this.store.update(id, revision, draft);
    const removed = old.group.memberIds.filter(member => !profile.memberIds.includes(member));
    const threads = removed.flatMap(member => old.threads[member]?.threadId ?? []);
    const stopped = this.stopThreads(id, threads);
    const tasksStopped = !threads.length || await this.stopTasks?.(id, threads) !== false;
    if (raises(old.group.ceiling, profile.ceiling)) {
      const members = Object.entries(old.threads).filter(([botId]) => profile.memberIds.includes(botId)).map(([, link]) => link.threadId);
      const active = this.tasks(id).filter(task => profile.memberIds.includes(task.botId) && !('outcome' in task.state));
      for (const threadId of [...members, ...active.map(task => task.threadId)]) {
        try { this.narrow?.(threadId, profile.ceiling); }
        catch { stopped.failed.push(threadId); }
      }
    }
    this.recover();
    return { group: profile, stopped, tasksStopped };
  }

  post(id: string, operationId: string, text: string, scheduled?: GroupSchedule) {
    const post = this.store.post(id, operationId, text, this.runner.isoNow(), scheduled);
    this.recover();
    return post;
  }

  withdraw(id: string, scheduleId: string): void {
    const book = this.store.get(id);
    const queued = book.posts.filter(post => post.schedule?.id === scheduleId);
    const round = book.round?.schedule?.id === scheduleId ? book.round : undefined;
    const waiting = round?.slots.filter(slot => slot.status === 'waiting' && !slot.batchKey && !slot.summary) ?? [];
    const held = round?.slots.filter(slot => {
      const st = slot.threadId && this.runner.threads.get(slot.threadId);
      return slot.status === 'speaking' && st && st.rec.queue.some(input =>
        input.scheduleId === scheduleId && input.botInput?.group?.callId === slot.callId);
    }) ?? [];
    if (!queued.length && !waiting.length && !held.length) return;
    const ids = new Set([...waiting, ...held].map(slot => slot.callId));
    this.store.change(id, next => {
      next.posts = next.posts.filter(post => post.schedule?.id !== scheduleId);
      for (const slot of next.round?.slots ?? []) if (ids.has(slot.callId)) slot.status = 'stopped';
      this.store.append(next, 'schedule-withdrawn', this.runner.isoNow(), { scheduleId, roundId: round?.id });
    });
    for (const slot of held) if (slot.threadId) this.runner.dropScheduled(slot.threadId, scheduleId);
    this.recover();
  }

  read(id: string, from?: number, to?: number) {
    const book = this.store.get(id);
    return {
      group: book.group, frozen: book.frozen, round: book.round, queued: book.posts.length, threads: book.threads,
      tasks: book.round ? this.tasks(id, book.round.id).map(task => ({
        id: task.id, threadId: task.threadId, callId: task.group?.callId, title: task.title, status: task.state.status,
      })) : [],
      events: range(book.events, from ?? Math.max(1, (book.events.at(-1)?.seq ?? 1) - 99), to),
    };
  }

  find(id: string, query: string) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return this.store.get(id).events.filter(event => {
      const text = typeof event.text === 'string' ? event.text.toLowerCase() : undefined;
      return text !== undefined && words.every(word => text.includes(word));
    }).slice(-20).reverse();
  }

  resultRecord(id: string, seq: number) {
    const row = this.store.get(id).events.find(event => event.seq === seq && ['result', 'summary', 'task-result'].includes(event.kind));
    if (!row?.result) throw new RpcError(ErrorCode.threadNotFound, 'No reply is recorded at that point in this Group.');
    return { reportId: row.id, result: row.result as KeptResult };
  }

  result(id: string, seq: number) {
    return this.threads.result(this.resultRecord(id, seq).result);
  }

  resume(id: string) {
    this.store.change(id, book => {
      if (book.group.archivedAt) throw new Error('This Group is archived.');
      book.frozen = false;
    });
    this.recover();
    return this.read(id);
  }

  archive(id: string, revision: number) {
    return this.stopBook(this.store.freeze(id, this.runner.isoNow(), revision));
  }

  stop(id: string) {
    return this.stopBook(this.store.freeze(id, this.runner.isoNow()));
  }

  private async stopBook(book: GroupBook) {
    const stopped = this.stopThreads(book.group.id, Object.values(book.threads).map(link => link.threadId));
    const tasksStopped = await this.stopTasks?.(book.group.id) !== false;
    return { group: book.group, stopped, tasksStopped };
  }

  taskOrigin(rec: import('../store.ts').ThreadRecord): GroupInput | undefined {
    const book = this.threads.check(rec);
    const turnId = this.runner.threads.get(rec.id)?.rt.turn?.turnId;
    const slot = book.round?.slots.find(slot => slot.status === 'speaking' && slot.threadId === rec.id && slot.turnId === turnId);
    if (book.frozen || !book.round || !slot || !turnId || slot.summary) return undefined;
    return { groupId: book.group.id, roundId: book.round.id, callId: slot.callId };
  }

  taskActive(task: SavedTask): boolean | undefined {
    const ref = task.group;
    if (!ref) return undefined;
    const decision = this.queue(task.sourceThreadId, ref);
    return decision === 'wait' ? undefined : decision === 'allow';
  }

  taskReply(task: SavedTask): boolean {
    const ref = task.group;
    if (!ref || !('outcome' in task.state)) return false;
    const active = this.taskActive(task);
    if (active === undefined) return false;
    if (!active) return true; // The Group already stopped this call.
    const book = this.store.get(ref.groupId);
    if (!book.events.some(row => row.kind === 'task-result' && row.taskId === task.id)) {
      const { outcome } = task.state;
      this.store.change(ref.groupId, next => {
        const row = this.store.append(next, 'task-result', this.runner.isoNow(), {
          roundId: ref.roundId, callId: ref.callId, taskId: task.id, memberId: task.botId, threadId: task.threadId,
          result: outcome.result, text: outcome.result?.text ?? outcome.summary, outcome: task.state.status,
        });
        const child = next.round?.slots.find(slot => slot.callId === ref.callId);
        const batch = next.batches.find(batch => batch.key === child?.batchKey);
        batch?.results.push(row.seq);
      });
    }
    return true;
  }

  private stopThreads(groupId: string, ids: string[]) {
    const stopped: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      try { this.threads.stop(groupId, id); stopped.push(id); }
      catch { failed.push(id); }
    }
    return { stopped, failed };
  }

  queue(threadId: string, ref: GroupInput): 'allow' | 'wait' | 'drop' {
    if (!this.owns()) return 'wait';
    try {
      const st = this.runner.threads.get(threadId);
      if (!st || st.rt.deleted) return 'drop';
      const link = st.rec.botLink;
      if (st.rec.copied || st.rec.privateBotId || link?.groupId !== ref.groupId) return 'drop';
      const book = this.store.get(ref.groupId);
      const saved = book.threads[link.botId];
      if (book.group.archivedAt || saved?.threadId !== st.rec.id || saved.id !== link.conversationId ||
          !this.store.member(book.group, link.botId)) return 'drop';
      const { round } = book;
      if (book.group.id !== ref.groupId || book.frozen || round?.id !== ref.roundId ||
          round.status === 'stopped' || round.status === 'done') return 'drop';
      return round.slots.some(slot => slot.callId === ref.callId && slot.status === 'speaking' && slot.threadId === threadId) ? 'allow' : 'drop';
    } catch {
      return 'wait';
    }
  }

  delegate(threadId: string, operationId: string, to: string[], note: string): { key: string; count: number } {
    const st = this.runner.threads.get(threadId);
    if (!this.owns() || !st || !st.rt.turn || st.rt.deleted) throw new Error('Only a speaking member can call its Group.');
    const { group, round, frozen } = this.threads.check(st.rec);
    const origin = round?.slots.find(slot => slot.status === 'speaking' && slot.threadId === threadId && slot.turnId === st.rt.turn?.turnId);
    if (frozen || !origin || origin.summary || round?.status !== 'running') throw new Error('This Group call cannot delegate.');
    const accepted = this.store.change(group.id, book => this.register(book, origin, operationId, to, note));
    this.recover();
    return accepted;
  }

  private register(book: GroupBook, origin: GroupCall, operationId: string, to: string[], note: string) {
    const current = book.round!;
    const known = book.batches.find(batch => batch.origin === origin.callId && batch.operationId === operationId);
    const prior = book.events.find(row => row.kind === 'batch' && row.batchId === known?.key);
    const targets = [...new Set(to)];
    if (known) {
      if (known.note !== note || JSON.stringify(prior?.memberIds) !== JSON.stringify(targets)) throw new Error('That operation already names different Group work.');
      return { key: known.key, count: targets.length };
    }
    if (book.batches.some(batch => batch.origin === origin.callId)) {
      throw new Error('Call all the members for this work together.');
    }
    const ancestors = new Set([origin.id]);
    let parent = origin.batchKey;
    while (parent && ancestors.size < 4) {
      const batch = book.batches.find(item => item.key === parent);
      const caller = current.slots.find(slot => slot.callId === batch?.origin);
      if (!caller || ancestors.has(caller.id)) throw new Error('This Group call has a cycle.');
      ancestors.add(caller.id);
      parent = caller.batchKey;
    }
    const owed = book.batches.filter(item => !item.summary).length;
    if (ancestors.size >= 4 || targets.some(id => ancestors.has(id)) ||
        current.slots.length + targets.length + owed + 1 > ROUND_CALLS) {
      throw new Error('This Group call exceeds its delegation limit.');
    }
    const peers = targets.flatMap(id => this.store.member(book.group, id) ?? []);
    if (!targets.length || peers.length !== targets.length) throw new Error('Choose active members of this Group.');
    const key = randomUUID();
    callIn(current, peers, note, origin.id, { batchKey: key });
    // The source counts by member ID in DS-Bot; a separate call ID here
    // distinguishes repeated work by one member and stays stable at recovery.
    const pending = current.slots.filter(slot => slot.batchKey === key).map(slot => slot.callId);
    book.batches.push({ key, by: origin.id, origin: origin.callId, operationId, note, pending, doneIds: [], results: [] });
    this.store.append(book, 'batch', this.runner.isoNow(), { roundId: current.id, batchId: key, memberIds: targets });
    return { key, count: pending.length };
  }

  activeCount(): number {
    return this.store.list().reduce((count, group) => count + (this.store.get(group.id).round?.slots.filter(slot => slot.status === 'speaking').length ?? 0), 0);
  }

  recover(): void {
    if (!this.owns()) return;
    const groups = this.store.list().filter(group => !group.archivedAt);
    // Settle every saved result before counting capacity for new admissions.
    for (const group of groups) this.settle(group.id);
    for (const group of groups) {
      // Calls which fail before entering the Runner emit no Thread event.
      // Continue through that saved state without waiting for a wake from it.
      for (let i = 0; i < ROUND_CALLS; i++) {
        if (!this.dispatch(group.id)) break;
      }
    }
  }

  private settle(id: string): void {
    const book = this.store.get(id);
    if (book.frozen || !book.round || book.round.status === 'done' || book.round.status === 'stopped') return;
    for (const slot of book.round.slots.filter(slot => slot.status === 'speaking')) {
      if (!this.store.member(book.group, slot.id)) {
        this.complete(id, slot, { kind: 'failed', reason: 'This member no longer belongs to the Group.' });
        if (slot.threadId) this.stopThreads(id, [slot.threadId]);
        continue;
      }
      const pendingTask = this.tasks(id, book.round.id).some(task => task.group?.callId === slot.callId &&
        (!('outcome' in task.state) || (task.state.reply && !task.state.reply.sent)));
      if (pendingTask) continue;
      const proof = this.threads.read(slot);
      if (proof.kind === 'done' || proof.kind === 'failed') this.complete(id, slot, proof);
    }
    this.advance(id);
  }

  private complete(id: string, slot: GroupCall, outcome: { kind: 'done'; result?: KeptResult; worked: boolean } | { kind: 'failed'; reason: string }): void {
    this.store.change(id, book => {
      const round = book.round!;
      const current = round.slots.find(call => call.callId === slot.callId);
      if (!current || current.status !== 'speaking' || book.frozen) return;
      current.status = outcome.kind;
      const result = outcome.kind === 'done' ? outcome.result : undefined;
      if (outcome.kind === 'done' && outcome.result && !current.summary) {
        this.callMentioned(book, current, outcome.result, outcome.worked);
      }
      const row = this.store.append(book, current.summary ? 'summary' : 'result', this.runner.isoNow(), {
        roundId: round.id, memberId: current.id, callId: current.callId, threadId: current.threadId,
        text: outcome.kind === 'failed' ? outcome.reason : result?.text, result, outcome: outcome.kind,
      });
      const batch = book.batches.find(batch => batch.key === current.batchKey);
      if (batch?.pending.includes(current.callId)) {
        batch.pending = batch.pending.filter(id => id !== current.callId);
        batch.doneIds.push(current.id);
        batch.results.push(row.seq);
      }
    });
  }

  private callMentioned(book: GroupBook, slot: GroupCall, result: KeptResult, worked: boolean): void {
    const members = book.group.memberIds.flatMap(id => this.store.member(book.group, id) ?? []);
    const saved = this.threads.result(result);
    if (!saved.whole) return;
    const text = saved.text;
    const prior = book.events.filter(row => row.kind === 'result' && row.memberId === slot.id && row.roundId === book.round?.id)
      .flatMap(row => typeof row.text === 'string' ? [normalizeRelayBody(row.text, members)] : []);
    const idle = !worked && isIdleRelayText(text, members, prior);
    book.idleRelays = idle ? book.idleRelays + 1 : 0;
    if (book.batches.some(batch => batch.origin === slot.callId)) return;
    const targets = groupMentions(text, members).flatMap(span => 'bot' in span ? [span.bot.id] :
      slot.id === book.group.adminId ? members.map(member => member.id) : []).filter(id => id !== slot.id);
    if (!targets.length) return;
    try {
      if (idle && book.idleRelays >= IDLE_RELAY_LIMIT) throw new Error('Write a message to continue after repeated acknowledgements.');
      this.register(book, slot, 'member-mentions', targets, text.slice(0, 30_000).toWellFormed());
    } catch (error) {
      this.store.append(book, 'notice', this.runner.isoNow(), {
        roundId: book.round?.id, callId: slot.callId, text: error instanceof Error ? error.message : 'The Group could not call its members.',
      });
    }
  }

  private advance(id: string): boolean {
    const book = this.store.get(id);
    if (book.frozen || !book.round || book.round.status === 'done' || book.round.status === 'stopped') return false;
    const round = book.round;
    const finished = (id: string) => !round.slots.some(slot => slot.callId === id && live(slot));
    const ready = book.batches.filter(batch => !batch.summary && batch.results.length && finished(batch.origin) &&
      batch.pending.every(finished) && this.store.member(book.group, batch.by));
    const status = round.slots.some(slot => live(slot) && !slot.summary) ? 'running'
      : round.slots.some(live) || ready.length ? 'finalizing' : 'done';
    if (!ready.length && status === round.status) return false;
    this.store.change(id, next => {
      const saved = next.round!;
      // Save summary admission with the round. Replaying child results
      // after a restart cannot create a second summary call.
      for (const batch of ready) {
        const asker = this.store.member(next.group, batch.by);
        const slot = next.batches.find(row => row.key === batch.key);
        if (!asker || !slot || saved.slots.length >= ROUND_CALLS) continue;
        const lines = batch.results.map(seq => {
          const result = next.events.find(event => event.seq === seq);
          return `${String(result?.memberId ?? '')}: ${String(result?.text ?? '')}`;
        });
        callIn(saved, [asker], `Summarize the finished Group work.\n\n${lines.join('\n')}`, undefined, { summary: true });
        slot.summary = saved.slots.at(-1)!.callId;
      }
      saved.status = status;
    });
    return true;
  }

  private dispatch(id: string): boolean {
    this.store.startNext(id);
    const book = this.store.get(id);
    if (book.frozen || !book.round || book.round.status === 'done' || book.round.status === 'stopped') return false;
    const candidates = book.round.slots.filter(slot => slot.status === 'speaking' || startable(book.round!, slot));
    for (const candidate of candidates) {
      const current = this.store.get(id);
      const round = current.round;
      const slot = round?.slots.find(slot => slot.callId === candidate.callId);
      if (!round || !slot || current.frozen) continue;
      if (!this.store.member(current.group, slot.id)) {
        if (slot.status === 'waiting') this.store.change(id, next => {
          const expired = next.round?.slots.find(call => call.callId === slot.callId);
          if (expired) expired.status = 'stopped';
        });
        continue;
      }
      if (slot.status === 'waiting') {
        if (this.activeCount() + this.otherActive() >= BOT_WORKSPACE_CONCURRENCY || !startable(round, slot)) continue;
        this.threads.reserve(id, slot);
      }
      this.admit(id, slot.callId);
    }
    return this.advance(id);
  }

  private admit(id: string, callId: string): void {
    const book = this.store.get(id);
    const round = book.round!;
    const slot = round.slots.find(call => call.callId === callId);
    if (!slot || slot.status !== 'speaking' || this.threads.read(slot).kind !== 'new') return;
    try {
      this.threads.take(book, slot, round.id, slot.note ?? '');
    } catch {
      if (this.threads.read(slot).kind === 'new') this.complete(id, slot, { kind: 'failed', reason: 'The Runner could not start this Group call.' });
    }
  }
}
