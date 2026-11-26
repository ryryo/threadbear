import { join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import type { Clock } from '../clock.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import type { Runner } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import { BotConversations } from './conversations.ts';
import { hasPrivateBotData, PRIVATE_BOT_FORMAT, protectBotData } from './format.ts';
import { ReviewQueue } from './memory-review.ts';
import { foldersOverlap } from './privacy-folders.ts';
import { BotRepository } from './repository.ts';
import { BotReviews, type BotReviewOptions } from './reviews.ts';
import { botMethods } from './rpc.ts';

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
};
type ReviewDeps = Pick<BotReviewOptions, 'redact' | 'askers' | 'privateFolder'> & { clock: Clock; onError: (id: string) => void };

export class BotRuntime {
  private readonly options: Options;
  private repository?: BotRepository;
  private workspace?: { repo: BotRepository; conversations: BotConversations };
  private reviewService?: BotReviews;
  private reviewQueue?: ReviewQueue;
  private reviewDeps?: ReviewDeps;
  private stopListening?: () => void;

  readonly methods = Object.assign(botMethods(() => this.getWorkspace(), () => this.reviews(), p => this.makePrivate(p)), {
    'bots.status': (_params: Record<string, unknown>) => {
      const reason = this.unavailable();
      return { enabled: this.options.enabled() && this.options.owns(), available: reason === undefined, reason };
    },
  });

  constructor(options: Options) {
    this.options = options;
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
        if (botLink && !this.unavailable()) queue.status(id, status === 'idle');
      } else if (note.method === 'thread.deleted') {
        queue.status(note.params.threadId, false);
      }
    });
    if (!this.unavailable()) {
      for (const { rec } of runner.threads.values()) {
        if (rec.botLink && !rec.copied && rec.status === 'idle') queue.status(rec.id, true);
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
      this.workspace = { repo, conversations: new BotConversations(runner(), repo, root) };
    }
    return this.workspace;
  }

  private repo(): BotRepository {
    const { home, owner } = this.options;
    return this.repository ??= new BotRepository(join(home, 'bots'), owner(), () => protectBotData(home));
  }

  private makePrivate({ botId, expectedRevision, folder, operationId }: { botId: string; expectedRevision: number; folder: string; operationId: string }) {
    const { repo } = this.getWorkspace();
    const runner = this.options.runner();
    const canonical = realpathSync.native(folder);
    return repo.setPrivate(botId, expectedRevision, canonical, operationId, () => {
      if (!this.options.canChangePrivacy?.()) throw new RpcError(ErrorCode.busy, 'Wait for the old Runner to finish handing over before making a Bot private.');
      if (!statSync(canonical).isDirectory()) throw new Error('Choose an existing work folder for this Bot');
      const otherFolders = repo.list().flatMap(bot => bot.id !== botId && bot.privacy ? bot.privacy.folder : []);
      const threadFolders = [...runner.threads.values()].map(({ rec }) => rec.cwd);
      if ([runner.cfg.defaults.cwd, ...threadFolders, ...otherFolders].some(path => foldersOverlap(canonical, path))) {
        throw new Error('Choose a dedicated Bot folder outside the Runner default and any existing work folders');
      }
      const protect = this.options.protectPrivacy ?? (() => protectBotData(this.options.home, PRIVATE_BOT_FORMAT));
      protect();
    });
  }

  folderRefusal(cwd: string, privateBotId?: string): string | undefined {
    if (!privateBotId && !this.repository && !hasPrivateBotData(this.options.home)) return undefined;
    const entries = this.repo().list();
    if (privateBotId !== undefined) {
      if (!this.options.enabled()) return 'The Bots experiment is turned off.';
      const root = entries.find(bot => bot.id === privateBotId)?.privacy?.folder;
      if (!root || cwd !== root || realpathSync.native(cwd) !== root) return 'This private Bot uses its dedicated work folder.';
      return undefined;
    }
    if (entries.some(bot => bot.privacy && foldersOverlap(cwd, bot.privacy.folder))) return 'This folder overlaps a private Bot’s work folder.';
    return undefined;
  }

  context(rec: ThreadRecord): string {
    if (rec.copied) throw new RpcError(ErrorCode.notAllowed, 'A copy of a Bot conversation stays read-only.');
    return this.getWorkspace().conversations.context(rec);
  }
}
