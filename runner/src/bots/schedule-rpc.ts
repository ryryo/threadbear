import { z } from 'zod';
import { lowerMode } from '../access.ts';
import type { ScheduleControl } from '../threadbear-mcp.ts';
import { ErrorCode, PERMISSION_MODES, RpcError, type BotScheduleTarget, type PermissionMode, type Schedule } from '../protocol.ts';
import type { BotScheduleTargets } from './schedule-target.ts';
import type { Scheduler } from '../schedules.ts';
import { method } from './rpc.ts';

const id = z.uuid();
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), botId: id, conversationId: id, threadId: id }),
  z.object({ kind: z.literal('newConversation'), botId: id }),
  z.object({ kind: z.literal('group'), groupId: id }),
]);
const timing = {
  at: z.string().trim().min(1).optional(),
  cron: z.string().trim().min(1).optional(),
  timezone: z.string().trim().min(1).optional(),
};
const identity = z.object({ scheduleId: id });
const text = z.string().trim().min(1).max(30_000);
const title = z.string().trim().min(1).max(120);

export function botScheduleMethods(scheduler: Scheduler, available: () => boolean, targets: () => BotScheduleTargets): Record<string, (p: Record<string, unknown>) => unknown> {
  const get = () => {
    if (!available()) throw new RpcError(ErrorCode.notAllowed, 'Bot scheduling is unavailable on this Runner.');
    return scheduler;
  };
  const ownerRow = (scheduleId: string) => {
    const row = get().find(scheduleId);
    if (!row.botTarget) throw new RpcError(ErrorCode.badParams, 'This schedule has no Bot target.');
    return row;
  };
  return {
    'bots.schedules.list': () => ({ schedules: get().botScheduleList().map(row => ({
      ...row, botTargetLabel: row.botTarget ? targets().label(row.botTarget) : undefined,
    })) }),
    'bots.schedules.create': method(z.object({ ...timing, title: title.optional(), text, botTarget: target, ceiling: z.enum(PERMISSION_MODES).optional() }),
      async input => ({ schedule: await get().create(input) })),
    'bots.schedules.update': method(identity.extend({
      ...timing, expectedUpdatedAt: z.iso.datetime(), title: title.optional(), text: text.optional(), paused: z.boolean().optional(),
    }), async ({ expectedUpdatedAt, ...input }) => ({
      schedule: await get().update({ ...input, botEdit: { expectedUpdatedAt } }),
    })),
    'bots.schedules.delete': method(identity, ({ scheduleId }) => get().delete(ownerRow(scheduleId).id, true)),
    'bots.schedules.run': method(identity, ({ scheduleId }) => get().runNow(ownerRow(scheduleId).id, 'full', true)),
  };
}

// DS-Bot schedules.js checks that the existing Session and the caller
// belong to the same Bot chat. Here the native conversation IDs and
// Thread ID resolve that Session, including after a CLI resume.
export type BotScheduleScope = {
  target: Extract<BotScheduleTarget, { kind: 'conversation' }>;
  ceiling: PermissionMode;
};

export function botConversationSchedules(scheduler: Scheduler, scope: () => BotScheduleScope): ScheduleControl {
  const belongs = (saved: BotScheduleTarget | undefined, target: BotScheduleScope['target']) =>
    saved?.kind === 'conversation' && saved.botId === target.botId &&
      saved.conversationId === target.conversationId && saved.threadId === target.threadId;
  const view = (row: Schedule, target: BotScheduleScope['target']) => ({ ...row, threadId: target.threadId });
  const list = (target: BotScheduleScope['target']) => scheduler.botScheduleList().filter(row => belongs(row.botTarget, target));
  const find = (key: string, target: BotScheduleScope['target']) => {
    const rows = list(target);
    const exact = rows.find(row => row.id === key);
    if (exact) return exact;
    const matching = key ? rows.filter(row => row.id.startsWith(key)) : [];
    if (matching.length === 1) return matching[0];
    throw new RpcError(ErrorCode.scheduleNotFound, matching.length ? 'Use more of the schedule ID.' : 'No schedule in this Bot conversation.');
  };
  return {
    list: async (threadId) => {
      const { target } = scope();
      return threadId && target.threadId !== threadId ? [] : list(target).map(row => view(row, target));
    },
    find: async (id) => {
      const { target } = scope();
      return view(find(id, target), target);
    },
    create: async ({ threadId, createdBy: _by, ...p }) => {
      const { target, ceiling } = scope();
      if (threadId !== target.threadId || p.check !== undefined || p.botTarget !== undefined) {
        throw new RpcError(ErrorCode.notAllowed, 'A Bot can schedule work only in its own conversation.');
      }
      return view(await scheduler.create({ ...p, botTarget: target, ceiling: lowerMode(ceiling, p.ceiling ?? 'full') }), target);
    },
    update: async p => {
      const { target } = scope();
      const current = find(p.scheduleId, target);
      if (!p.botEdit) throw new RpcError(ErrorCode.badParams, 'Read the Bot schedule before changing it.');
      return view(await scheduler.update({ ...p, scheduleId: current.id }), target);
    },
    delete: async scheduleId => {
      const { target } = scope();
      return scheduler.delete(find(scheduleId, target).id, true);
    },
  };
}
