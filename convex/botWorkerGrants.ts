import { ConvexError, v } from 'convex/values';
import { mutation, query, type QueryCtx, type MutationCtx } from './_generated/server';
import { botWorkerGrant, botWorkerResult } from './botWorkerValues';
import { botWorkspaceOwner, ownedWorkspace, requireBotRunnerProcess, workspaceStagedFor } from './botWorkspaceAuthority';
import { queued } from './machines';
import { forbidden, runnerAuth, sha256 } from './lib';

const GRANT_TTL = 15 * 60_000;
const MAX_SEALED = 96_000;
const GRANT_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const processArgs = { key: v.string(), runnerId: v.string(), startedAt: v.string() };
const workerArgs = { ...processArgs, workspaceId: v.string(), requestId: v.string() };
const issueReceipt = v.object({ requestId: v.string(), commandId: v.id('commands') });

function find(ctx: Pick<QueryCtx, 'db'>, workspaceId: string, requestId: string) {
  return ctx.db.query('botWorkerJobs').withIndex('by_request', q => q.eq('workspaceId', workspaceId).eq('requestId', requestId)).unique();
}

async function activeOwner(ctx: QueryCtx | MutationCtx, workspaceId: string, epoch: number, runnerId?: string) {
  const owner = await botWorkspaceOwner(ctx, workspaceId);
  if (!owner || owner.epoch !== epoch || owner.transfer?.state === 'staged' || runnerId !== undefined && owner.ownerRunnerId !== runnerId) {
    throw forbidden('use a grant from this Bot workspace');
  }
  return owner;
}

const sealKey = /^[a-zA-Z0-9+/]{43}=$/;

function workerTarget(ctx: Pick<QueryCtx, 'db'>, runnerId: string) {
  return ctx.db.query('botWorkerTargets').withIndex('by_runnerId', q => q.eq('runnerId', runnerId)).unique();
}

async function targetKey(ctx: Pick<QueryCtx, 'db'>, runnerId: string): Promise<string | null> {
  const target = await ctx.db.query('runners').withIndex('by_runnerId', q => q.eq('runnerId', runnerId)).unique();
  if (!target || target.box || target.draining || target.lastSeenAt < Date.now() - 180_000) return null;
  const binding = await workerTarget(ctx, runnerId);
  return binding?.startedAt === target.startedAt ? binding.sealingKey : null;
}

export const advertise = mutation({
  args: { ...processArgs, sealingKey: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, startedAt, sealingKey }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'advertiseBotWorker'), runnerId, startedAt);
    if (!sealKey.test(sealingKey)) throw new ConvexError({ kind: 'badArgs', message: 'A Bot worker needs a sealing key.' });
    const binding = await workerTarget(ctx, runnerId);
    if (binding) await ctx.db.patch('botWorkerTargets', binding._id, { startedAt, sealingKey });
    else await ctx.db.insert('botWorkerTargets', { runnerId, startedAt, sealingKey });
    return null;
  },
});

export const target = query({
  args: { ...processArgs, workspaceId: v.string(), epoch: v.number(), targetRunnerId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, epoch, targetRunnerId }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'getBotWorkerTarget'), runnerId, startedAt);
    await activeOwner(ctx, workspaceId, epoch, runnerId);
    return targetRunnerId === runnerId ? null : targetKey(ctx, targetRunnerId);
  },
});

export const targets = query({
  args: { ...processArgs, workspaceId: v.string(), epoch: v.number(), forMove: v.boolean() },
  returns: v.array(v.object({ id: v.string(), name: v.string() })),
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, epoch, forMove }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'listBotWorkerTargets'), runnerId, startedAt);
    await activeOwner(ctx, workspaceId, epoch, runnerId);
    const recent = await ctx.db.query('runners').withIndex('by_last_seen',
      q => q.gte('lastSeenAt', Date.now() - 180_000)).order('desc').take(128);
    const rows = await Promise.all(recent.map(async row => {
      if (row.runnerId === runnerId || row.box || row.draining) return [];
      if ((await workerTarget(ctx, row.runnerId))?.startedAt !== row.startedAt) return [];
      if (forMove && (await ownedWorkspace(ctx, row.runnerId) || await workspaceStagedFor(ctx, row.runnerId))) return [];
      return [{ id: row.runnerId, name: row.name }];
    }));
    return rows.flat();
  },
});

export const issue = mutation({
  args: { ...processArgs, grant: botWorkerGrant },
  returns: issueReceipt,
  handler: async (ctx, { key, runnerId, startedAt, grant }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'issueBotWorkerGrant'), runnerId, startedAt);
    await activeOwner(ctx, grant.workspaceId, grant.epoch, runnerId);
    const fingerprint = await sha256(JSON.stringify(Object.entries(grant).sort()));
    const prior = await find(ctx, grant.workspaceId, grant.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ConvexError({ kind: 'conflict', message: 'This request ID already belongs to a different Bot grant.' });
      return { requestId: prior.requestId, commandId: prior.commandId };
    }
    if (![grant.requestId, grant.workerThread, grant.botId, grant.threadId].every(id => GRANT_ID.test(id)) ||
        grant.targetRunnerId === runnerId || grant.workerThread === grant.threadId ||
        !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + GRANT_TTL ||
        !Number.isSafeInteger(grant.profileRevision) || grant.profileRevision < 1 ||
        grant.sealed.length > MAX_SEALED || !/^[a-zA-Z0-9+/_=-]+$/.test(grant.sealed)) {
      throw new ConvexError({ kind: 'badArgs', message: 'A Bot worker needs a bounded sealed input and a different Runner.' });
    }
    const source = await ctx.db.query('threads').withIndex('by_threadId', q => q.eq('threadId', grant.threadId)).unique();
    const projection = await ctx.db.query('botWorkspaces').withIndex('by_runnerId', q => q.eq('runnerId', runnerId)).unique();
    if (source?.runnerId !== runnerId || source.botLink?.botId !== grant.botId ||
        !projection?.workspace.profiles.some(bot => bot.id === grant.botId && bot.revision === grant.profileRevision)) {
      throw forbidden('run work from an unavailable Bot or Thread');
    }
    const target = await targetKey(ctx, grant.targetRunnerId);
    const collision = await ctx.db.query('threads').withIndex('by_threadId', q => q.eq('threadId', grant.workerThread)).unique();
    const otherGrant = await ctx.db.query('botWorkerJobs').withIndex('by_workerThread', q => q.eq('workerThread', grant.workerThread)).unique();
    if (!target || collision || otherGrant) throw forbidden('bind this Runner or Thread to a Bot grant');
    const active = await ctx.db.query('botWorkerJobs').withIndex('by_workspace_state',
      q => q.eq('workspaceId', grant.workspaceId).eq('state', 'running')).take(4);
    const waiting = await ctx.db.query('botWorkerJobs').withIndex('by_workspace_state',
      q => q.eq('workspaceId', grant.workspaceId).eq('state', 'queued').gt('expiresAt', Date.now())).take(4);
    if (active.length + waiting.length >= 4) throw new ConvexError({ kind: 'tooMany', message: 'The Bot workspace has reached its worker limit.' });
    const commandId = await queued(ctx, {
      runnerId: grant.targetRunnerId, kind: 'botWorker', args: { workspaceId: grant.workspaceId, requestId: grant.requestId }, createdAt: Date.now(),
    });
    await ctx.db.insert('botWorkerJobs', {
      ...grant, ownerRunnerId: runnerId, fingerprint, commandId, state: 'queued',
    });
    return { requestId: grant.requestId, commandId };
  },
});

export const take = mutation({
  args: { ...workerArgs, attempt: v.string() },
  returns: v.union(v.null(), v.object({ ...botWorkerGrant.fields, ownerRunnerId: v.string() })),
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, requestId, attempt }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'takeBotWorkerGrant'), runnerId, startedAt);
    const row = await find(ctx, workspaceId, requestId);
    if (!row || runnerId !== row.targetRunnerId) throw forbidden('take this Bot worker request');
    await activeOwner(ctx, workspaceId, row.epoch, row.ownerRunnerId);
    if (!GRANT_ID.test(attempt)) throw new ConvexError({ kind: 'badArgs', message: 'A Bot worker needs an attempt ID.' });
    if (row.state === 'done' || row.state === 'queued' && row.expiresAt <= Date.now() ||
        row.state === 'running' && row.attempt !== attempt) return null;
    if (row.state === 'queued') await ctx.db.patch('botWorkerJobs', row._id, { state: 'running', attempt });
    const { epoch, botId, threadId, targetRunnerId, workerThread, profileRevision, ceiling, expiresAt, sealed } = row;
    return { workspaceId, requestId, ownerRunnerId: row.ownerRunnerId, epoch, botId, threadId, targetRunnerId, workerThread, profileRevision, ceiling, expiresAt, sealed };
  },
});

export const complete = mutation({
  args: { ...workerArgs, attempt: v.string(), threadId: v.string(), seq: v.number() },
  returns: botWorkerResult,
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, requestId, threadId, seq, attempt }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'completeBotWorkerGrant'), runnerId, startedAt);
    const row = await find(ctx, workspaceId, requestId);
    if (!row || runnerId !== row.targetRunnerId || threadId !== row.workerThread || row.attempt !== attempt || !Number.isSafeInteger(seq) || seq < 1) {
      throw forbidden('finish this Bot worker request');
    }
    if (row.result) {
      if (seq !== row.result.seq) throw new ConvexError({ kind: 'conflict', message: 'This Bot worker has a saved result.' });
      return row.result;
    }
    await activeOwner(ctx, workspaceId, row.epoch, row.ownerRunnerId);
    const thread = await ctx.db.query('threads').withIndex('by_threadId', q => q.eq('threadId', threadId)).unique();
    if (!thread || thread.runnerId !== runnerId) throw new ConvexError({ kind: 'notFound', message: 'The worker Thread is not ready.' });
    const result = { resultId: `${workspaceId}:${requestId}`, threadId, seq };
    await ctx.db.patch('botWorkerJobs', row._id, { state: 'done', result, sealed: '' });
    return result;
  },
});

async function requireHistoryOwner(ctx: QueryCtx, workspaceId: string, runnerId: string): Promise<void> {
  const owner = await botWorkspaceOwner(ctx, workspaceId);
  if (owner?.ownerRunnerId !== runnerId || owner.transfer?.state === 'staged') throw forbidden('read this Bot worker history');
}

export const result = query({
  args: { ...workerArgs, threadId: v.string() },
  returns: v.union(v.null(), botWorkerResult),
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, requestId, threadId }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'readBotWorkerResult'), runnerId, startedAt);
    await requireHistoryOwner(ctx, workspaceId, runnerId);
    const row = await find(ctx, workspaceId, requestId);
    return row?.threadId === threadId ? row.result ?? null : null;
  },
});

export const history = query({
  args: { ...processArgs, workspaceId: v.string(), threadId: v.string() },
  returns: v.array(v.object({
    requestId: v.string(), targetRunnerId: v.string(), result: v.optional(botWorkerResult),
    state: v.union(v.literal('queued'), v.literal('running'), v.literal('done'), v.literal('expired')),
  })),
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, threadId }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'readBotWorkerHistory'), runnerId, startedAt);
    await requireHistoryOwner(ctx, workspaceId, runnerId);
    const rows = await ctx.db.query('botWorkerJobs').withIndex('by_source', q => q.eq('workspaceId', workspaceId).eq('threadId', threadId))
      .order('desc').take(20);
    const now = Date.now();
    return rows.map(row => ({
      requestId: row.requestId, targetRunnerId: row.targetRunnerId,
      state: row.state === 'queued' && row.expiresAt <= now ? 'expired' as const : row.state,
      ...(row.result ? { result: row.result } : {}),
    }));
  },
});
