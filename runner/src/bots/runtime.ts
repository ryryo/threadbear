import { join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import type { Clock } from '../clock.ts';
import { ErrorCode, RpcError, type PermissionMode } from '../protocol.ts';
import { lowerMode, raises } from '../access.ts';
import { PermissionChanges } from './permission-changes.ts';
import type { Runner } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import { BotConversations } from './conversations.ts';
import { BOT_ABANDON_FORMAT, BOT_DEVICE_FORMAT, BOT_ERASE_FORMAT, BOT_GROUP_FORMAT, BOT_REQUEST_FORMAT, BOT_SCHEDULE_FORMAT, BOT_TASK_FORMAT, BOT_TEAM_FORMAT, BOT_TRANSFER_FORMAT, hasPrivateBotData, PRIVATE_BOT_FORMAT, protectBotData, supervisorGuardsBotData } from './format.ts';
import { ReviewQueue } from './memory-review.ts';
import { foldersOverlap } from './privacy-folders.ts';
import { BotRepository, type BotWorkspaceIdentity } from './repository.ts';
import { BotReviews, type BotReviewOptions } from './reviews.ts';
import { ReviewCheckpoints } from './review-checkpoints.ts';
import { botMethods, botRequestMethods, method } from './rpc.ts';
import { closeProfilePanelInput, openProfilePanelInput, ProfilePanelServer } from './profile-panel.ts';
import { BotRequests } from './request-service.ts';
import { atomicWriteFileSync } from '../fsutil.ts';
import { BotTeams } from './teams.ts';
import { teamMethods } from './team-rpc.ts';
import { TaskJournal } from './task-journal.ts';
import { BotTaskThreads } from './task-threads.ts';
import { botTaskMethods } from './task-rpc.ts';
import type { BotInputRef } from '../protocol.ts';
import { GroupStore } from './group-store.ts';
import { BotGroups } from './groups.ts';
import { groupMethods } from './group-rpc.ts';
import { DeviceBotWorkspace, type BotNoteErasure, type BotNoteErasureReply } from './device-workspace.ts';
import { BotNoteErasureQueue, type NoteErasureIntent } from './memory-erasure-queue.ts';
import { deviceAction } from './device-actions.ts';
import type { BotScheduleScope } from './schedule-rpc.ts';
import { BotScheduleTargets } from './schedule-target.ts';
import type { RememberInput } from './memory-tool.ts';
import { activeBotInput } from './turn-proof.ts';

import { BotWorkspaceTransfer } from './workspace-transfer.ts';
import { listManagedMemoryBackups, openManagedMemoryBackup, scopedBackupNotes, selectBackupMemoryNote, type BackupMemoryPreviewInput, type BackupMemoryRestoreInput } from './managed-memory-restore.ts';
import type { PersonalMemory } from './ported/personal-memory.js';
import type { PackEntry } from '../move-pack.ts';

export const BOT_EXPERIMENT = 'nativeBots';

type BackupPreflight<T> = (files: readonly PackEntry[], identity: BotWorkspaceIdentity, apply: () => T) => Promise<T>;
type BackupPreview = { checksum: string; revision: string; notes: { id: string; text: string }[] };

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
  withdrawDeviceProfile?: (botId: string) => Promise<() => void>;
  eraseNoteFromMirror?: (input: BotNoteErasure) => Promise<BotNoteErasureReply>;
  archiveExporting?: () => boolean;
  peerOwns?: (threadId: string) => boolean;
  threadUnavailableForAttachment?: (threadId: string) => boolean;
};
type ReviewDeps = Pick<BotReviewOptions, 'redact' | 'askers' | 'privateFolder'> & { clock: Clock; onError: (id: string) => void };

export class BotRuntime {
  private readonly options: Options;
  private repository?: BotRepository;
  private transferService?: BotWorkspaceTransfer;
  private privateData?: boolean;
  private readonly privacyChange = new Map<string, Promise<unknown>>();
  private workspace?: { repo: BotRepository; conversations: BotConversations };
  private reviewService?: BotReviews;
  private requestService?: BotRequests;
  private taskService?: BotTaskThreads;
  private teamService?: BotTeams;
  private groupService?: BotGroups;
  private scheduleTargets?: BotScheduleTargets;
  private deviceWorkspace?: DeviceBotWorkspace;
  private noteErasureQueue?: BotNoteErasureQueue;
  private profilePanel?: ProfilePanelServer;
  private groupWake = false;
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
    })), groupMethods(() => this.groups(), (groupId, seq, operationId, text) => this.approveGroupNote(groupId, seq, operationId, text)), {
    'bots.status': (_params: Record<string, unknown>) => this.status(),
  });

  constructor(options: Options) {
    this.options = options;
  }

  status() {
    const reason = this.unavailable();
    return { enabled: this.options.enabled() && this.options.owns(), available: reason === undefined,
      requests: this.requestsAvailable(), requestAbandonment: this.requestAbandonmentAvailable(), tasks: this.tasksAvailable(), teams: this.teamsAvailable(),
      groups: this.groupsAvailable(), schedules: this.botSchedulesAvailable(), profilePanel: reason === undefined, reason };
  }

  profilePanelControl() {
    return {
      open: (params: Record<string, unknown>, connected: () => boolean) => {
        const input = openProfilePanelInput.safeParse(params);
        if (!input.success) throw new RpcError(ErrorCode.badParams, 'Choose the Bot whose profile to open.');
        this.profilePanel ??= new ProfilePanelServer({
          read: id => {
            const bot = this.getWorkspace().repo.get(id);
            return bot.archivedAt ? undefined : bot;
          },
          update: (id, revision, changes) => this.getWorkspace().repo.update(id, revision, changes),
        });
        return this.profilePanel.open(input.data.botId, connected);
      },
      close: method(closeProfilePanelInput, ({ id }) => { this.profilePanel?.close(id); return {}; }),
    };
  }

  requestsAvailable(): boolean {
    return this.unavailable() === undefined && supervisorGuardsBotData(this.options.home, BOT_REQUEST_FORMAT);
  }

  private requestAbandonmentAvailable(): boolean {
    const { home, canChangePrivacy } = this.options;
    return this.requestsAvailable() && canChangePrivacy?.() === true && supervisorGuardsBotData(home, BOT_ABANDON_FORMAT);
  }

  rememberFromTurn(threadId: string, turnId: string, input: RememberInput, kept = false) {
    const { repo, conversations } = this.getWorkspace();
    const runner = this.options.runner();
    const state = runner.threads.get(threadId);
    const current = kept
      ? !state && this.options.peerOwns?.(threadId)
      : state && !state.rt.deleted && state.rt.turn?.turnId === turnId;
    if (!current) throw new RpcError(ErrorCode.moved, 'The Bot no longer has that active turn.');
    const rec = kept ? runner.store.load(threadId) : state?.rec;
    const link = rec?.botLink;
    if (!rec || rec.copied || rec.archivedAt || !link || link.taskId) throw new RpcError(ErrorCode.notAllowed, 'A linked Bot or Group conversation is required.');
    const source = activeBotInput(kept ? runner.store.peerLog(threadId) : runner.store.log(threadId), turnId);
    const bot = repo.get(link.botId);
    if (bot.archivedAt || bot.privacy?.moving || rec.privateBotId !== (bot.privacy ? bot.id : undefined)) {
      throw new RpcError(ErrorCode.notAllowed, 'This Bot cannot save notes now.');
    }
    if (link.groupId) {
      const { round, frozen } = this.groups().threads.check(rec);
      if (frozen || round?.status !== 'running' || !round.slots.some(slot =>
        slot.status === 'speaking' && slot.threadId === threadId && slot.turnId === turnId)) {
        throw new RpcError(ErrorCode.notAllowed, 'Only a speaking member can save Group notes.');
      }
    } else if (!repo.matchesConversation(bot.id, link.conversationId, threadId)) {
      throw new RpcError(ErrorCode.notAllowed, 'This Thread does not belong to this Bot.');
    }
    const scope = link.groupId ? { kind: 'group' as const, id: link.groupId } : { kind: 'bot' as const, id: bot.id };
    const memory = conversations.scopedMemory.open(scope, {
      kind: 'bot', id: bot.id, private: Boolean(bot.privacy), groupId: link.groupId, teamId: repo.teamIdForBot(bot.id), grants: [],
    }, 'write');
    protectBotData(this.options.home);
    return memory.change({ op: 'add', text: input.text, until: input.until }, `bot:${threadId}:${input.operationId}`, memory.revision(), runner.isoNow(), {
      actor: bot.id, sourceThreadId: threadId, sourceTurnId: turnId, sourceSeq: source.seq, pin: input.pin,
    });
  }

  requests(): BotRequests {
    if (!this.requestsAvailable()) throw new RpcError(ErrorCode.notAllowed, 'Bot requests need an updated Runner supervisor.');
    const { home, runner, owns } = this.options;
    return this.requestService ??= new BotRequests({
      root: join(home, 'bots'), runner: runner(), repo: this.getWorkspace().repo, owns, peerOwns: this.options.peerOwns,
      task: id => this.tasksAvailable() ? this.tasks().get(id) : undefined,
      childTasks: id => this.tasksAvailable() ? this.tasks().children(id) : [],
      onCancel: row => {
        this.reconcileTasks(row.targetThreadId);
        this.reconcileTasks(row.sourceThreadId);
      },
      protect: () => {
        // Only the primary changes the journal. A peer can still own an
        // execution Thread while this primary settles its saved result.
        if (!owns()) throw new RpcError(ErrorCode.busy, 'Wait for the Runner to finish handing over.');
        protectBotData(home, BOT_REQUEST_FORMAT);
      },
      protectAbandonment: () => {
        if (!this.requestAbandonmentAvailable()) throw new RpcError(ErrorCode.busy, 'Wait for the updated Runner supervisor to finish handing over.');
        protectBotData(home, BOT_ABANDON_FORMAT);
      },
      warn: () => runner().notice('error', 'A Bot request could not be reconciled.'),
    });
  }

  permissionCeiling(rec: ThreadRecord): PermissionMode | undefined {
    if (!rec.botLink || rec.copied) return undefined;
    if (this.blocksWorkspaceThread(rec)) throw new RpcError(ErrorCode.busy, 'The Bot workspace is frozen for a move.');
    const limit = this.repo().get(rec.botLink.botId).permissionCeiling;
    if (rec.botLink.groupId) return lowerMode(limit ?? 'full', this.groups().threads.check(rec).group.ceiling);
    if (rec.botLink.taskId && this.tasksAvailable()) {
      const task = this.tasks().check(rec);
      if (task.group) {
        if (!this.groupsAvailable() || !this.groups().taskActive(task)) return 'plan';
        return lowerMode(limit ?? 'full', this.groups().store.get(task.group.groupId).group.ceiling);
      }
    }
    return limit;
  }

  blocksWorkspaceThread(rec: ThreadRecord): boolean {
    return Boolean(rec.botLink && !rec.copied && !rec.botWorker && this.workspaceIsMoving());
  }

  workspaceIsMoving(): boolean {
    return this.transfer().blocked();
  }

  workspaceMovesAvailable(): boolean {
    const { home, owns, enabled, canChangePrivacy } = this.options;
    return owns() && enabled() && !!canChangePrivacy?.() && supervisorGuardsBotData(home, BOT_TRANSFER_FORMAT);
  }

  workspaceMoveStore(): BotWorkspaceTransfer {
    if (!this.workspaceMovesAvailable()) throw new RpcError(ErrorCode.notAllowed, 'Bot workspace moves need the primary Runner and its updated supervisor.');
    return this.transfer();
  }

  workspaceMoveIdentity(moveId: string, target: string) {
    const current = this.workspaceMoveStore().progress();
    if ((current?.state === 'preparing' || current?.state === 'frozen') &&
        current.moveId === moveId && current.target === target) return current.identity;
    const { repo } = this.getWorkspace();
    const bots = repo.list();
    if (bots.length === 0) throw new RpcError(ErrorCode.badParams, 'This Runner has no Bot workspace to move.');
    if (bots.some(bot => bot.privacy)) throw new RpcError(ErrorCode.notAllowed, 'Private Bots need their original work folders on this Runner.');
    return repo.workspaceIdentity();
  }

  workspaceIdleForMove(): boolean {
    if (this.noteErasures().pending() || this.privacyChange.size || (this.tasksAvailable() && this.tasks().activeCount())) return false;
    if (this.groupsAvailable()) {
      const { store } = this.groups();
      if (store.list().some(group => ['running', 'finalizing'].includes(store.get(group.id).round?.status ?? ''))) return false;
    }
    if (this.requestsAvailable()) {
      const requests = this.requests();
      for (const { rec } of this.options.runner().threads.values()) {
        if (rec.botLink && !rec.botWorker && !rec.copied && requests.pendingFrom(rec.id)) return false;
      }
    }
    return true;
  }

  workspaceAdopted(): void {
    const reviewDeps = this.reviewDeps;
    this.stopReviews();
    this.repository = this.workspace = undefined;
    this.privateData = undefined;
    this.requestService = this.taskService = this.groupService = this.teamService = undefined;
    this.scheduleTargets = this.deviceWorkspace = undefined;
    this.reconcileRequests();
    this.reconcileTasks();
    this.reconcileGroups();
    if (reviewDeps) this.startReviews(reviewDeps);
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
    this.reconcileGroups();
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

  private workerConversation(threadId: string) {
    if (!supervisorGuardsBotData(this.options.home, BOT_TRANSFER_FORMAT) || !this.options.canChangePrivacy?.()) {
      throw new RpcError(ErrorCode.busy, 'Wait for the Bot Runner to update and finish the handover.');
    }
    const { repo, conversations } = this.getWorkspace();
    const runner = this.options.runner();
    const state = runner.threads.get(threadId);
    const link = state?.rec.botLink;
    if (!link || link.groupId || link.taskId || state.rec.botWorker || state.rec.copied || state.rec.archivedAt ||
        runner.privateBotOf(threadId) || !repo.matchesConversation(link.botId, link.conversationId, threadId)) {
      throw new RpcError(ErrorCode.notAllowed, 'Run a worker from the Bot’s regular conversation.');
    }
    const bot = repo.get(link.botId);
    if (bot.privacy) throw new RpcError(ErrorCode.notAllowed, 'The Bot worker conversation must be public.');
    return { bot, repo, conversations, runner };
  }

  workerReadSource(threadId: string) {
    return this.workerConversation(threadId).repo.workspaceIdentity();
  }

  workerRequestSource(threadId: string) {
    const { bot, repo, conversations, runner } = this.workerConversation(threadId);
    const ceiling = lowerMode(runner.authoritySaved(threadId).mode, bot.permissionCeiling ?? 'full');
    if (bot.archivedAt || ceiling === 'plan') throw new RpcError(ErrorCode.notAllowed, 'This Bot cannot start work on another Runner.');
    return { ...repo.workspaceIdentity(), botId: bot.id, profileRevision: bot.revision, threadId, ceiling,
      title: bot.name, instructions: conversations.botContext(bot),
    };
  }

  devicesAvailable(): boolean {
    return this.unavailable() === undefined && supervisorGuardsBotData(this.options.home, BOT_DEVICE_FORMAT);
  }

  devices(): DeviceBotWorkspace {
    if (!this.devicesAvailable()) throw new RpcError(ErrorCode.notAllowed, 'Bot access from connected devices needs an updated Runner.');
    return this.deviceWorkspace ??= new DeviceBotWorkspace(this.repo(),
      () => this.options.owns() && this.options.canChangePrivacy?.() === true,
      () => protectBotData(this.options.home, BOT_DEVICE_FORMAT),
      (visible, scrub) => this.deviceDetails(visible, scrub),
    );
  }

  private canEraseNotes(): boolean {
    return !!this.options.eraseNoteFromMirror && this.unavailable() === undefined &&
      this.options.canChangePrivacy?.() === true && supervisorGuardsBotData(this.options.home, BOT_ERASE_FORMAT);
  }

  private noteErasures(): BotNoteErasureQueue {
    return this.noteErasureQueue ??= new BotNoteErasureQueue({
      home: this.options.home,
      identity: () => this.getWorkspace().repo.workspaceIdentity(),
      canWrite: () => this.canEraseNotes(),
      eraseLocal: (intent, beforeWrite) => this.getWorkspace().conversations.scopedMemory.erase(
        intent.scope, { kind: 'owner' }, intent, beforeWrite,
      ),
      eraseLocalReviews: ({ scope }) => {
        if (scope.kind !== 'bot') return;
        const { repo, conversations } = this.getWorkspace();
        const memory = conversations.scopedMemory.open(scope, { kind: 'owner' }, 'read');
        new ReviewCheckpoints(join(this.options.home, 'bots', 'reviews'))
          .eraseMemoryCopies(scope.id, repo.conversations(scope.id), memory.history());
      },
      eraseMirror: async input => {
        const erase = this.options.eraseNoteFromMirror;
        if (!erase) throw new Error('Bot note erasure needs sync.');
        return erase(input);
      },
    });
  }

  beginNoteErasure(intent: NoteErasureIntent): { revision: string } {
    return this.noteErasures().begin(intent);
  }

  async resumeNoteErasures(): Promise<void> {
    await this.noteErasures().resume();
  }

  managedMemoryRestoreAvailable(): boolean {
    return this.canEraseNotes() && !this.noteErasures().pending();
  }

  private restoreWorkspace() {
    if (!this.managedMemoryRestoreAvailable()) {
      throw new RpcError(ErrorCode.busy, 'An owning Runner with no pending erasures is required to restore a Bot note.');
    }
    return this.getWorkspace();
  }

  listMemoryBackups() {
    this.restoreWorkspace();
    return { backups: listManagedMemoryBackups(this.options.home) };
  }

  private checkedMemoryBackup<T>(input: BackupMemoryPreviewInput & { checksum?: string }, verified: BackupPreflight<T>,
    use: (memory: PersonalMemory, files: readonly PackEntry[], checksum: string) => T): Promise<T> {
    const { repo } = this.restoreWorkspace();
    const identity = repo.workspaceIdentity();
    const { files, checksum } = openManagedMemoryBackup(this.options.home, input);
    return verified(files, identity, () => {
      const current = this.restoreWorkspace();
      if (current.repo !== repo || current.repo.workspaceIdentity().epoch !== identity.epoch) {
        throw new RpcError(ErrorCode.busy, 'The Bot workspace owner changed while checking the backup.');
      }
      const memory = current.conversations.scopedMemory.open(input.scope, { kind: 'owner' }, 'write');
      return use(memory, files, checksum);
    });
  }

  previewMemoryBackup(input: BackupMemoryPreviewInput, verified: BackupPreflight<BackupPreview>) {
    return this.checkedMemoryBackup(input, verified, (memory, files, checksum) => ({
      checksum, revision: memory.revision(), notes: memory.previewBackupNotes(scopedBackupNotes(files, input.scope, checksum)),
    }));
  }

  recoverMemoryFromBackup(input: BackupMemoryRestoreInput, verified: BackupPreflight<{ revision: string }>) {
    return this.checkedMemoryBackup(input, verified, (memory, files) =>
      memory.restoreBackupNote(selectBackupMemoryNote(files, input), input.operationId, input.expectedRevision,
        this.options.runner().isoNow(), () => protectBotData(this.options.home, BOT_ERASE_FORMAT)));
  }

  private deviceDetails(visible: ReadonlySet<string>, scrub: (value: string) => string) {
    const { conversations, repo } = this.getWorkspace();
    const today = this.options.runner().isoNow().slice(0, 10);
    const groups = this.groupsAvailable() ? this.groups().store.list().filter(group =>
      !group.archivedAt && group.memberIds.every(id => visible.has(id))
    ) : [];
    const scopes = [
      ...[...visible].map(id => ({ kind: 'bot' as const, id })),
      ...groups.map(group => ({ kind: 'group' as const, id: group.id })),
    ];
    const notes = scopes.map(ref => {
      const memory = conversations.scopedMemory.open(ref, { kind: 'owner' }, 'read');
      return { scope: ref.kind, scopeId: ref.id, revision: memory.revision(), rows: memory.list(today).map(row => ({
        id: row.id, text: scrub(row.text), pinned: row.pinned,
      })) };
    });
    const tasks = this.tasksAvailable() ? [...visible].flatMap(id => this.tasks().list(id).rows.filter(task =>
      !task.privateBotId && (!task.group || groups.some(group => group.id === task.group?.groupId))
    ).map(task => ({
      botId: id, id: task.id, threadId: task.threadId, title: scrub(task.title), status: task.state.status, revision: task.revision,
    }))) : [];
    const requests = this.requestsAvailable() ? [...visible].flatMap(id => repo.conversations(id).flatMap(link => {
      if (!this.options.runner().threads.has(link.threadId)) return [];
      return this.requests().ownerList(link.threadId).filter(row => !row.sourcePrivateBotId && !row.targetPrivateBotId && visible.has(row.targetBotId))
        .map(row => ({ id: row.id, threadId: row.sourceThreadId, targetThreadId: row.targetThreadId, status: row.state.status }));
    })) : [];
    return {
      notes, tasks, requests,
      groups: groups.map(group => {
        const details = this.groups().read(group.id);
        return { id: group.id, title: scrub(group.title), queued: details.queued,
          status: details.frozen ? 'stopped' : details.round?.status ?? 'idle',
          events: details.events.filter(row => typeof row.text === 'string').slice(-20)
            .map(row => ({ id: row.id, text: scrub(String(row.text)) })),
        };
      }),
    };
  }

  async applyDeviceAction(raw: unknown, scrub: (text: string) => string) {
    const parsed = deviceAction.safeParse(raw);
    if (!parsed.success) throw new RpcError(ErrorCode.badParams, 'Invalid Bot action.');
    const { workspaceId, epoch, operationId, action } = parsed.data;
    this.devices().requireIdentity(workspaceId, epoch);
    const { repo, conversations } = this.getWorkspace();
    const publicBot = (id: string) => {
      const bot = repo.get(id);
      return !bot.privacy && !bot.archivedAt;
    };
    const publicGroup = (id: string) => {
      const { group } = this.groups().store.get(id);
      return !group.archivedAt && group.memberIds.every(publicBot);
    };
    const unavailable = () => new RpcError(ErrorCode.notAllowed, 'This Bot work is unavailable on the connected device.');
    if (action.kind === 'group.post') {
      if (!publicGroup(action.groupId)) throw unavailable();
      const post = this.groups().post(action.groupId, operationId, action.text);
      return { outcome: 'saved', eventId: post.eventId };
    }
    if (action.kind === 'task.stop') {
      const task = this.tasks().get(action.taskId);
      if (task.privateBotId || !publicBot(task.botId) || task.group && !publicGroup(task.group.groupId)) throw unavailable();
      if ('outcome' in task.state && task.state.status === 'stopped') return { outcome: 'saved' };
      const result = await this.tasks().cancel(task.id, action.expectedRevision);
      if (!result.saved) throw new Error('The task stopped but the Runner could not save that stop.');
      return { outcome: 'saved' };
    }
    if (!(action.scope.kind === 'group' ? publicGroup(action.scope.id) : publicBot(action.scope.id))) throw unavailable();
    const memory = conversations.scopedMemory.open(action.scope, { kind: 'owner' }, 'write');
    const changes = action.kind === 'note.add' ? { op: 'add' as const, text: action.text }
      : action.kind === 'note.edit' ? { op: 'edit' as const, entryId: action.entryId, text: action.text }
      : { op: 'remove' as const, entryId: action.entryId };
    // Let the existing journal recognize a retried operation before deciding a conflict.
    try {
      const result = memory.change(changes, operationId, action.expectedRevision, this.options.runner().isoNow());
      return { outcome: 'saved', revision: result.revision };
    } catch (error) {
      // A late paired-device edit must not put the erased note back in a
      // command result as a conflict draft.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'memory/erased') throw error;
      const revision = memory.revision();
      if (revision === action.expectedRevision) throw error;
      const rows = memory.list(this.options.runner().isoNow().slice(0, 10)).map(note => ({ id: note.id, text: scrub(note.text), pinned: note.pinned }));
      return { outcome: 'conflict', revision, rows, draft: 'text' in action ? scrub(action.text) : undefined };
    }
  }

  botSchedulesAvailable(): boolean {
    return this.unavailable() === undefined && supervisorGuardsBotData(this.options.home, BOT_SCHEDULE_FORMAT);
  }

  botScheduleScope(threadId: string): BotScheduleScope {
    const runtime = this.options.runner();
    const state = runtime.threads.get(threadId);
    const link = state?.rec.botLink;
    if (!link || link.groupId || link.taskId) throw new RpcError(ErrorCode.notAllowed, 'Use the regular Bot conversation to schedule this work.');
    const target = { kind: 'conversation' as const, botId: link.botId, conversationId: link.conversationId, threadId };
    this.scheduledTargets().verify(target);
    return { target, ceiling: runtime.authoritySaved(threadId).mode };
  }

  scheduledTargets(): BotScheduleTargets {
    if (!this.botSchedulesAvailable()) throw new RpcError(ErrorCode.notAllowed, 'Bot schedules need an updated Runner supervisor.');
    const { repo, conversations } = this.getWorkspace();
    return this.scheduleTargets ??= new BotScheduleTargets({
      repo, conversations, groups: () => this.groups(), runner: this.options.runner(),
    });
  }

  protectScheduleData(): void {
    if (!this.botSchedulesAvailable() || !this.options.canChangePrivacy?.()) {
      throw new RpcError(ErrorCode.busy, 'Wait for the Runner to finish handing over.');
    }
    protectBotData(this.options.home, BOT_SCHEDULE_FORMAT);
  }

  groupsAvailable(): boolean {
    return this.unavailable() === undefined && supervisorGuardsBotData(this.options.home, BOT_GROUP_FORMAT);
  }

  groups(): BotGroups {
    if (!this.groupsAvailable()) throw new RpcError(ErrorCode.notAllowed, 'Bot Groups need an updated Runner supervisor.');
    if (this.groupService) return this.groupService;
    const { home, runner, owns } = this.options;
    const store = new GroupStore(join(home, 'bots'), this.repo(), keptDelegation => {
      if (!owns() || (!keptDelegation && !this.options.canChangePrivacy?.())) {
        throw new RpcError(ErrorCode.busy, 'Wait for the Runner to finish handing over.');
      }
      protectBotData(home, BOT_GROUP_FORMAT);
    });
    return this.groupService = new BotGroups({
      runner: runner(), store, owns,
      otherActive: () => this.tasksAvailable() ? this.tasks().activeCount() : 0,
      narrow: (id, cap) => this.narrowBotThread(id, cap),
      tasks: (id, round) => this.tasksAvailable() ? this.tasks().groupTasks(id, round) : [],
      stopTasks: (id, threads) => this.tasks().stopGroup(id, threads),
    });
  }

  private approveGroupNote(groupId: string, seq: number, operationId: string, text: string) {
    if (!this.options.owns() || !this.options.canChangePrivacy?.()) throw new RpcError(ErrorCode.busy, 'Wait for the Runner to finish handing over.');
    const { reportId, result } = this.groups().resultRecord(groupId, seq);
    const memory = this.getWorkspace().conversations.scopedMemory.open({ kind: 'group', id: groupId }, { kind: 'owner' }, 'write');
    const receipt = memory.approveReview({ op: 'add', text }, {
      reportId, index: 0, operationId, conversationId: groupId,
      threadId: result.source.threadId, first: result.source.seq, through: result.source.seq,
      acceptedText: text,
    }, this.options.runner().isoNow(), value => this.reviewDeps?.redact(value) ?? value);
    return { receipt };
  }

  groupQueue(threadId: string, ref: NonNullable<BotInputRef['group']>): 'allow' | 'wait' | 'drop' {
    return this.groupsAvailable() ? this.groups().queue(threadId, ref) : 'wait';
  }

  reconcileGroups(): void {
    if (!this.requestListener || this.groupWake || !this.groupsAvailable()) return;
    this.groupWake = true;
    setImmediate(() => {
      if (!this.groupWake) return;
      this.groupWake = false;
      if (!this.groupsAvailable() || !this.options.canChangePrivacy?.()) return;
      try { this.groups().recover(); }
      catch { this.options.runner().notice('warning', 'The Bot Group records could not be reopened.'); }
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
      groupOrigin: rec => this.groupsAvailable() ? this.groups().taskOrigin(rec) : undefined,
      groupActive: task => this.groupsAvailable() ? this.groups().taskActive(task) : undefined,
      groupReply: task => {
        if (!this.groupsAvailable() || !this.groups().taskReply(task)) return false;
        this.reconcileGroups();
        return true;
      },
      journal: new TaskJournal(join(home, 'bots'), atomicWriteFileSync, () => {
        if (!owns() || !this.options.canChangePrivacy?.()) throw new RpcError(ErrorCode.busy, 'Wait for the Runner to finish handing over.');
        protectBotData(home, BOT_TASK_FORMAT);
      }, () => this.groupsAvailable() ? this.groups().activeCount() : 0),
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
      try {
        this.tasks().recover(threadId);
        this.reconcileGroups();
      }
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
      if (note.method === 'thread.updated') {
        if (note.params.thread.botLink?.taskId) this.reconcileTasks(note.params.thread.id);
        if (note.params.thread.botLink?.groupId) this.reconcileGroups();
        return;
      }
      if (note.method !== 'thread.event') return;
      const { threadId, event } = note.params;
      const link = runner.threads.get(threadId)?.rec.botLink;
      if (!link) {
        if (event.type === 'turn.completed' && this.options.peerOwns?.(threadId)) this.reconcileRequests(threadId);
        return;
      }
      if (link.groupId && (event.type === 'turn.completed' || event.type === 'approval.resolved')) this.reconcileGroups();
      if (event.type === 'turn.completed' || (event.type === 'user.message' && (event.botInput?.request || event.botInput?.task))) this.reconcileRequests(threadId);
      if (event.type === 'turn.completed' || (event.type === 'user.message' && event.botInput?.task)) this.reconcileTasks(threadId);
    });
    this.reconcileRequests();
    this.reconcileTasks();
    this.reconcileGroups();
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
    this.groupWake = false;
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
        if (botLink && !botLink.taskId && !botLink.groupId && !this.unavailable()) queue.status(id, status === 'idle');
      } else if (note.method === 'thread.deleted') {
        queue.status(note.params.threadId, false);
      }
    });
    if (!this.unavailable()) {
      for (const { rec } of runner.threads.values()) {
        if (rec.botLink && !rec.botLink.taskId && !rec.botLink.groupId && !rec.copied && rec.status === 'idle') {
          queue.status(rec.id, true);
        }
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
    if (this.transfer().blocked()) return 'The Bot workspace is frozen for a move.';
    return undefined;
  }

  private transfer(): BotWorkspaceTransfer {
    const { home, owner, owns } = this.options;
    return this.transferService ??= new BotWorkspaceTransfer(home, owner(), format => {
      if (!owns() || !this.options.canChangePrivacy?.()) throw new RpcError(ErrorCode.busy, 'Wait for the Runner to finish handing over.');
      protectBotData(home, format ?? BOT_TRANSFER_FORMAT);
    });
  }

  private getWorkspace() {
    const reason = this.unavailable();
    if (reason) throw new RpcError(ErrorCode.notAllowed, reason);
    if (!this.workspace) {
      const { home, runner } = this.options;
      const root = join(home, 'bots');
      const repo = this.repo();
      this.workspace = {
        repo,
        conversations: new BotConversations(runner(), repo, root, text => this.reviewDeps?.redact(text) ?? text, {
          canModify: () => this.unavailable() === undefined,
          protectRoster: () => {
            if (this.unavailable() !== undefined) throw new RpcError(ErrorCode.notAllowed, 'This Runner cannot change the Bot roster now.');
            protectBotData(home, BOT_ERASE_FORMAT);
          },
          mayAttach: id => this.options.canChangePrivacy?.() === true && !this.options.peerOwns?.(id) && !this.options.threadUnavailableForAttachment?.(id),
          protectErasure: () => {
            if (!this.canEraseNotes()) throw new RpcError(ErrorCode.notAllowed, 'This Runner cannot erase Bot notes now.');
            protectBotData(home, BOT_ERASE_FORMAT);
          },
          group: id => {
            if (!this.groupsAvailable()) return undefined;
            const { group } = this.groups().store.get(id);
            return { name: group.title, memberIds: group.memberIds, archived: Boolean(group.archivedAt) };
          },
          groups: () => this.groupsAvailable() ? this.groups().store.list().map(group => ({
            id: group.id, name: group.title, memberIds: group.memberIds, archived: Boolean(group.archivedAt),
          })) : [],
        }),
      };
    }
    return this.workspace;
  }

  private repo(): BotRepository {
    const { home, owner } = this.options;
    return this.repository ??= new BotRepository(join(home, 'bots'), owner(), () => {
      if (this.transfer().blocked()) throw new RpcError(ErrorCode.busy, 'The Bot workspace is frozen for a move.');
      protectBotData(home);
    });
  }

  private protectNewFormat(): void {
    if (!this.options.canChangePrivacy?.()) throw new RpcError(ErrorCode.busy, 'Wait for the old Runner to finish handing over.');
    const protect = this.options.protectPrivacy ?? (() => protectBotData(this.options.home, PRIVATE_BOT_FORMAT));
    protect();
    this.privateData = true;
  }

  private async makePrivate(input: { botId: string; expectedRevision: number; folder: string; operationId: string }) {
    this.getWorkspace();
    const resume = await this.options.withdrawDeviceProfile?.(input.botId);
    try { return await this.applyPrivate(input); }
    finally { resume?.(); }
  }

  private applyPrivate({ botId, expectedRevision, folder, operationId }: { botId: string; expectedRevision: number; folder: string; operationId: string }) {
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
      if (this.groupsAvailable() && this.groups().store.list().some(group => !group.archivedAt && group.memberIds.includes(botId))) {
        throw new Error('Remove the Bot from its Groups before making it private.');
      }

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
    if (rec.botLink?.groupId) {
      const groups = this.groups();
      const { group } = groups.threads.check(rec);
      const { conversations, repo } = this.getWorkspace();
      const bot = repo.get(rec.botLink.botId);
      const memory = conversations.scopedMemory.open({ kind: 'group', id: group.id }, {
        kind: 'bot', id: bot.id, private: false, groupId: group.id, teamId: group.teamId, grants: [],
      }, 'read');
      const notes = memory.list(this.options.runner().isoNow().slice(0, 10)).filter(note => !note.topic);
      const names = group.memberIds.flatMap(id => {
        const member = groups.store.member(group, id);
        return member ? [`${member.name}: ${id}`] : [];
      });
      return [conversations.botContext(bot), `Group: ${group.title}`,
        `Group members:
${names.join('\n')}`,
        'Use call_group_members once, naming all the member IDs needed for this piece of work. If this turn is the summary, use the recorded results and reply.',
        notes.length ? `Notes approved for this Group:
${notes.map(note => `- ${note.text}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
    }
    const task = rec.botLink?.taskId ? this.tasks().active(rec) : undefined;
    return this.getWorkspace().conversations.context(rec, task);
  }
}
