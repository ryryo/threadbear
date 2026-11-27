import { v } from 'convex/values';

export const botWorkerGrant = v.object({
  workspaceId: v.string(), epoch: v.number(), botId: v.string(),
  threadId: v.string(), targetRunnerId: v.string(), workerThread: v.string(),
  requestId: v.string(), profileRevision: v.number(),
  ceiling: v.union(v.literal('ask'), v.literal('auto'), v.literal('full')),
  expiresAt: v.number(), sealed: v.string(),
});

export const botWorkerResult = v.object({ resultId: v.string(), threadId: v.string(), seq: v.number() });
