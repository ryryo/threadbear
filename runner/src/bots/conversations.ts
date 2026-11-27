import { realpathSync, statSync } from 'node:fs';
import type { Runner } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import type { PersonalMemory, MemoryNote } from './ported/personal-memory.js';
import type { Bot, BotRepository, Conversation } from './repository.ts';
import { ScopedMemory } from './scoped-memory.ts';
import { lowerMode, raises } from '../access.ts';
import { copyAppearance, rosterCopy } from './ported/roster-copy.js';

export class BotConversations {
  private readonly runner: Runner;
  private readonly repo: BotRepository;
  private readonly mayAttach?: (threadId: string) => boolean;
  private readonly canModify?: () => boolean;
  private readonly protectRoster?: () => void;
  readonly scopedMemory: ScopedMemory;

  constructor(runner: Runner, repo: BotRepository, root: string, redact?: (text: string) => string,
    options?: Pick<ConstructorParameters<typeof ScopedMemory>[0], 'group' | 'groups' | 'protectErasure'> & {
      mayAttach?: (threadId: string) => boolean; canModify?: () => boolean; protectRoster?: () => void;
    }) {
    this.runner = runner;
    this.repo = repo;
    const { mayAttach, canModify, protectRoster, ...groupScope } = options ?? {};
    this.mayAttach = mayAttach;
    this.canModify = canModify;
    this.protectRoster = protectRoster;
    this.scopedMemory = new ScopedMemory({ repo, root, projects: runner.projects, redact, ...groupScope });
  }

  create(botId: string, operationId: string, ceiling?: import('../protocol.ts').PermissionMode): Conversation {
    const reserved = this.repo.reserveConversation(botId, operationId);
    const bot = this.repo.get(botId);
    const existing = this.runner.store.load(reserved.threadId);
    if (existing) {
      if (existing.botLink?.botId !== botId || existing.botLink.conversationId !== reserved.id ||
          existing.privateBotId !== (bot.privacy ? bot.id : undefined)) {
        throw new Error('The saved Thread does not match its Bot conversation');
      }
    } else {
      if (typeof reserved.sessionId !== 'string') throw new Error('This Bot conversation’s Thread is gone');
      this.runner.makeThread({ ...botThreadOptions(this.runner, bot, ceiling), text: '', title: bot.name }, {
        id: reserved.threadId,
        sessionId: reserved.sessionId,
        botLink: { botId, conversationId: reserved.id },
        ...(bot.privacy ? { privateBotId: bot.id } : {}),
      });
    }
    const link = this.repo.confirmConversation(operationId, reserved.threadId);
    const state = this.runner.threads.get(link.threadId);
    if (state) this.runner.markDirty(state);
    return link;
  }

  async duplicate(botId: string, sourceRevision: number, operationId: string): Promise<Bot> {
    const { repo, runner } = this;
    const prior = repo.copiedBot(botId, sourceRevision, operationId);
    if (prior) return prior;
    const source = repo.get(botId);
    const binding = source.modelBinding;
    const checkedModel = () => {
      const account = binding && runner.accounts.get(binding.accountId);
      if (!binding || !account || account.provider !== binding.provider) return undefined;
      try {
        runner.checkProvider(account);
      } catch {
        return undefined;
      }
      const checked = runner.checkSettings(account, binding.model, binding.effort);
      if (checked.model !== binding.model) return undefined;
      return { ...binding, effort: checked.effort };
    };
    const duplicate = rosterCopy({
      liveBot: () => source.archivedAt ? undefined : {
        ...source, private: Boolean(source.privacy), model: binding?.model, effort: binding?.effort, workDir: source.workFolder,
      },
      botNameTaken: name => repo.nameTaken(name.toWellFormed()),
      rt: {
        catalog: async () => {
          const model = checkedModel();
          return model ? [{ ref: model.model }] : [];
        },
        isFolder: async folder => statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true,
      },
      createBot: ({ copyOf, workDir, model, effort, name, role, instructions, ...appearance }) => {
        if (this.canModify?.() === false) throw new Error('Only the current Runner can copy this Bot.');
        const checked = model && checkedModel() || undefined;
        const modelBinding = checked && (effort === null ? { ...checked, effort: undefined, useModelDefaultEffort: true as const } : checked);
        const workFolder = workDir && realpathSync.native(workDir);
        if (workFolder) runner.checkBotFolder(workFolder);
        return repo.duplicateBot(copyOf, sourceRevision, operationId, { name, role, instructions, ...copyAppearance(appearance), modelBinding, workFolder }, this.protectRoster);
      },
    });
    return duplicate(botId);
  }

  attach(botId: string, expectedRevision: number, threadId: string, operationId: string): Conversation {
    const { repo, runner } = this;
    runner.checkAccepting();
    const state = runner.threads.get(threadId);
    if (!state || state.rt.deleted || state.rec.copied || state.rec.botWorker || state.rec.coordinatorHelperFor ||
        this.canModify?.() === false || this.mayAttach?.(threadId) === false) {
      throw new Error('Only an owned local Thread can be attached.');
    }
    const previous = repo.attachment(operationId, botId, threadId);
    if (previous) {
      const recovered = this.confirmSavedAttachment(state.rec);
      if (recovered) {
        this.publishAttachedThread(threadId);
        return recovered;
      }
    }
    const { rec, rt } = state;
    if (rec.botLink) {
      if (previous && repo.matchesConversation(botId, previous.id, threadId) && rec.botLink.conversationId === previous.id &&
          rec.botLink.botId === botId) return previous;
      throw new Error('This Thread already belongs to a Bot conversation.');
    }
    if (previous && repo.matchesConversation(botId, previous.id, threadId)) {
      throw new Error('The Thread has lost its saved Bot link.');
    }
    if (rec.archivedAt || rec.status !== 'idle' || rec.queue.length || rec.pendingApprovals.length ||
        rec.stoppedMidTurn || rec.waitingForNetwork || rec.waitingForRoom || rec.waitingForToken ||
        rt.turn || rt.moving || rt.tasks.length || rec.subagents?.some(agent => agent.status === 'running')) {
      throw new Error('Choose an idle Thread with no queued or background work.');
    }
    const bot = repo.get(botId);
    if (bot.privacy || runner.privateBotOf(threadId)) throw new Error('A Private Bot or Thread cannot be attached.');
    if (bot.archivedAt || bot.revision !== expectedRevision || previous && previous.configRevision !== expectedRevision) {
      throw new Error('The Bot changed. Reload its settings before attaching the Thread.');
    }
    if (bot.permissionCeiling && raises(rec.permissionMode, bot.permissionCeiling)) {
      throw new Error('The Thread’s permission mode exceeds the Bot’s ceiling.');
    }
    const binding = bot.modelBinding;
    if (binding && (rec.accountId !== binding.accountId || rec.provider !== binding.provider ||
        rec.model !== binding.model || rec.effort !== binding.effort || rec.poolId)) {
      throw new Error('Match the Thread’s login, model and effort to the Bot before attaching it.');
    }
    runner.checkBotFolder(rec.cwd);
    if (bot.workFolder && realpathSync.native(rec.cwd) !== realpathSync.native(bot.workFolder)) {
      throw new Error('The Thread’s work folder must match the Bot’s work folder.');
    }
    const pending = previous ?? repo.reserveAttachment(botId, expectedRevision, threadId, rec.nativeSessionId, operationId, this.protectRoster);
    if (pending.sessionId !== rec.nativeSessionId) {
      throw new Error('The Thread’s CLI session changed after reserving the attachment.');
    }
    const linked = { ...rec, botLink: { botId, conversationId: pending.id } };
    runner.store.save(linked);
    state.rec = linked;
    const conversation = repo.confirmConversation(operationId, threadId);
    this.publishAttachedThread(threadId);
    return conversation;
  }

  private publishAttachedThread(threadId: string): void {
    this.runner.publish({ method: 'thread.updated', params: { thread: this.runner.get(threadId) } });
  }

  private confirmSavedAttachment(rec: ThreadRecord): Conversation | undefined {
    const pending = this.repo.pendingAttachment(rec.id);
    if (!pending || rec.botLink?.botId !== pending.botId || rec.botLink.conversationId !== pending.id ||
        rec.nativeSessionId !== pending.sessionId || this.canModify?.() === false || this.mayAttach?.(rec.id) === false) return undefined;
    return this.repo.confirmConversation(pending.operationId, rec.id);
  }

  summary(threadId: string) { return this.runner.get(threadId); }

  now(): string { return this.runner.isoNow(); }

  private conversationRecord(botId: string, threadId: string): ThreadRecord {
    const rec = this.runner.store.load(threadId);
    const saved = rec?.botLink;
    if (!rec || rec.copied || saved?.botId !== botId ||
        (!this.repo.matchesConversation(botId, saved.conversationId, threadId) && !this.confirmSavedAttachment(rec))) {
      throw new Error('This Thread does not belong to this Bot');
    }
    return rec;
  }

  conversationModel(botId: string, expectedRevision: number, threadId: string | null) {
    if (threadId === null) return this.repo.setModelBinding(botId, expectedRevision, undefined);
    const rec = this.conversationRecord(botId, threadId);
    const account = this.runner.accounts.get(rec.accountId);
    const model = rec.model ?? account?.defaultModel;
    if (!model || !account || account.provider !== rec.provider) throw new Error('Choose a login and model on the conversation first');
    return this.repo.setModelBinding(botId, expectedRevision, { accountId: rec.accountId, provider: rec.provider, model, effort: rec.effort });
  }

  private memoryFor(botId: string, threadId: string, access: 'read' | 'write' = 'read'): PersonalMemory {
    this.conversationRecord(botId, threadId);
    return this.scopedMemory.open({ kind: 'bot', id: botId }, { kind: 'owner' }, access);
  }

  notes(botId: string, threadId: string): MemoryNote[] {
    return this.memoryFor(botId, threadId).list(this.runner.isoNow().slice(0, 10));
  }

  search(botId: string, threadId: string, query: string): MemoryNote[] {
    return this.memoryFor(botId, threadId).search(query, this.runner.isoNow().slice(0, 10));
  }

  private writableMemory(botId: string, threadId: string): PersonalMemory {
    if (this.repo.get(botId).archivedAt) throw new Error('This Bot is archived');
    return this.memoryFor(botId, threadId, 'write');
  }

  remember(botId: string, threadId: string, text: string, until?: string): MemoryNote {
    return this.writableMemory(botId, threadId).add(text, { sourceThreadId: threadId, until }, this.runner.isoNow());
  }

  editNote(botId: string, threadId: string, entryId: string, text: string): MemoryNote {
    return this.writableMemory(botId, threadId).replace(entryId, text, this.runner.isoNow());
  }

  removeNote(botId: string, threadId: string, entryId: string): void {
    this.writableMemory(botId, threadId).remove(entryId, this.runner.isoNow());
  }

  restoreNote(botId: string, threadId: string, changeId: string): void {
    this.writableMemory(botId, threadId).restore(changeId, this.runner.isoNow());
  }

  history(botId: string, threadId: string, before?: string) {
    return this.memoryFor(botId, threadId).historyPage(before);
  }

  archive(botId: string, expectedRevision: number) {
    return this.repo.archive(botId, expectedRevision, this.runner.isoNow());
  }

  context(rec: ThreadRecord, task?: { id: string; botId: string; threadId: string }): string {
    const link = rec.botLink;
    if (!link) throw new Error('This Thread has no Bot link');
    const bot = this.repo.get(link.botId);
    if (bot.archivedAt) throw new Error('This Bot is archived');
    if (task) {
      if (task.id !== link.taskId || task.botId !== bot.id || task.threadId !== rec.id) throw new Error('This Thread does not match the Bot task');
    } else {
      this.conversationRecord(bot.id, rec.id);
    }
    return this.botContext(bot);
  }

  botContext(bot: Bot): string {
    const memory = this.scopedMemory.open({ kind: 'bot', id: bot.id }, { kind: 'bot', id: bot.id, private: Boolean(bot.privacy), grants: [] }, 'read');
    const notes = memory.list(this.runner.isoNow().slice(0, 10)).filter(note => !note.topic);
    return [
      `Bot name: ${bot.name}`,
      bot.role ? `Role: ${bot.role}` : '',
      bot.instructions ? `Bot instructions:\n${bot.instructions}` : '',
      notes.length ? `Notes saved by the user for this Bot:\n${notes.map(note => `- ${note.text}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  }
}

export function botThreadOptions(runner: Runner, bot: Bot, maximum?: import('../protocol.ts').PermissionMode) {
  const binding = bot.modelBinding;
  if (binding) {
    const account = runner.accounts.get(binding.accountId);
    if (!account || account.provider !== binding.provider) throw new Error('The saved Bot login is no longer available');
    const checked = runner.checkSettings(account, binding.model, binding.effort);
    if (checked.model !== binding.model || checked.effort !== binding.effort) throw new Error('The saved Bot model or effort is no longer available');
  }
  const cap = maximum === undefined ? bot.permissionCeiling : lowerMode(maximum, bot.permissionCeiling ?? 'full');
  return {
    cwd: bot.privacy?.folder ?? bot.workFolder,
    ...binding,
    ...(cap !== undefined && { permissionMode: lowerMode(runner.cfg.defaults.permissionMode ?? 'full', cap) }),
  };
}
