// Ownership and target checks adapt DS-Bot schedules.js ownerOf and
// currentSessionOf, d104d9ca18d69a35460f14e15dff4d553181433a (Apache-2.0).
import { lowerMode, raises } from '../access.ts';
import { ErrorCode, RpcError, type BotScheduleTarget, type PermissionMode, type Schedule } from '../protocol.ts';
import type { Runner } from '../runner.ts';
import type { BotConversations } from './conversations.ts';
import type { BotGroups } from './groups.ts';
import type { BotRepository } from './repository.ts';

type Options = {
  repo: BotRepository;
  conversations: BotConversations;
  groups: () => BotGroups;
  runner: Runner;
};

export class BotScheduleTargets {
  private readonly options: Options;

  constructor(options: Options) { this.options = options; }

  label(target: BotScheduleTarget): string {
    try {
      const { groups, repo, runner } = this.options;
      if (target.kind === 'group') return groups().store.get(target.groupId).group.title;
      const { name } = repo.get(target.botId);
      if (target.kind === 'newConversation') return `New conversation with ${name}`;
      return runner.store.load(target.threadId)?.title || name;
    } catch {
      return 'Unavailable Bot target';
    }
  }

  verify(target: BotScheduleTarget): { revision: number; ceiling: PermissionMode; private?: boolean } {
    const { repo, groups, runner } = this.options;
    if (target.kind === 'group') {
      const { group } = groups().store.get(target.groupId);
      if (group.archivedAt) throw new RpcError(ErrorCode.notAllowed, 'This Group has been archived.');
      return { revision: group.revision, ceiling: group.ceiling };
    }
    const bot = repo.get(target.botId);
    if (bot.archivedAt || bot.privacy?.moving) throw new RpcError(ErrorCode.notAllowed, 'This Bot is unavailable.');
    if (target.kind === 'conversation') {
      const { conversationId, threadId } = target;
      if (!repo.matchesConversation(bot.id, conversationId, threadId)) {
        throw new RpcError(ErrorCode.notAllowed, 'This conversation does not belong to the scheduled Bot.');
      }
      const rec = runner.store.load(threadId);
      if (!rec || rec.archivedAt || rec.copied || rec.botLink?.botId !== bot.id ||
          rec.botLink.conversationId !== conversationId || rec.privateBotId !== (bot.privacy ? bot.id : undefined)) {
        throw new RpcError(ErrorCode.notAllowed, 'This Bot conversation is unavailable.');
      }
    }
    return { revision: bot.revision, ceiling: bot.permissionCeiling ?? 'full', private: Boolean(bot.privacy) };
  }

  deliver(target: BotScheduleTarget, schedule: Pick<Schedule, 'id' | 'botCeiling'>, run: string, text: string, since: number) {
    const { runner, groups, conversations } = this.options;
    const policy = this.verify(target);
    const ceiling = lowerMode(policy.ceiling, schedule.botCeiling ?? 'ask');
    const operation = `${schedule.id}:${run}`;
    if (target.kind === 'group') {
      const post = groups().post(target.groupId, operation, text, { id: schedule.id, ceiling: schedule.botCeiling ?? 'ask', settingsRevision: policy.revision });
      return { turnId: post.eventId, settingsRevision: post.schedule?.settingsRevision ?? policy.revision };
    }
    const threadId = target.kind === 'conversation' ? target.threadId : conversations.create(target.botId, operation, ceiling).threadId;
    const previous = runner.findScheduledSend(threadId, schedule.id, run, since);
    if (!previous && raises(runner.accessOf(threadId), ceiling)) {
      throw new RpcError(ErrorCode.notAllowed, 'The scheduled Bot conversation is above the saved permission limit.');
    }
    const { turnId, scheduledRevision } = previous ?? runner.sendScheduled(threadId, text, schedule.id, run, since, undefined, ceiling, policy.revision);
    return { threadId, turnId, settingsRevision: scheduledRevision ?? policy.revision };
  }

  withdraw(target: BotScheduleTarget, scheduleId: string): void {
    const { repo, runner, groups } = this.options;
    if (target.kind === 'group') {
      groups().withdraw(target.groupId, scheduleId);
      return;
    }
    const threads = target.kind === 'conversation' ? [target.threadId] : repo.conversations(target.botId).map(link => link.threadId);
    for (const threadId of threads) if (runner.threads.has(threadId)) runner.dropScheduled(threadId, scheduleId);
  }
}
