import { realpathSync } from 'node:fs';
import { ceilingMode, lowerMode } from '../access.ts';
import { ErrorCode, RpcError, type BotInputRef, type PermissionMode } from '../protocol.ts';
import type { Runner, ThreadState } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import type { BotRepository } from './repository.ts';
import { keepResult, resultText } from './handoff-result.ts';
import { BackgroundBotTasks } from './task-service.ts';
import type { SavedTask, StartTask, TaskJournal } from './task-journal.ts';

type TaskDraft = Pick<StartTask, 'title' | 'brief' | 'operationId' | 'retryOf'> & { folder?: string };
type TaskInput = NonNullable<BotInputRef['task']>;
type Options = { runner: Runner; repo: BotRepository; journal: TaskJournal; owns: () => boolean; parent: (id: string) => string | undefined;
  childRequests?: (threadId: string) => boolean;
  cancelChildRequests?: (threadId: string) => void;
  parentCancelled?: (id: string) => boolean;
};

export class BotTaskThreads {
  private readonly options: Options;
  private readonly stopping = new Set<string>();

  constructor(options: Options) { this.options = options; }

  private local(threadId: string): ThreadState {
    const state = this.options.runner.threads.get(threadId);
    if (!state || state.rt.deleted || state.rec.copied) throw new RpcError(ErrorCode.threadNotFound, 'The task conversation is unavailable.');
    return state;
  }

  private normal(threadId: string) {
    const { rec } = this.local(threadId);
    const link = rec.botLink;
    const { repo, runner } = this.options;
    if (!link || link.taskId || !repo.matchesConversation(link.botId, link.conversationId, threadId)) {
      throw new RpcError(ErrorCode.notAllowed, 'Start the task from the Bot’s normal conversation.');
    }
    const bot = repo.get(link.botId);
    if (bot.archivedAt || bot.privacy?.moving || rec.archivedAt) throw new RpcError(ErrorCode.notAllowed, 'The source Bot conversation cannot start a task right now.');
    return { ...link, threadId, folder: rec.cwd, privateBotId: runner.privateBotOf(threadId),
      settings: { accountId: rec.accountId, model: rec.model, effort: rec.effort } };
  }

  private engine(authorize: (threadId: string, cwd: string, text: string) => Promise<PermissionMode>) {
    const { runner, journal, parent } = this.options;
    return new BackgroundBotTasks({
      journal, source: id => this.normal(id), parent: source => parent(source.threadId), clock: () => runner.isoNow(),
      authorize: async (source, request) => {
        const folder = realpathSync.native(request.folder || source.folder);
        const permission = await authorize(source.threadId, folder, request.brief);
        runner.checkBotFolder(folder, source.privateBotId);
        return { folder, ceiling: ceilingMode(lowerMode(permission, runner.accessOf(source.threadId))) };
      },
      admitted: task => this.findInput(task),
      openThread: (task, source, folder) => {
        const existing = runner.threads.get(task.threadId)?.rec;
        if (existing) { this.check(existing); return; }
        const permissionMode = ceilingMode(lowerMode(task.ceiling ?? 'ask', runner.accessOf(source.threadId)));
        runner.makeThread({
          text: '', title: task.title, cwd: folder, worktree: false, ...task.settings, permissionMode,
          startedBy: { kind: 'thread', threadId: source.threadId, label: 'Bot task' },
        }, {
          id: task.threadId, sessionId: task.nativeSessionId,
          botLink: { botId: task.botId, conversationId: task.id, taskId: task.id },
          privateBotId: source.privateBotId,
        });
      },
      enqueue: (task, text) => runner.send(task.threadId, text, [], {
        ceiling: task.ceiling ?? 'ask', origin: 'runner', queue: true,
        botSource: { kind: 'thread', threadId: task.sourceThreadId }, botTask: { id: task.id, role: 'work' },
        messageId: `bot-task-input:${task.id}`,
      }),
      stop: async task => this.stopThread(task),
    });
  }

  private findInput(task: SavedTask): { kind: 'new' | 'unknown' } | { kind: 'accepted'; turnId: string } {
    const { runner } = this.options;
    const state = runner.threads.get(task.threadId);
    if (!state) return runner.store.load(task.threadId) ? { kind: 'unknown' } : { kind: 'new' };
    try {
      this.check(state.rec);
      const log = runner.store.log(task.threadId);
      const events = log.read(1, log.lastSeq);
      if (events.length !== log.lastSeq) return { kind: 'unknown' };
      const input = events.find(event => event.type === 'user.message' && event.botInput?.task?.id === task.id && event.botInput.task.role === 'work');
      if (input) return input.turnId ? { kind: 'accepted', turnId: input.turnId } : { kind: 'unknown' };
      const queued = state.rec.queue.find(entry => entry.botInput?.task?.id === task.id && entry.botInput.task.role === 'work');
      return queued ? { kind: 'accepted', turnId: queued.turnId } : { kind: 'new' };
    } catch {
      return { kind: 'unknown' };
    }
  }

  check(rec: ThreadRecord): SavedTask {
    const link = rec.botLink;
    const task = link?.taskId && this.options.journal.get(link.taskId);
    if (!task || task.threadId !== rec.id || task.botId !== link?.botId || link.conversationId !== task.id || task.privateBotId !== rec.privateBotId) {
      throw new RpcError(ErrorCode.notAllowed, 'The Thread does not match this Bot task.');
    }
    return task;
  }

  active(rec: ThreadRecord): SavedTask {
    const task = this.check(rec);
    if ('outcome' in task.state || this.stopping.has(task.id)) {
      throw new RpcError(ErrorCode.notAllowed, 'This Bot task has ended.');
    }
    return task;
  }

  queue(threadId: string, ref: TaskInput): 'allow' | 'wait' | 'drop' {
    if (!this.options.owns()) return 'wait';
    try {
      const task = this.options.journal.get(ref.id);
      if (task.originRequestId && this.options.parentCancelled?.(task.originRequestId)) return 'drop';
      if (ref.role === 'work') {
        const bot = this.options.repo.get(task.botId);
        if (bot.archivedAt || bot.privacy?.moving) return 'drop';
        return task.threadId === threadId && !('outcome' in task.state) && !this.stopping.has(task.id) ? 'allow' : 'drop';
      }
      return task.sourceThreadId === threadId && 'outcome' in task.state && task.state.reply ? 'allow' : 'drop';
    } catch {
      return 'wait';
    }
  }

  async start(threadId: string, draft: TaskDraft, authorize: (threadId: string, cwd: string, text: string) => Promise<PermissionMode>) {
    if (!this.options.owns()) throw new RpcError(ErrorCode.busy, 'The Bot workspace is handing over.');
    return this.engine(authorize).start(threadId, draft);
  }

  async cancel(id: string, revision: number) {
    const result = await this.engine(async () => 'ask').cancel(id, revision);
    if (result.saved) this.stopping.delete(id);
    return result;
  }

  retry(id: string, revision: number, brief: string, operationId: string) {
    const previous = this.options.journal.get(id);
    if (previous.revision !== revision || !('outcome' in previous.state)) {
      throw new RpcError(ErrorCode.notAllowed, 'Only a finished task can be tried again.');
    }
    const source = this.normal(previous.sourceThreadId);
    const folder = source.privateBotId === previous.privateBotId ? previous.folder : source.folder;
    return this.start(previous.sourceThreadId, {
      operationId: `retry:${id}:${operationId}`, title: previous.title, brief, folder, retryOf: id,
    }, async () => previous.ceiling ?? 'ask');
  }

  private stopThread(task: SavedTask): void {
    this.stopping.add(task.id);
    const { runner } = this.options;
    const st = runner.threads.get(task.threadId);
    if (!st) return;
    this.check(st.rec);
    st.rec.queue = [];
    try { runner.store.save(st.rec); }
    catch { runner.notice('warning', 'The Bot task stopped, but its cleared queue could not be saved.'); }
    finally {
      try {
        runner.interrupt(task.threadId, { byMike: true });
      } finally {
        try { st.rt.session?.kill(); }
        finally {
          runner.stopSubagents(st);
          runner.markDirty(st);
          this.options.cancelChildRequests?.(task.threadId);
        }
      }
    }
  }

  get(id: string) { return this.options.journal.get(id); }
  hasActive(botId: string): boolean { return this.options.journal.hasActive(botId); }
  children(requestId: string) { return this.options.journal.children(requestId); }

  list(botId: string, before?: string) {
    this.options.repo.get(botId);
    return this.options.journal.list(botId, before);
  }

  send(id: string, text: string, operationId: string) {
    const task = this.options.journal.get(id);
    if ('outcome' in task.state || this.stopping.has(id)) throw new RpcError(ErrorCode.notAllowed, 'This Bot task has ended.');
    const st = this.local(task.threadId);
    this.active(st.rec);
    const { runner } = this.options;
    const messageId = `bot-task-note:${id}:${operationId}`;
    const log = runner.store.log(task.threadId);
    const previous = log.read(1, log.lastSeq).find(event => event.type === 'user.message' && event.botInput?.id === messageId);
    const queued = st.rec.queue.find(input => input.botInput?.id === messageId);
    if (previous?.type === 'user.message' || queued) {
      const saved = previous?.type === 'user.message' ? previous.text : queued?.text;
      if (saved !== text) throw new RpcError(ErrorCode.badParams, 'This operation already belongs to a different task message.');
      return { turnId: previous?.turnId ?? queued?.turnId };
    }
    return runner.send(task.threadId, text, [], {
      origin: 'runner', queue: true, messageId, ceiling: task.ceiling ?? 'ask',
      botSource: { kind: 'owner' }, botTask: { id: task.id, role: 'work' },
    });
  }

  recover(threadId?: string): void {
    if (!this.options.owns()) return;
    const { runner } = this.options;
    for (const task of this.options.journal.pending()) {
      if (threadId && task.threadId !== threadId && task.sourceThreadId !== threadId) continue;
      const st = runner.threads.get(task.threadId);
      if (!st) continue; // Still on another process until adopt(), or gone.
      try {
        this.check(st.rec);
        if (task.originRequestId && this.options.parentCancelled?.(task.originRequestId)) {
          if (!('outcome' in task.state) && !this.stopping.has(task.id)) {
            this.engine(async () => 'ask').cancel(task.id, task.revision, false).catch(() =>
              runner.notice('warning', 'The Runner could not stop a saved Bot task.'));
          }
          continue;
        }
        if ('outcome' in task.state) {
          this.deliverResult(task);
          continue;
        }
        const log = runner.store.log(task.threadId);
        const ended = log.read(1, log.lastSeq).findLast(event => event.type === 'turn.completed');
        const current = ended?.type === 'turn.completed' ? this.resultFromTurn(task.id, ended.turnId) : task;
        if ('outcome' in current.state) {
          this.deliverResult(current);
          continue;
        }
        if (st.rt.turn && current.state.status === 'queued') {
          this.options.journal.progress(current.id, current.revision, runner.isoNow(), { status: 'running', turnId: st.rt.turn.turnId });
          continue;
        }
        const recovered = this.engine(async () => 'ask').recover(current, {
          kept: Boolean(runner.keeping()?.includes(task.threadId)),
          activeTurn: Boolean(st.rt.turn), switching: Boolean(st.rt.moving || st.rec.handoff),
          runningJobs: st.rt.tasks.length > 0, queuedInput: st.rec.queue.length > 0,
          approval: st.rt.approvals.size > 0 || ended?.type === 'turn.completed' && ended.needs === 'you',
          children: this.options.childRequests?.(task.threadId) === true,
        });
        if ('outcome' in recovered.state) this.deliverResult(recovered);
        if (st.rec.queue.length) runner.kickQueue(st);
      } catch {
        runner.notice('warning', 'The Runner could not reconcile a saved Bot task.');
      }
    }
  }

  private deliverResult(task: SavedTask): void {
    if (!('outcome' in task.state) || !task.state.reply || task.state.reply.sent) return;
    const { runner, journal } = this.options;
    if (task.originRequestId && this.options.parentCancelled?.(task.originRequestId)) return;
    const destination = this.normal(task.sourceThreadId);
    if (destination.conversationId !== task.sourceConversationId || destination.privateBotId !== task.privateBotId) return;
    const st = this.local(task.sourceThreadId);
    const log = runner.store.log(task.sourceThreadId);
    const { id } = task.state.reply;
    const evidence = log.read(1, log.lastSeq);
    if (evidence.length !== log.lastSeq) return;
    if (!evidence.some(event => event.type === 'user.message' && event.botInput?.id === id) &&
        !st.rec.queue.some(input => input.botInput?.id === id)) {
      const result = this.taskResult(task.id).result;
      const preview = result?.text ?? task.state.outcome.summary;
      const text = result && !result.whole ? `${preview}

[The full result is unavailable.]` : preview;
      runner.send(task.sourceThreadId, `[Background task: ${task.title}]

${text || task.state.status}`, [], {
        origin: 'runner', queue: true, messageId: id, ceiling: ceilingMode(lowerMode(task.ceiling ?? 'ask', runner.accessOf(task.threadId))),
        botSource: { kind: 'thread', threadId: task.threadId }, botTask: { id: task.id, role: 'result' },
      });
    }
    journal.returned(task.id, task.revision, runner.isoNow(), id);
  }

  taskResult(id: string) {
    const row = this.options.journal.get(id);
    if (!('outcome' in row.state)) return { task: row };
    const saved = row.state.outcome.result;
    return { task: row, result: saved && resultText(saved, source => {
      const log = this.options.runner.store.log(source.threadId);
      const event = log.read(source.seq, source.seq)[0];
      return event?.type === 'assistant.text' ? event.text : undefined;
    }) };
  }

  resultFromTurn(id: string, turnId: string) {
    const row = this.options.journal.get(id);
    if ('outcome' in row.state) return row;
    const { runner, journal } = this.options;
    const st = this.local(row.threadId);
    if ((st.rt.turn && st.rt.turn.turnId !== turnId) || st.rt.tasks.length || st.rt.approvals.size || st.rec.queue.length || this.options.childRequests?.(row.threadId)) return row;
    const log = runner.store.log(row.threadId);
    const events = log.read(1, log.lastSeq).filter(event => event.turnId === turnId);
    const done = events.findLast(event => event.type === 'turn.completed');
    if (done?.type !== 'turn.completed' || done.needs === 'you') return row;
    const answer = events.findLast(event => event.type === 'assistant.text' && !event.narration && !event.summary);
    const result = answer?.type === 'assistant.text' ? keepResult({ threadId: row.threadId, seq: answer.seq }, answer.text) : undefined;
    const status = done.outcome === 'completed' ? 'completed' : done.outcome === 'interrupted' ? 'interrupted' : 'failed';
    return journal.finish(row.id, row.revision, runner.isoNow(), status, result?.text ?? done.error ?? '', result, true);
  }
}
