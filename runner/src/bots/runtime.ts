import { join } from 'node:path';
import { ErrorCode, RpcError } from '../protocol.ts';
import type { Runner } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import { BotConversations } from './conversations.ts';
import { protectBotData } from './format.ts';
import { BotRepository } from './repository.ts';
import { botMethods } from './rpc.ts';

export const BOT_EXPERIMENT = 'nativeBots';

type Options = {
  home: string;
  runner: () => Runner;
  owner: () => string;
  enabled: () => boolean;
  guarded: () => boolean;
  owns: () => boolean;
};

export class BotRuntime {
  private readonly options: Options;
  private workspace?: { repo: BotRepository; conversations: BotConversations };

  readonly methods = Object.assign(botMethods(() => this.getWorkspace()), {
    'bots.status': (_params: Record<string, unknown>) => {
      const reason = this.unavailable();
      return { enabled: this.options.enabled() && this.options.owns(), available: reason === undefined, reason };
    },
  });

  constructor(options: Options) {
    this.options = options;
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
      const { home, owner, runner } = this.options;
      const root = join(home, 'bots');
      const repo = new BotRepository(root, owner(), () => protectBotData(home));
      this.workspace = { repo, conversations: new BotConversations(runner(), repo, root) };
    }
    return this.workspace;
  }

  context(rec: ThreadRecord): string {
    if (rec.copied) throw new RpcError(ErrorCode.notAllowed, 'A copy of a Bot conversation stays read-only.');
    return this.getWorkspace().conversations.context(rec);
  }
}
