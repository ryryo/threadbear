import { ceilingMode, lowerMode } from '../access.ts';
import { ErrorCode, RpcError, type BotInputRef, type PermissionMode, type PersistedEvent } from '../protocol.ts';
import type { Runner, ThreadState } from '../runner.ts';
import type { BotRepository } from './repository.ts';
import { BotRequestDispatch, type AuthorizeRequest, type RequestActor, type RequestDraft, type RequestLink } from './request-dispatch.ts';
import { RequestReceipts } from './request-receipts.ts';
import { BotRequestReturn } from './request-return.ts';
import { RequestStateStore, type RequestRow } from './request-state.ts';
import { RequestThreadEvidence } from './request-thread-evidence.ts';
import { resultText } from './handoff-result.ts';
import type { SavedTask } from './task-journal.ts';
import { activeBotInput } from './turn-proof.ts';

type Options = { root: string; runner: Runner; repo: BotRepository; owns: () => boolean; protect: () => void; protectAbandonment?: () => void; warn: () => void;
  task?: (id: string) => SavedTask | undefined;
  childTasks?: (requestId: string) => readonly SavedTask[];
  onCancel?: (row: RequestRow) => void;
  peerOwns?: (threadId: string) => boolean;
};
type Correlation = NonNullable<BotInputRef['request']>;
export type PublicDraft = Omit<RequestDraft, 'parentRequestId' | 'rerunOf'>;
export type RequestApproval = (target: RequestLink, text: string) => Promise<PermissionMode>;
type KeptApproval = (target: RequestLink, text: string) => Promise<{ ceiling: PermissionMode; sourceAccess: PermissionMode }>;

export class BotRequests {
  private readonly options: Readonly<Options>;
  private readonly requests: RequestStateStore;
  private readonly dispatch: BotRequestDispatch;
  private readonly delivery: BotRequestReturn;
  private readonly evidence: RequestThreadEvidence;

  constructor(options: Options) {
    this.options = options;
    const { root, runner, owns, protect, warn } = options;
    this.requests = new RequestStateStore(root, abandoned => {
      if (abandoned && options.protectAbandonment) options.protectAbandonment();
      else protect();
    });
    this.evidence = new RequestThreadEvidence(runner, options.peerOwns);
    this.dispatch = new BotRequestDispatch({
      requests: this.requests,
      receipts: new RequestReceipts(root, owns, protect, warn),
      target: (botId, preferred) => this.recipient(botId, preferred),
      canSteer: link => runner.canSteer(this.current(link.threadId)),
      dispatch: (row, text, actor) => this.sendSaved(row, text, actor),
      isoNow: () => runner.isoNow(),
    });
    this.delivery = new BotRequestReturn({
      requests: this.requests,
      inspectInput: row => this.evidence.input(row, this.requests.children(row.id), this.options.childTasks?.(row.id)),
      inspectReply: (row, id) => {
        if (!row.sourceBotId) return 'sent';
        const proof = this.evidence.reply(row, id);
        return proof === 'missing' && !this.replyAllowed(row) ? 'blocked' : proof;
      },
      deliverReply: (row, id, text) => {
        if (!this.replyAllowed(row)) throw new Error('The original Bot conversation is no longer available for this result.');
        runner.send(row.sourceThreadId, `[Bot result for ${row.id}]\n\n${text}`, [], {
          ceiling: row.returnCeiling ?? 'ask', origin: 'runner', queue: true, messageId: id,
          botSource: { kind: 'thread', threadId: row.targetThreadId }, botRequest: { id: row.id, role: 'result' },
        });
      },
      readResult: source => this.evidence.readResult(source),
      removeQueuedInput: row => this.evidence.removeQueued(row),
      waitingParent: row => this.waitingParent(row),
    });
  }

  private current(threadId: string): ThreadState {
    const { runner } = this.options;
    const state = runner.threads.get(threadId);
    if (!state || state.rec.copied || state.rt.deleted) throw new RpcError(ErrorCode.threadNotFound, 'This Bot conversation is unavailable.');
    return state;
  }

  private link(threadId: string, writable: boolean, allowKept = false) {
    const { repo, runner, peerOwns } = this.options;
    const kept = allowKept && !runner.threads.has(threadId) && peerOwns?.(threadId);
    const rec = kept ? runner.store.load(threadId) : this.current(threadId).rec;
    const link = rec?.botLink;
    if (!link || rec.copied) throw new RpcError(ErrorCode.notAllowed, 'A linked Bot conversation is required.');
    const task = link.taskId ? this.options.task?.(link.taskId) : undefined;
    const matched = task
      ? task.threadId === threadId && task.botId === link.botId && task.id === link.conversationId && (!writable || !('outcome' in task.state))
      : repo.matchesConversation(link.botId, link.conversationId, threadId);
    if (!matched) throw new RpcError(ErrorCode.notAllowed, 'A linked Bot conversation is required.');
    const bot = repo.get(link.botId);
    if (bot.privacy?.moving || (writable && (bot.archivedAt || rec.archivedAt))) throw new RpcError(ErrorCode.notAllowed, 'This Bot conversation cannot receive requests right now.');
    return { ...link, threadId, privateBotId: kept ? rec.privateBotId : runner.privateBotOf(threadId) };
  }

  private recipient(botId: string, preferred?: string): RequestLink {
    const raw = botId.trim();
    const id = this.options.repo.list().find(entry => entry.id === raw || entry.name.toLowerCase() === raw.toLowerCase())?.id;
    if (!id) throw new RpcError(ErrorCode.threadNotFound, 'The recipient Bot is unavailable.');
    const candidates = this.options.repo.conversations(id);
    const stored = preferred ? candidates.find(link => link.id === preferred) : candidates.findLast(link =>
      this.options.runner.threads.has(link.threadId) && !this.options.runner.threads.get(link.threadId)?.rec.archivedAt);
    if (!stored) throw new RpcError(ErrorCode.threadNotFound, 'The recipient Bot has no available conversation. Start one first.');
    return this.link(stored.threadId, true);
  }

  private replyAllowed(row: RequestRow): boolean {
    try {
      if (this.requests.cancelledAncestor(row)) return false;
      const { runner } = this.options;
      const source = this.link(row.sourceThreadId, true);
      const target = this.link(row.targetThreadId, false, true);
      return source.conversationId === row.sourceConversationId && target.conversationId === row.targetConversationId &&
        source.privateBotId === row.sourcePrivateBotId && target.privateBotId === row.targetPrivateBotId &&
        (!target.privateBotId || source.privateBotId === target.privateBotId) &&
        runner.underCeiling(this.current(source.threadId), row.returnCeiling ?? 'ask');
    } catch {
      return false;
    }
  }

  private waitingParent(row: RequestRow): boolean {
    if (!row.parentRequestId || this.requests.cancelledAncestor(row)) return false;
    const parent = this.requests.get(row.parentRequestId);
    const source = this.options.runner.threads.get(row.sourceThreadId);
    if (source && (source.rec.archivedAt || source.rec.copied || source.rt.deleted)) return false;
    return ['admitted', 'queued', 'running'].includes(parent.state.status) &&
      parent.targetThreadId === row.sourceThreadId && parent.targetConversationId === row.sourceConversationId &&
      parent.targetBotId === row.sourceBotId && parent.targetPrivateBotId === row.sourcePrivateBotId;
  }

  private sendSaved(row: RequestRow, text: string, actor: RequestActor) {
    const { runner } = this.options;
    const current = actor.kind === 'bot' && actor.keptTurnId
      ? this.keptSource(row.sourceThreadId, actor.keptTurnId).source
      : this.link(row.sourceThreadId, true);
    if (current.conversationId !== row.sourceConversationId || current.privateBotId !== row.sourcePrivateBotId) {
      throw new RpcError(ErrorCode.notAllowed, 'The source changed while this request was being approved.');
    }
    if (actor.kind === 'bot' && row.sourceBotId &&
        this.options.repo.teamIdForBot(row.sourceBotId) !== this.options.repo.teamIdForBot(row.targetBotId)) {
      throw new RpcError(ErrorCode.notAllowed, 'A Bot can only delegate to its own team.');
    }
    const messageId = `bot-input:${row.id}`;
    const { turnId } = runner.send(row.targetThreadId, text, [], {
      ceiling: row.ceiling ?? 'ask', origin: 'runner', queue: row.when === 'queue', messageId,
      botSource: actor.kind === 'bot' ? { kind: 'thread', threadId: row.sourceThreadId } : { kind: 'owner' },
      botRequest: { id: row.id, role: 'request' },
    });
    return { turnId, when: turnId === messageId ? 'queue' as const : 'now' as const };
  }

  // A request belongs to the current authenticated input on the source
  // turn. Tool arguments can't provide the authority or the parent link.
  currentParent(threadId: string): string | undefined {
    const st = this.current(threadId);
    const turnId = st.rt.turn?.turnId;
    if (!turnId) return undefined;
    const log = this.options.runner.store.log(threadId);
    const input = log.read(1, log.lastSeq).findLast(event => event.type === 'user.message' && event.turnId === turnId);
    return this.parentFrom(threadId, input, st.rec.botLink?.taskId);
  }

  private parentFrom(threadId: string, input: PersistedEvent | undefined, taskId?: string): string | undefined {
    if (input?.type !== 'user.message') return undefined;
    if (!input.botInput?.request) {
      const reference = input.botInput?.task;
      const id = reference?.id ?? taskId;
      if (!id) return undefined;
      const task = this.options.task?.(id);
      if (!task || !task.originRequestId || (reference?.role === 'result' ? task.sourceThreadId !== threadId : task.threadId !== threadId)) return undefined;
      const parent = this.requests.get(task.originRequestId);
      if (parent.state.status === 'cancelled') throw new RpcError(ErrorCode.notAllowed, 'The parent request was cancelled.');
      return parent.id;
    }
    const ref = input.botInput.request;
    const request = this.requests.get(ref.id);
    if (ref.role === 'result') {
      if (request.sourceThreadId !== threadId || request.state.status === 'cancelled') throw new RpcError(ErrorCode.notAllowed, 'This Bot result cannot delegate work.');
      return request.parentRequestId;
    }
    if (request.targetThreadId !== threadId || request.targetConversationId !== input.botInput.conversationId ||
        !['admitted', 'queued', 'running'].includes(request.state.status)) {
      throw new RpcError(ErrorCode.notAllowed, 'This Bot request cannot delegate work.');
    }
    return request.id;
  }

  sendOwner(threadId: string, input: PublicDraft) {
    return this.dispatch.send({ kind: 'owner', source: this.link(threadId, true) }, input, async () => ({ ceiling: 'full', returnCeiling: 'full' }));
  }

  private checkRecipient(source: RequestLink, target: RequestLink): void {
    const { repo } = this.options;
    if ((target.privateBotId && target.privateBotId !== source.privateBotId) ||
        repo.teamIdForBot(target.botId) !== repo.teamIdForBot(source.botId)) {
      throw new RpcError(ErrorCode.threadNotFound, 'The recipient Bot is unavailable.');
    }
  }

  sendBot(threadId: string, input: PublicDraft, authorize: RequestApproval) {
    const source = this.link(threadId, true);
    const { runner } = this.options;
    const before = runner.accessOf(threadId);
    const authorizer: AuthorizeRequest = async (_actor, target, text) => {
      this.checkRecipient(source, target);
      const ceiling = await authorize(target, text);
      return { ceiling, returnCeiling: ceilingMode(lowerMode(lowerMode(before, runner.accessOf(threadId)), runner.accessOf(target.threadId))) };
    };
    return this.dispatch.send({ kind: 'bot', source }, { ...input, parentRequestId: this.currentParent(threadId) }, authorizer);
  }

  private keptSource(threadId: string, turnId: string) {
    const { runner, peerOwns } = this.options;
    const moved = () => new RpcError(ErrorCode.moved, 'The Bot no longer has that active turn on a draining Runner.');
    if (!peerOwns?.(threadId) || runner.threads.has(threadId)) throw moved();
    const source = this.link(threadId, true, true);
    if (source.groupId) throw new RpcError(ErrorCode.notAllowed, 'Group turns delegate within their Group.');
    const input = activeBotInput(runner.store.peerLog(threadId), turnId);
    return { source, input };
  }

  async sendKeptBot(threadId: string, turnId: string, input: PublicDraft, authorize: KeptApproval) {
    const { source, input: savedInput } = this.keptSource(threadId, turnId);
    const parentRequestId = this.parentFrom(threadId, savedInput, source.taskId);
    return this.dispatch.send({ kind: 'bot', source, keptTurnId: turnId }, { ...input, parentRequestId }, async (_actor, target, text) => {
      this.checkRecipient(source, target);
      const { ceiling, sourceAccess } = await authorize(target, text);
      this.keptSource(threadId, turnId);
      return { ceiling, returnCeiling: ceilingMode(lowerMode(sourceAccess, this.options.runner.accessOf(target.threadId))) };
    });
  }

  queue(threadId: string, ref: Correlation): 'allow' | 'wait' | 'drop' {
    if (!this.options.owns()) return 'wait';
    let row: RequestRow;
    try { row = this.requests.get(ref.id); } catch { return 'wait'; }
    if (this.requests.cancelledAncestor(row)) return 'drop';
    if (ref.role === 'result') {
      const returning = row.state.status === 'abandoned'
        ? row.state.notice !== 'suppressed' && this.waitingParent(row)
        : ['returning', 'returned'].includes(row.state.status);
      return row.sourceThreadId === threadId && returning && this.replyAllowed(row) ? 'allow' : 'drop';
    }
    if (row.targetThreadId !== threadId || !['admitted', 'queued', 'running'].includes(row.state.status)) return 'drop';
    try {
      const link = this.link(threadId, true);
      return link.conversationId === row.targetConversationId && link.privateBotId === row.targetPrivateBotId ? 'allow' : 'drop';
    } catch {
      return 'drop';
    }
  }

  recover(threadId?: string): void {
    const { runner, owns, warn } = this.options;
    if (!owns()) return;
    for (const row of this.requests.list().reverse()) {
      if (threadId && row.targetThreadId !== threadId && row.sourceThreadId !== threadId) continue;
      try {
        if (this.requests.cancelledAncestor(row) && !['returned', 'failed', 'cancelled', 'abandoned'].includes(row.state.status)) {
          this.cancelRequest(row, row.revision);
        } else {
          this.delivery.settle(row.id, true);
        }
      } catch { warn(); }
    }
    for (const st of runner.threads.values()) {
      if (threadId && st.rec.id !== threadId) continue;
      if (st.rec.queue.some(item => item.botInput?.request)) runner.kickQueue(st);
    }
  }

  private openFrom(threadId: string): RequestRow[] {
    return this.requests.list().filter(row => row.sourceThreadId === threadId &&
      !['returned', 'failed', 'cancelled', 'abandoned'].includes(row.state.status));
  }

  pendingFrom(threadId: string): boolean {
    return this.openFrom(threadId).length > 0;
  }

  cancelFrom(threadId: string): void {
    for (const row of this.openFrom(threadId)) {
      try { this.cancelRequest(row, row.revision); }
      catch { this.options.warn(); }
    }
  }

  cancelled(id: string): boolean {
    const row = this.requests.get(id);
    return row.state.status === 'cancelled' || this.requests.cancelledAncestor(row);
  }

  ownerGet(threadId: string, id: string) {
    this.link(threadId, false);
    const row = this.requests.get(id);
    if (row.sourceThreadId !== threadId) throw new RpcError(ErrorCode.notAllowed, 'The request belongs to another conversation.');
    return row;
  }

  ownerList(threadId: string) {
    this.link(threadId, false);
    return this.requests.list().filter(row => row.sourceThreadId === threadId);
  }

  ownerRead(threadId: string, id: string) {
    const row = this.ownerGet(threadId, id);
    const state = row.state;
    const saved = state.status === 'abandoned' ? state.late?.result
      : state.status === 'uncertain' ? state.reply?.result : 'result' in state ? state.result : undefined;
    const result = saved ? resultText(saved, source => this.evidence.readResult(source)) : undefined;
    return { row, result };
  }

  ownerAbandon(threadId: string, id: string, revision: number) {
    const row = this.ownerGet(threadId, id);
    if (row.revision !== revision) throw new Error('This Bot request changed');
    this.link(threadId, true);
    if (!this.waitingParent(row)) throw new RpcError(ErrorCode.notAllowed, 'This Bot request has no waiting parent in this conversation.');
    const target = this.options.repo.get(row.targetBotId).name;
    // DS-Bot, src/host/handoffs.js abandonWork: the exact user-abandon notice.
    const text = 'No reply came back from ' + target + ', and the user gave up waiting for it. This is its result: go on with the work you were given.';
    return this.delivery.abandon(row, revision, text);
  }

  ownerCancel(threadId: string, id: string, revision: number) {
    return this.cancelRequest(this.ownerGet(threadId, id), revision);
  }

  private cancelRequest(row: RequestRow, revision: number): RequestRow {
    try { return this.delivery.cancel(row.id, revision); }
    finally {
      if (this.requests.get(row.id).state.status === 'cancelled') this.options.onCancel?.(row);
    }
  }

  ownerRetry(threadId: string, id: string, revision: number) {
    const row = this.ownerGet(threadId, id);
    if (row.revision !== revision) throw new Error('This Bot request changed');
    return this.delivery.settle(id, true);
  }

  ownerRerun(threadId: string, id: string, revision: number, text: string, operationId: string) {
    const previous = this.ownerGet(threadId, id);
    const source = this.link(threadId, true);
    return this.dispatch.send({ kind: 'owner', source }, {
      to: previous.targetBotId, conversationId: previous.targetConversationId,
      name: `rerun:${id}:${operationId}`, text, when: 'queue', rerunOf: id,
    }, async () => {
      if (previous.revision !== revision) throw new RpcError(ErrorCode.badParams, 'This Bot request changed.');
      const state = previous.state;
      if (!['failed', 'cancelled', 'uncertain'].includes(state.status) && !(state.status === 'returned' && state.failed)) {
        throw new RpcError(ErrorCode.notAllowed, 'Only failed, cancelled or unconfirmed requests can be run again.');
      }
      return { ceiling: 'full', returnCeiling: 'full' };
    });
  }
}
