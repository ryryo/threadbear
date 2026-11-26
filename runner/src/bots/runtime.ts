import { join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import type { Clock } from '../clock.ts';
import { ErrorCode, RpcError, type PermissionMode } from '../protocol.ts';
import { lowerMode, raises } from '../access.ts';
import { PermissionChanges } from './permission-changes.ts';
import type { Runner } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import { BotConversations } from './conversations.ts';
import { BOT_REQUEST_FORMAT, BOT_TASK_FORMAT, BOT_TEAM_FORMAT, hasPrivateBotData, PRIVATE_BOT_FORMAT, protectBotData, supervisorGuardsBotData } from './format.ts';
import { ReviewQueue } from './memory-review.ts';
import { foldersOverlap } from './privacy-folders.ts';
import { BotRepository } from './repository.ts';
import { BotReviews, type BotReviewOptions } from './reviews.ts';
import { botMethods, botRequestMethods } from './rpc.ts';
import { BotRequests } from './request-service.ts';
import { atomicWriteFileSync } from '../fsutil.ts';
import { BotTeams } from './teams.ts';
import { teamMethods } from './team-rpc.ts';
import { TaskJournal } from './task-journal.ts';
import { BotTaskThreads } from './task-threads.ts';
import { botTaskMethods } from './task-rpc.ts';
import type { BotInputRef } from '../protocol.ts';

export const BOT_EXPERIMENT = 'nativeBots';

type Options = {
  home: string;
  runner: () => Runner;
  owner: () => string;
  enabled: () => boolean;
  guarded: () => boolean;
  owns: () => boolean;
  canChangePrivacy?: () => boolean;
  protectPrivacy?: () => void;
  withdrawShared?: (threadIds: readonly string[]) => Promise<void>;
  archiveExporting?: () => boolean;
};
type ReviewDeps = Pick<BotReviewOptions, 'redact' | 'askers' | 'privateFolder'> & { clock: Clock; onError: (id: string) => void };

export class BotRuntime {
  private readonly options: Options;
  private repository?: BotRepository;
  private privateData?: boolean;
  private readonly privacyChange = new Map<string, Promise<unknown>>();
  private workspace?: { repo: BotRepository; conversations: BotConversations };
  private reviewService?: BotReviews;
  private requestService?: BotRequests;
  private taskService?: BotTaskThreads;
  private teamService?: BotTeams;
  private permissionChanges?: PermissionChanges;
  private readonly taskWake = new Set<string>();
  private requestListener?: () => void;
  private readonly requestWake = new Set<string>();
  private reviewQueue?: ReviewQueue;
  private reviewDeps?: ReviewDeps;
  private stopListening?: () => void;

  readonly methods = Object.assign(botMethods(() => this.getWorkspace(), () => this.reviews(), p => this.makePrivate(p), () => this.protectNewFormat(), () => this.requestsAvailable()), botRequestMethods(() => this.requests()), botTaskMethods(() => this.tasks()),
    teamMethods(() => ({
      repo: this.getWorkspace().repo, teams: this.teams(), now: () => this.options.runner().isoNow(),
      protect: () => this.protectTeamData(), setCeiling: (bot, rev, cap) => this.setBotCeiling(bot, rev, cap),
    })), {
    'bots.status': (_params: Record<string, unknown>) => {
      const reason = this.unavailable();
      return { enabled: this.options.enabled() && this.options.owns(), available: reason === undefined, requests: this.requestsAvailable(), tasks: this.tasksAvailable(), teams: this.teamsAvailable(), reason };
    },
  });

  constructor(options: Options) {
    this.options = options;
  }

  requestsAvailable(): boolean {
    return this.unavailable() === undefined && supervisorGuardsBotData(this.options.home, BOT_REQUEST_FORMAT);
  }

  requests(): BotRequests {
    if (!this.requestsAvailable()) throw new RpcError(ErrorCode.notAllowed, 'Bot requests need an updated Runner supervisor.');
    const { home, runner, owns } = this.options;
    return this.requestService ??= new BotRequests({
      root: join(home, 'bots'), runner: runner(), repo: this.getWorkspace().repo, owns,
      task: id => this.tasksAvailable() ? this.tasks().get(id) : undefined,
      childTasks: id => this.tasksAvailable() ? this.tasks().children(id) : [],
      onCancel: row => {
        this.reconcileTasks(row.targetThreadId);
        this.reconcileTasks(row.sourceThreadId);
      },
      protect: () => {
        if (!owns() || !this.options.canChangePrivacy?.()) throw new RpcError(ErrorCode.busy, 'Wait for the Runner to finish handing over.');
        protectBotData(home, BOT_REQUEST_FORMAT);
      },
      warn: () => runner().notice('error', 'A Bot request could not be reconciled.'),
    });
  }

  permissionCeiling(rec: ThreadRecord): PermissionMode | undefined {
    if (!rec.botLink || rec.copied) return undefined;
    return this.repo().get(rec.botLink.botId).permissionCeiling;
  }

  private async setBotCeiling(botId: string, revision: number, ceiling: PermissionMode) {
    if (!this.teamsAvailable() || !this.options.canChangePrivacy?.()) throw new RpcError(ErrorCode.notAllowed, 'Bot permission limits need the updated Runner supervisor to finish handing over.');
    const runner = this.options.runner();
    const { repo } = this.getWorkspace();
    const threads = (id: string) => [...runner.threads.values()]
      .filter(st => st.rec.botLink?.botId === id && !st.rec.copied && !st.rt.deleted)
      .map(st => st.rec.id);
    this.permissionChanges ??= new PermissionChanges({
      read: id => {
        const current = repo.get(id);
        return { revision: current.revision, ceiling: current.permissionCeiling ?? 'full' };
      },
      threads,
      apply: async (threadId, wanted) => {
        const mode = wanted();
        if (mode !== undefined) this.narrowBotThread(threadId, mode);
      },
      snapshot: id => {
        const st = runner.threads.get(id);
        if (!st) return undefined;
        const { permissionMode, modeBeforePlan } = st.rec;
        return () => {
          if (st.rt.deleted) return;
          runner.update({ threadId: id, permissionMode });
          st.rec.modeBeforePlan = modeBeforePlan;
          runner.store.save(st.rec);
        };
      },
      commit: (id, expected, mode) => {
        for (const thread of threads(id)) this.narrowBotThread(thread, mode);
        this.protectTeamData();
        repo.setPermissionCeiling(id, expected, mode);
      },
      warn: () => runner.notice('warning', 'The Runner could not restore a Bot conversation’s previous permission.'),
    });
    await this.permissionChanges.set(botId, revision, ceiling);
    return { bot: repo.get(botId) };
  }

  private narrowBotThread(threadId: string, cap: PermissionMode): void {
    const runner = this.options.runner();
    const st = runner.threads.get(threadId);
    if (!st || st.rt.deleted) return;
    if (raises(st.rec.permissionMode, cap)) {
      runner.update({ threadId, permissionMode: cap });
      try { runner.interrupt(threadId, { byMike: true }); }
      finally { st.rt.session?.kill(); }
    }
    if (st.rec.modeBeforePlan !== undefined) st.rec.modeBeforePlan = lowerMode(st.rec.modeBeforePlan, cap);
    runner.store.save(st.rec);
  }

  teamsAvailable(): boolean {
    return this.unavailable() === undefined && supervisorGuardsBotData(this.options.home, BOT_TEAM_FORMAT);
  }

  private protectTeamData(): void {
    if (!this.teamsAvailable() || !this.options.canChangePrivacy?.()) {
      throw new RpcError(ErrorCode.busy, 'Team changes need the updated Runner supervisor to finish handing over.');
    }
    protectBotData(this.options.home, BOT_TEAM_FORMAT);
  }

  teams(): BotTeams {
    if (!this.teamsAvailable()) throw new RpcError(ErrorCode.notAllowed, 'Bot teams need an updated Runner supervisor.');
    const runner = this.options.runner();
    return this.teamService ??= new BotTeams({
      repo: this.getWorkspace().repo, runner, protect: () => this.protectTeamData(),
      redact: text => this.reviewDeps?.redact(text) ?? 'Team management request',
      tasks: async id => {
        const tasks = this.tasks();
        const result = await tasks.cancel(id, tasks.get(id).revision);
        if (!result.saved) throw new Error('The task stopped but the Runner could not save that stop.');
      },
    });
  }

  tasksAvailable(): boolean {
    return this.unavailable() === undefined && supervisorGuardsBotData(this.options.home, BOT_TASK_FORMAT);
  }

  tasks(): BotTaskThreads {
    if (!this.tasksAvailable()) throw new RpcError(ErrorCode.notAllowed, 'Background Bot tasks need an updated Runner supervisor.');
    const { home, runner, owns } = this.options;
    return this.taskService ??= new BotTaskThreads({
      runner: runner(), repo: this.getWorkspace().repo, owns,
      parent: id => this.requestsAvailable() ? this.requests().currentParent(id) : undefined,
      childRequests: id => this.requestsAvailable() && this.requests().pendingFrom(id),
      cancelChildRequests: id => { if (this.requestsAvailable()) this.requests().cancelFrom(id); },
      parentCancelled: id => this.requestsAvailable() && this.requests().cancelled(id),
      journal: new TaskJournal(join(home, 'bots'), atomicWriteFileSync, () => {
        if (!owns() || !this.options.canChangePrivacy?.()) throw new RpcError(ErrorCode.busy, 'Wait for the Runner to finish handing over.');
        protectBotData(home, BOT_TASK_FORMAT);
      }),
    });
  }

  taskQueue(threadId: string, ref: NonNullable<BotInputRef['task']>): 'allow' | 'wait' | 'drop' {
    return this.tasksAvailable() ? this.tasks().queue(threadId, ref) : 'wait';
  }

  reconcileTasks(threadId?: string): void {
    if (!this.tasksAvailable()) return;
    const key = threadId ?? '';
    if (this.taskWake.has(key)) return;
    this.taskWake.add(key);
    setImmediate(() => {
      if (!this.taskWake.delete(key) || !this.tasksAvailable()) return;
      try { this.tasks().recover(threadId); }
      catch { this.options.runner().notice('warning', 'The Bot task journal could not be reopened.'); }
    });
  }

  requestQueue(threadId: string, ref: NonNullable<BotInputRef['request']>): 'allow' | 'wait' | 'drop' {
    return this.requestsAvailable() ? this.requests().queue(threadId, ref) : 'wait';
  }

  startRequests(): void {
    if (this.requestListener) return;
    const runner = this.options.runner();
    this.requestListener = runner.onNotification(note => {
      if (note.method === 'thread.updated' && note.params.thread.botLink?.taskId) {
        this.reconcileTasks(note.params.thread.id);
        return;
      }
      if (note.method !== 'thread.event') return;
      const { threadId, event } = note.params;
      if (!runner.threads.get(threadId)?.rec.botLink) return;
      if (event.type === 'turn.completed' || (event.type === 'user.message' && (event.botInput?.request || event.botInput?.task))) this.reconcileRequests(threadId);
      if (event.type === 'turn.completed' || (event.type === 'user.message' && event.botInput?.task)) this.reconcileTasks(threadId);
    });
    this.reconcileRequests();
    this.reconcileTasks();
  }

  reconcileRequests(threadId?: string): void {
    if (!this.requestsAvailable()) return;
    const key = threadId ?? '';
    if (this.requestWake.has(key)) return;
    this.requestWake.add(key);
    setImmediate(() => {
      if (!this.requestWake.delete(key) || !this.requestsAvailable()) return;
      try { this.requests().recover(threadId); }
      catch { this.options.runner().notice('error', 'The Bot request journal could not be reopened.'); }
    });
  }

  stopRequests(): void {
    this.requestListener?.();
    this.requestListener = undefined;
    this.requestWake.clear();
    this.taskWake.clear();
  }

  startReviews(deps: ReviewDeps): void {
    if (this.reviewQueue) return;
    this.reviewDeps = deps;
    const runner = this.options.runner();
    const queue = new ReviewQueue(deps.clock, async id => {
      if (!this.unavailable()) await this.reviews().review(id);
    }, deps.onError);
    this.reviewQueue = queue;
    this.stopListening = runner.onNotification(note => {
      if (note.method === 'thread.updated') {
        const { id, status, botLink } = note.params.thread;
        if (botLink && !botLink.taskId && !this.unavailable()) queue.status(id, status === 'idle');
      } else if (note.method === 'thread.deleted') {
        queue.status(note.params.threadId, false);
      }
    });
    if (!this.unavailable()) {
      for (const { rec } of runner.threads.values()) {
        if (rec.botLink && !rec.botLink.taskId && !rec.copied && rec.status === 'idle') queue.status(rec.id, true);
      }
    }
  }

  stopReviews(): void {
    this.stopListening?.();
    this.reviewQueue?.stop();
    this.reviewQueue = undefined;
    this.reviewDeps = undefined;
    this.reviewService = undefined;
    this.stopListening = undefined;
  }

  private reviews(): BotReviews {
    const { repo } = this.getWorkspace();
    const deps = this.reviewDeps;
    if (!deps) throw new RpcError(ErrorCode.notAllowed, 'Bot memory review is unavailable.');
    return this.reviewService ??= new BotReviews({
      ...deps, root: join(this.options.home, 'bots'), repo, runner: this.options.runner(),
      enabled: () => this.reviewDeps === deps && this.unavailable() === undefined,
      protectTidy: () => this.protectNewFormat(),
    });
  }

  private unavailable(): string | undefined {
    const { enabled, guarded, owns } = this.options;
    if (!owns()) return 'Bot controls are available on the owning Runner.';
    if (!enabled()) return 'The Bots experiment is turned off.';
    if (!guarded()) return 'Bots need the updated Runner supervisor to be running.';
    return undefined;
  }

  private getWorkspace() {
    const reason = this.unavailable();
    if (reason) throw new RpcError(ErrorCode.notAllowed, reason);
    if (!this.workspace) {
      const { home, runner } = this.options;
      const root = join(home, 'bots');
      const repo = this.repo();
      this.workspace = { repo, conversations: new BotConversations(runner(), repo, root, text => this.reviewDeps?.redact(text) ?? text) };
    }
    return this.workspace;
  }

  private repo(): BotRepository {
    const { home, owner } = this.options;
    return this.repository ??= new BotRepository(join(home, 'bots'), owner(), () => protectBotData(home));
  }

  private protectNewFormat(): void {
    if (!this.options.canChangePrivacy?.()) throw new RpcError(ErrorCode.busy, 'Wait for the old Runner to finish handing over.');
    const protect = this.options.protectPrivacy ?? (() => protectBotData(this.options.home, PRIVATE_BOT_FORMAT));
    protect();
    this.privateData = true;
  }

  private makePrivate({ botId, expectedRevision, folder, operationId }: { botId: string; expectedRevision: number; folder: string; operationId: string }) {
    const { repo } = this.getWorkspace();
    const runner = this.options.runner();
    const canonical = realpathSync.native(folder);
    const moving = new Set(repo.conversations(botId).map(link => link.threadId));
    const all = [...runner.threads.values()];
    for (let size = -1; size !== moving.size;) {
      size = moving.size;
      for (const { rec } of all) if (rec.startedBy?.threadId && moving.has(rec.startedBy.threadId)) moving.add(rec.id);
    }
    const changed = repo.setPrivate(botId, expectedRevision, canonical, operationId, [...moving], () => {
      if (this.options.archiveExporting?.()) throw new Error('Turn off Agent Archive before making a Bot private. It reads the CLI’s own transcripts.');
      if (!this.options.canChangePrivacy?.()) throw new RpcError(ErrorCode.busy, 'Wait for the old Runner to finish handing over before making a Bot private.');
      if (!statSync(canonical).isDirectory()) throw new Error('Choose an existing work folder for this Bot');
      const otherFolders = repo.list().flatMap(bot => bot.id !== botId && bot.privacy ? bot.privacy.folder : []);
      if (moving.size && !this.options.withdrawShared) throw new Error('This Runner cannot yet withdraw previously shared conversations.');
      const affected = all.filter(({ rec }) => moving.has(rec.id));
      if ((this.tasksAvailable() && this.tasks().hasActive(botId)) ||
          affected.some(({ rec, rt }) => rt.session || rt.turn || rt.tasks.length || rec.queue.length)) {
        throw new Error('Stop the Bot’s conversations and background work before making it private.');
      }
      const threadFolders = all.filter(({ rec }) => !moving.has(rec.id)).map(({ rec }) => rec.cwd);
      if ([runner.cfg.defaults.cwd, ...threadFolders, ...otherFolders].some(path => foldersOverlap(canonical, path))) {
        throw new Error('Choose a dedicated Bot folder outside the Runner default and any existing work folders');
      }
      this.protectNewFormat();
    });
    if (!changed.privacy?.moving) return changed;
    const active = this.privacyChange.get(botId);
    if (active) return active;
    const completion = this.finishPrivacy(botId, changed.privacy).finally(() => this.privacyChange.delete(botId));
    this.privacyChange.set(botId, completion);
    return completion;
  }

  private async finishPrivacy(botId: string, privacy: { folder: string; operationId: string; moving?: string[] }) {
    const { runner: running, withdrawShared, owns } = this.options;
    if (!withdrawShared || !privacy.moving || !owns() || !this.options.canChangePrivacy?.()) throw new Error('This Runner cannot finish moving the Bot’s conversations now.');
    const runner = running();
    for (const threadId of privacy.moving) {
      const st = runner.threads.get(threadId);
      if (!st || st.rt.deleted) continue;
      if (st.rt.session || st.rt.turn || st.rt.tasks.length || st.rec.queue.length) throw new Error('A Bot conversation is still running.');
      st.rec.privateBotId = botId;
      delete st.rec.share;
      runner.update({ threadId, cwd: privacy.folder, settingBotPrivacy: true });
      runner.store.save(st.rec);
      runner.markDirty(st);
    }
    await withdrawShared(privacy.moving);
    if (!owns()) throw new Error('This Runner handed over before the private conversion finished.');
    return this.repo().confirmPrivate(botId, privacy.operationId);
  }

  pendingPrivateThread(threadId: string): string | undefined {
    this.privateData ??= hasPrivateBotData(this.options.home);
    return this.privateData ? this.repo().movingPrivateBot(threadId) : undefined;
  }

  hasPrivateBots(): boolean {
    this.privateData ??= hasPrivateBotData(this.options.home);
    return this.privateData && this.repo().list().some(bot => bot.privacy !== undefined);
  }

  folderRefusal(cwd: string, privateBotId?: string): string | undefined {
    if (!privateBotId && !this.repository && !hasPrivateBotData(this.options.home)) return undefined;
    const entries = this.repo().list();
    if (privateBotId !== undefined) {
      if (!this.options.enabled()) return 'The Bots experiment is turned off.';
      if (this.options.archiveExporting?.()) return 'Private Bot conversations cannot run while Agent Archive is reading CLI transcripts.';
      const privacy = entries.find(bot => bot.id === privateBotId)?.privacy;
      if (privacy?.moving) return 'Finish moving this Bot to its private folder first.';
      const root = privacy?.folder;
      if (!root || cwd !== root || realpathSync.native(cwd) !== root) return 'This private Bot uses its dedicated work folder.';
      return undefined;
    }
    if (entries.some(bot => bot.privacy && foldersOverlap(cwd, bot.privacy.folder))) return 'This folder overlaps a private Bot’s work folder.';
    return undefined;
  }

  context(rec: ThreadRecord): string {
    if (rec.copied) throw new RpcError(ErrorCode.notAllowed, 'A copy of a Bot conversation stays read-only.');
    const task = rec.botLink?.taskId ? this.tasks().active(rec) : undefined;
    return this.getWorkspace().conversations.context(rec, task);
  }
}
