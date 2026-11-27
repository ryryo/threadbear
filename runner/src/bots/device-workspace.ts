import { z } from 'zod';
import { ErrorCode, RpcError } from '../protocol.ts';
import { botOperationId, type BotRepository } from './repository.ts';

const profileEdit = z.object({
  workspaceId: z.uuid(),
  epoch: z.int().positive(),
  botId: z.uuid(),
  expectedRevision: z.int().positive(),
  operationId: botOperationId,
  settings: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.string().max(120).optional(),
    instructions: z.string().max(30_000).optional(),
  }).refine(fields => Object.keys(fields).length > 0),
});

type ExtraSnapshot = {
  notes: { scope: 'bot' | 'group'; scopeId: string; revision: string; rows: { id: string; text: string; pinned: boolean }[] }[];
  tasks: { botId: string; id: string; threadId: string; title: string; status: string; revision: number }[];
  requests: { id: string; threadId: string; targetThreadId: string; status: string }[];
  groups: { id: string; title: string; status: string; queued: number; events: { id: string; text: string }[] }[];
};
type Extra = (visible: ReadonlySet<string>, scrub: (text: string) => string) => ExtraSnapshot;

export class DeviceBotWorkspace {
  private readonly repo: BotRepository;
  private readonly owns: () => boolean;
  private readonly protect: () => void;
  private readonly extra?: Extra;

  constructor(repo: BotRepository, owns: () => boolean, protect: () => void, extra?: Extra) {
    this.repo = repo;
    this.owns = owns;
    this.protect = protect;
    this.extra = extra;
  }

  private owned() {
    if (!this.owns()) throw new RpcError(ErrorCode.busy, 'The primary Runner is still taking the Bot workspace.');
    return this.repo.workspaceIdentity();
  }

  snapshot(redact: (value: string) => string, excluded: ReadonlySet<string> = new Set()) {
    const identity = this.owned();
    const profiles = this.repo.list().filter(bot => !bot.privacy && !bot.archivedAt && !excluded.has(bot.id)).map(bot => ({
      id: bot.id, name: redact(bot.name), role: redact(bot.role), instructions: redact(bot.instructions), revision: bot.revision,
    }));
    if (profiles.length) this.protect();
    const visible = new Set(profiles.map(bot => bot.id));
    const extras = this.extra?.(visible, redact) ?? { notes: [], tasks: [], requests: [], groups: [] };
    return { ...identity, profiles, ...extras };
  }

  requireIdentity(workspaceId: string, epoch: number): void {
    const identity = this.owned();
    if (identity.workspaceId !== workspaceId || identity.epoch !== epoch) {
      throw new RpcError(ErrorCode.notAllowed, 'The Bot workspace changed. Reload it before editing.');
    }
  }

  edit(input: unknown, scrub: (value: string) => string = value => value) {
    const { workspaceId, epoch, botId, expectedRevision, operationId, settings } = profileEdit.parse(input);
    this.requireIdentity(workspaceId, epoch);
    const bot = this.repo.get(botId);
    if (bot.archivedAt || bot.privacy) throw new RpcError(ErrorCode.notAllowed, 'That Bot is unavailable on this device.');
    const result = this.repo.updateWithReceipt(botId, expectedRevision, settings, operationId, this.protect);
    const visible = <T extends { name?: string; role?: string; instructions?: string }>(row: T): T => ({
      ...row,
      ...(row.name !== undefined && { name: scrub(row.name) }),
      ...(row.role !== undefined && { role: scrub(row.role) }),
      ...(row.instructions !== undefined && { instructions: scrub(row.instructions) }),
    });
    return result.outcome === 'saved' ? { ...result, bot: visible(result.bot) }
      : { ...result, current: visible(result.current), draft: visible(result.draft) };
  }
}
