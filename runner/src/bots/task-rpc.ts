import { z } from 'zod';
import { method } from './rpc.ts';
import { botOperationId } from './repository.ts';
import type { BotTaskThreads } from './task-threads.ts';

const id = z.object({ taskId: z.uuid() });
const write = id.extend({ expectedRevision: z.int().positive() });
const start = z.object({
  threadId: z.uuid(), title: z.string().trim().min(1).max(200), brief: z.string().trim().min(1).max(30_000),
  folder: z.string().trim().min(1).optional(), operationId: botOperationId,
});
const brief = z.string().trim().min(1).max(30_000);

export function botTaskMethods(tasks: () => BotTaskThreads): Record<string, (input: Record<string, unknown>) => unknown> {
  return {
    'bots.tasks.start': method(start, async ({ threadId, ...draft }) => ({
      task: await tasks().start(threadId, draft, async () => 'full'),
    })),
    'bots.tasks.list': method(z.object({ botId: z.uuid(), before: z.uuid().optional() }), ({ botId, before }) => tasks().list(botId, before)),
    'bots.tasks.read': method(id, ({ taskId }) => tasks().taskResult(taskId)),
    'bots.tasks.send': method(id.extend({ text: brief, operationId: botOperationId }), ({ taskId, text, operationId }) => tasks().send(taskId, text, operationId)),
    'bots.tasks.cancel': method(write, ({ taskId, expectedRevision }) => tasks().cancel(taskId, expectedRevision)),
    'bots.tasks.retry': method(write.extend({ brief, operationId: botOperationId }), async ({ taskId, expectedRevision, brief, operationId }) => ({
      task: await tasks().retry(taskId, expectedRevision, brief, operationId),
    })),
  };
}
