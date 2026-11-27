// Workspace ownership changes once, in the claim mutation, as for a Thread
// move. A Runner may restart and repeat a transition with the same move ID.
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, mutation, query } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { botScheduleRevision } from './botScheduleValues';
import { botNoteScope } from './botWorkspaceValues';
import { forbidden, runnerAuth } from './lib';
import { botNoteErasure, botRunner, botWorkspaceOwner, ownedWorkspace, rememberRetiredBotSource, requireBotRunnerProcess, retiredBotSource, workspaceStagedFor as stagedFor, type BotWorkspaceRead } from './botWorkspaceAuthority';
import { claimBotWorkspaceThread, checkBotWorkspaceThread } from './moves';
import { isThreadId } from './runnerAccess';
import { syncWake } from './wakes';

type Authority = Doc<'botWorkspaceOwners'>;
type Transfer = NonNullable<Authority['transfer']>;

const PART_BYTES = 192 * 1024;
const MAX_SEALED_BYTES = 100 * 1024 * 1024;
const digest = /^[a-f0-9]{64}$/;
const baselineRunner = { key: v.string(), runnerId: v.string(), startedAt: v.string() };

const runnerArgs = { ...baselineRunner, workspaceId: v.string(), moveId: v.string() };
const result = v.object({
  state: v.union(v.literal('staged'), v.literal('claimed'), v.literal('cancelled')),
  workspaceId: v.string(), moveId: v.string(), ownerRunnerId: v.string(), epoch: v.number(),
});
type ScheduleRevision = { id: string; updatedAt: string };

async function scheduleRows(ctx: MutationCtx, runnerId: string, expected: readonly ScheduleRevision[]) {
  const rows = await ctx.db.query('schedules').withIndex('by_runner_owned_bot',
    q => q.eq('runnerId', runnerId).eq('owned', true).gt('botTarget.kind', undefined)).take(513);
  const revision = new Map(expected.map(s => [s.id, s.updatedAt]));
  if (rows.length !== revision.size || rows.some(row => revision.get(row.id) !== row.updatedAt)) {
    throw new ConvexError({ kind: 'conflict', message: 'Bot reservations changed or have not all synced. Refresh them before moving.' });
  }
  if (rows.some(row => row.claim || row.runRequestedAt)) {
    throw new ConvexError({ kind: 'busy', message: 'Wait for the Bot reservations’ current runs to settle.' });
  }
  return rows;
}

export const destinationProjects = query({
  args: { ...baselineRunner, workspaceId: v.string(), epoch: v.number(), targetRunnerId: v.string() },
  returns: v.array(v.object({ id: v.string(), title: v.string() })),
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, epoch, targetRunnerId }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'previewBotWorkspaceMove'), runnerId, startedAt);
    const owner = await botWorkspaceOwner(ctx, workspaceId);
    if (owner?.ownerRunnerId !== runnerId || owner.epoch !== epoch || owner.transfer?.state === 'staged') {
      throw forbidden('preview the destination of this Bot workspace');
    }
    const target = await botRunner(ctx, targetRunnerId);
    if (targetRunnerId === runnerId || !target || target.box || target.draining ||
        target.lastSeenAt < Date.now() - 180_000 || await ownedWorkspace(ctx, targetRunnerId) || await stagedFor(ctx, targetRunnerId)) {
      throw new ConvexError({ kind: 'unavailable', message: 'The target Runner cannot receive a Bot workspace.' });
    }
    const rows = await ctx.db.query('projectHeads').withIndex('by_runnerId', q => q.eq('runnerId', targetRunnerId)).take(2048);
    return rows.filter(row => !row.archived).map(({ id, title }) => ({ id, title }));
  },
});

function receipt(row: Authority, moveId: string, state: NonNullable<Authority['transfer']>['state']) {
  return { state, moveId, workspaceId: row.workspaceId, ownerRunnerId: row.ownerRunnerId, epoch: row.epoch };
}

function cancelledMove(ctx: BotWorkspaceRead, workspaceId: string, moveId: string) {
  return ctx.db.query('botWorkspaceMoveCancellations').withIndex('by_move',
    q => q.eq('workspaceId', workspaceId).eq('moveId', moveId)).unique();
}

function claimedMove(ctx: BotWorkspaceRead, workspaceId: string, moveId: string) {
  return ctx.db.query('botWorkspaceRetiredSources').withIndex('by_move',
    q => q.eq('workspaceId', workspaceId).eq('moveId', moveId)).first();
}

function queueDiscard(ctx: MutationCtx, workspaceId: string, moveId: string) {
  return ctx.scheduler.runAfter(0, internal.botWorkspaceMoves.discardSealedBotWorkspace, { workspaceId, moveId });
}

export const discardSealedBotWorkspace = internalMutation({
  args: { workspaceId: v.string(), moveId: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, moveId }) => {
    const move = (await botWorkspaceOwner(ctx, workspaceId))?.transfer;
    if (move?.moveId === moveId && move.state === 'staged') return null;
    if (move?.moveId !== moveId && !await claimedMove(ctx, workspaceId, moveId) &&
        !await cancelledMove(ctx, workspaceId, moveId)) return null;
    // Each row holds a base64 part. Sixteen rows fit comfortably in a
    // transaction even when each part is full.
    const parts = await ctx.db.query('botWorkspaceParts').withIndex('by_part',
      q => q.eq('workspaceId', workspaceId).eq('moveId', moveId)).take(16);
    for (const part of parts) await ctx.db.delete('botWorkspaceParts', part._id);
    if (parts.length === 16) await queueDiscard(ctx, workspaceId, moveId);
    return null;
  },
});

function cancelledReceipt(move: Omit<Doc<'botWorkspaceMoveCancellations'>, '_id' | '_creationTime'>) {
  return { state: 'cancelled' as const, moveId: move.moveId, workspaceId: move.workspaceId,
    ownerRunnerId: move.sourceRunnerId, epoch: move.epoch };
}

function verifyNoteErasureRevision(row: Authority, revision: number | undefined): void {
  if ((row.noteErasureRevision ?? 0) !== (revision ?? 0)) {
    throw new ConvexError({ kind: 'conflict', message: 'The Bot workspace’s note erasures must be checked again before moving.' });
  }
}

export const verifyBotWorkspaceNoteErasures = query({
  args: { ...baselineRunner, workspaceId: v.string(), moveId: v.optional(v.string()), cursor: v.optional(v.string()) },
  returns: v.object({ revision: v.number(), epoch: v.number(), ownerRunnerId: v.string(),
    rows: v.array(v.object({ scope: botNoteScope, entryId: v.string() })),
    cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, moveId, cursor }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'verifyBotWorkspaceNoteErasures'), runnerId, startedAt);
    const owner = await botWorkspaceOwner(ctx, workspaceId);
    const move = owner?.transfer;
    if (!owner || (owner.ownerRunnerId !== runnerId &&
        (!move || !moveId || move.moveId !== moveId || move.state !== 'staged' || move.targetRunnerId !== runnerId))) {
      throw forbidden('read the erasures for this Bot workspace');
    }
    const page = await ctx.db.query('botWorkspaceErasedNotes').withIndex('by_scope_entry', q => q.eq('workspaceId', workspaceId))
      .paginate({ numItems: 128, cursor: cursor ?? null });
    return { revision: owner.noteErasureRevision ?? 0, epoch: owner.epoch, ownerRunnerId: owner.ownerRunnerId,
      cursor: page.isDone ? null : page.continueCursor,
      rows: page.page.map(row => ({ scope: { kind: row.kind, id: row.scopeId }, entryId: row.entryId })) };
  },
});

const retiredArgs = { ...runnerArgs, epoch: v.number() };
const erasureItem = { revision: v.number(), scope: botNoteScope, entryId: v.string() };

async function requireRetiredSource(ctx: BotWorkspaceRead, { workspaceId, moveId, runnerId, epoch }: {
  workspaceId: string; moveId: string; runnerId: string; epoch: number;
}): Promise<void> {
  const owner = await botWorkspaceOwner(ctx, workspaceId);
  const source = await retiredBotSource(ctx, workspaceId, epoch);
  if (!owner || owner.epoch <= epoch || owner.ownerRunnerId === runnerId ||
      source?.sourceRunnerId !== runnerId || source.moveId !== moveId) {
    throw forbidden('read this retired Bot workspace’s erasures');
  }
}

function retiredNoteReceipt(ctx: BotWorkspaceRead, erasureId: Doc<'botWorkspaceErasedNotes'>['_id'], epoch: number) {
  return ctx.db.query('botWorkspaceRetiredNoteReceipts').withIndex('by_erasure_epoch',
    q => q.eq('erasureId', erasureId).eq('epoch', epoch)).unique();
}

export const retiredNoteErasure = query({
  args: { ...retiredArgs, cursor: v.optional(v.string()) },
  returns: v.object({ items: v.array(v.object(erasureItem)), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { key, startedAt, cursor, ...locator }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'retiredBotNoteErasure'), locator.runnerId, startedAt);
    await requireRetiredSource(ctx, locator);
    const page = await ctx.db.query('botWorkspaceErasedNotes').withIndex('by_scope_entry', q => q.eq('workspaceId', locator.workspaceId))
      .paginate({ numItems: 16, cursor: cursor ?? null });
    const items = await Promise.all(page.page.map(async row => {
      if (await retiredNoteReceipt(ctx, row._id, locator.epoch)) return null;
      return { revision: row.revision ?? 0, scope: { kind: row.kind, id: row.scopeId }, entryId: row.entryId };
    }));
    return { items: items.filter(row => row !== null), cursor: page.isDone ? null : page.continueCursor };
  },
});

export const ackRetiredNoteErasure = mutation({
  args: { ...retiredArgs, ...erasureItem },
  returns: v.boolean(),
  handler: async (ctx, { key, startedAt, revision, scope, entryId, ...locator }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'ackRetiredBotNoteErasure'), locator.runnerId, startedAt);
    await requireRetiredSource(ctx, locator);
    const erasure = await botNoteErasure(ctx, locator.workspaceId, scope, entryId);
    if (!erasure || (erasure.revision ?? 0) !== revision) return false;
    if (await retiredNoteReceipt(ctx, erasure._id, locator.epoch)) return true;
    const sealed = await ctx.db.query('botWorkspaceParts').withIndex('by_part',
      q => q.eq('workspaceId', locator.workspaceId).eq('moveId', locator.moveId)).first();
    if (sealed) {
      await queueDiscard(ctx, locator.workspaceId, locator.moveId);
      return false;
    }
    await ctx.db.insert('botWorkspaceRetiredNoteReceipts', { erasureId: erasure._id, epoch: locator.epoch });
    await ctx.db.patch('botWorkspaceErasedNotes', erasure._id, { retiredSourceReceipts: (erasure.retiredSourceReceipts ?? 0) + 1 });
    return true;
  },
});

export const begin = mutation({
  args: { ...runnerArgs, targetRunnerId: v.string(), epoch: v.number(), checksum: v.string(), sealedChecksum: v.string(), bytes: v.number(), parts: v.number(), threadIds: v.array(v.string()), schedules: v.optional(v.array(botScheduleRevision)), noteErasureRevision: v.optional(v.number()) },
  returns: result,
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, moveId, targetRunnerId, epoch, checksum, sealedChecksum, bytes, parts, threadIds, schedules = [], noteErasureRevision }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'beginBotWorkspaceMove'), runnerId, startedAt);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(moveId) || !digest.test(checksum) || !digest.test(sealedChecksum) ||
        !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_SEALED_BYTES || parts !== Math.ceil(bytes / PART_BYTES) || targetRunnerId === runnerId) {
      throw new ConvexError({ kind: 'badArgs', message: 'The workspace move needs a different Runner and a manifest checksum.' });
    }
    const row = await botWorkspaceOwner(ctx, workspaceId);
    if (!row) throw forbidden('move an unknown Bot workspace');
    const cancelled = await cancelledMove(ctx, workspaceId, moveId);
    if (cancelled) {
      if (cancelled.sourceRunnerId !== runnerId || cancelled.targetRunnerId !== targetRunnerId || cancelled.epoch !== epoch) {
        throw forbidden('resume a cancelled Bot workspace move');
      }
      return cancelledReceipt(cancelled);
    }
    const prior = row.transfer;
    const ids = [...new Set(threadIds)].sort();
    if (ids.length !== threadIds.length || ids.length > 512 || !ids.every(isThreadId)) {
      throw new ConvexError({ kind: 'badArgs', message: 'The Bot workspace move contains invalid Thread identities.' });
    }
    if (schedules.length > 512 || new Set(schedules.map(s => s.id)).size !== schedules.length ||
        schedules.some(s => !/^[a-zA-Z0-9_-]{1,128}$/.test(s.id) || s.updatedAt.length > 64)) {
      throw new ConvexError({ kind: 'badArgs', message: 'The Bot workspace move contains invalid reservation revisions.' });
    }
    const revisions = schedules.map(({ id, updatedAt }) => ({ id, updatedAt })).sort((a, b) => a.id.localeCompare(b.id));
    if (prior?.moveId === moveId && prior.sourceRunnerId === runnerId && prior.targetRunnerId === targetRunnerId &&
        prior.checksum === checksum && prior.epoch === epoch && prior.sealedChecksum === sealedChecksum && prior.bytes === bytes &&
        JSON.stringify(prior.threadIds) === JSON.stringify(ids) && JSON.stringify(prior.schedules ?? []) === JSON.stringify(revisions)) {
      if (prior.state === 'staged') verifyNoteErasureRevision(row, noteErasureRevision);
      return receipt(row, moveId, prior.state);
    }
    if (row.ownerRunnerId !== runnerId || row.epoch !== epoch || prior?.state === 'staged') throw forbidden('move a Bot workspace already owned or staged elsewhere');
    if (prior?.moveId === moveId || await claimedMove(ctx, workspaceId, moveId)) {
      throw new ConvexError({ kind: 'conflict', message: 'Use a new ID for a new Bot workspace move.' });
    }
    verifyNoteErasureRevision(row, noteErasureRevision);
    const target = await botRunner(ctx, targetRunnerId);
    if (!target || target.box || target.draining || await ownedWorkspace(ctx, targetRunnerId) ||
        await stagedFor(ctx, targetRunnerId)) {
      throw new ConvexError({ kind: 'unavailable', message: 'The target Runner cannot receive a Bot workspace.' });
    }
    const running = await ctx.db.query('botWorkerJobs').withIndex('by_workspace_state',
      q => q.eq('workspaceId', workspaceId).eq('state', 'running')).first();
    const waiting = await ctx.db.query('botWorkerJobs').withIndex('by_workspace_state',
      q => q.eq('workspaceId', workspaceId).eq('state', 'queued').gt('expiresAt', Date.now())).first();
    if (running || waiting) throw new ConvexError({ kind: 'busy', message: 'The Bot workspace still has worker requests.' });
    await scheduleRows(ctx, runnerId, revisions);
    if (prior) {
      if (prior.state === 'claimed') await rememberRetiredBotSource(ctx, row, prior);
      await queueDiscard(ctx, workspaceId, prior.moveId);
    }
    await ctx.db.patch('botWorkspaceOwners', row._id, {
      transfer: { moveId, sourceRunnerId: runnerId, targetRunnerId, epoch, checksum, sealedChecksum, bytes, parts, stored: 0, threadIds: ids, schedules: revisions, state: 'staged' },
    });
    const projection = await ctx.db.query('botWorkspaces').withIndex('by_runnerId', q => q.eq('runnerId', runnerId)).unique();
    if (projection) await ctx.db.delete('botWorkspaces', projection._id);
    return receipt(row, moveId, 'staged');
  },
});

const partArgs = { ...runnerArgs, index: v.number() };

function transferPart(ctx: BotWorkspaceRead, workspaceId: string, moveId: string, index: number) {
  return ctx.db.query('botWorkspaceParts').withIndex('by_part',
    q => q.eq('workspaceId', workspaceId).eq('moveId', moveId).eq('index', index)).unique();
}

function validPart(transfer: Transfer, index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= transfer.parts) {
    throw new ConvexError({ kind: 'badArgs', message: 'The Bot workspace pack part is out of range.' });
  }
}

export const putPart = mutation({
  args: { ...partArgs, data: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, moveId, index, data }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'putBotWorkspacePart'), runnerId, startedAt);
    const row = await botWorkspaceOwner(ctx, workspaceId);
    const move = row?.transfer;
    if (!row || !move || move.moveId !== moveId || move.state !== 'staged' || runnerId !== move.sourceRunnerId) {
      throw forbidden('upload this Bot workspace pack');
    }
    validPart(move, index);
    const length = Math.min(PART_BYTES, move.bytes - index * PART_BYTES);
    const padding = length % 3 ? 3 - length % 3 : 0;
    if (data.length !== Math.ceil(length / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) ||
        data.length - data.replace(/=+$/, '').length !== padding) {
      throw new ConvexError({ kind: 'badArgs', message: 'The Bot workspace pack part does not have its declared size.' });
    }
    const prior = await transferPart(ctx, workspaceId, moveId, index);
    if (prior) {
      if (prior.data !== data) throw new ConvexError({ kind: 'conflict', message: 'This part was uploaded with different data.' });
      return null;
    }
    await ctx.db.insert('botWorkspaceParts', { workspaceId, moveId, index, data });
    await ctx.db.patch('botWorkspaceOwners', row._id, { transfer: { ...move, stored: move.stored + 1 } });
    return null;
  },
});

export const part = query({
  args: partArgs,
  returns: v.string(),
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, moveId, index }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'readBotWorkspacePart'), runnerId, startedAt);
    const move = (await botWorkspaceOwner(ctx, workspaceId))?.transfer;
    if (!move || move.moveId !== moveId || move.state !== 'staged' || runnerId !== move.targetRunnerId) {
      throw forbidden('download this Bot workspace pack');
    }
    validPart(move, index);
    const row = await transferPart(ctx, workspaceId, moveId, index);
    if (move.stored !== move.parts || !row) throw new ConvexError({ kind: 'conflict', message: 'The Bot workspace pack is still arriving.' });
    return row.data;
  },
});

const movePlan = v.object({
  workspaceId: v.string(), moveId: v.string(), sourceRunnerId: v.string(), targetRunnerId: v.string(), epoch: v.number(),
  checksum: v.string(), sealedChecksum: v.string(), parts: v.number(), bytes: v.number(), threadIds: v.array(v.string()),
  schedules: v.optional(v.array(botScheduleRevision)),
});

export const pending = query({
  args: baselineRunner,
  returns: v.union(v.null(), movePlan),
  handler: async (ctx, { key, runnerId, startedAt }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'pendingBotWorkspaceMove'), runnerId, startedAt);
    const row = await stagedFor(ctx, runnerId);
    if (!row?.transfer || row.transfer.stored !== row.transfer.parts) return null;
    const { moveId, sourceRunnerId, targetRunnerId, epoch, checksum, sealedChecksum, parts, bytes, threadIds, schedules } = row.transfer;
    return { workspaceId: row.workspaceId, moveId, sourceRunnerId, targetRunnerId, epoch, checksum, sealedChecksum, parts, bytes, threadIds, schedules: schedules ?? [] };
  },
});

export const state = query({
  args: runnerArgs,
  returns: v.union(v.null(), result),
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, moveId }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'stateBotWorkspaceMove'), runnerId, startedAt);
    const cancelled = await cancelledMove(ctx, workspaceId, moveId);
    if (cancelled) {
      if (runnerId !== cancelled.sourceRunnerId && runnerId !== cancelled.targetRunnerId) throw forbidden('inspect this Bot workspace move');
      return cancelledReceipt(cancelled);
    }
    const row = await botWorkspaceOwner(ctx, workspaceId);
    const move = row?.transfer;
    if (!row || !move || move.moveId !== moveId) return null;
    if (runnerId !== move.sourceRunnerId && runnerId !== move.targetRunnerId) throw forbidden('inspect this Bot workspace move');
    return receipt(row, moveId, move.state);
  },
});

export const claim = mutation({
  args: { ...runnerArgs, checksum: v.string(), noteErasureRevision: v.optional(v.number()) },
  returns: result,
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, moveId, checksum, noteErasureRevision }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'claimBotWorkspaceMove'), runnerId, startedAt);
    const row = await botWorkspaceOwner(ctx, workspaceId);
    const move = row?.transfer;
    if (!row || !move || move.moveId !== moveId || move.targetRunnerId !== runnerId || move.checksum !== checksum) {
      throw forbidden('claim this Bot workspace');
    }
    if (move.state === 'claimed') {
      await rememberRetiredBotSource(ctx, row, move);
      await queueDiscard(ctx, workspaceId, moveId);
      return receipt(row, moveId, 'claimed');
    }
    verifyNoteErasureRevision(row, noteErasureRevision);
    if (move.state !== 'staged' || row.ownerRunnerId !== move.sourceRunnerId || row.epoch !== move.epoch ||
        await ownedWorkspace(ctx, runnerId)) throw forbidden('claim a Bot workspace whose saved owner has changed');
    if (move.stored !== move.parts) throw new ConvexError({ kind: 'conflict', message: 'The Bot workspace pack is still arriving.' });
    const schedules = await scheduleRows(ctx, move.sourceRunnerId, move.schedules ?? []);
    const members = await Promise.all(move.threadIds.map(id => checkBotWorkspaceThread(ctx, move.sourceRunnerId, id)));
    for (const thread of members) await claimBotWorkspaceThread(ctx, {
      workspaceId, moveId, from: move.sourceRunnerId, to: runnerId,
    }, thread.threadId);
    const updatedMs = Date.now();
    for (const schedule of schedules) {
      await ctx.db.insert('scheduleGone', { id: schedule.id, runnerId: move.sourceRunnerId, at: updatedMs });
      await ctx.db.patch('schedules', schedule._id, { runnerId, updatedMs });
      await syncWake(ctx, { ...schedule, runnerId });
    }
    const next = { ownerRunnerId: runnerId, epoch: row.epoch + 1 };
    await rememberRetiredBotSource(ctx, row, move);
    await ctx.db.patch('botWorkspaceOwners', row._id, { ...next, transfer: { ...move, state: 'claimed' } });
    await queueDiscard(ctx, workspaceId, moveId);
    return receipt({ ...row, ...next }, moveId, 'claimed');
  },
});

export const cancel = mutation({
  args: { ...runnerArgs, targetRunnerId: v.optional(v.string()), epoch: v.optional(v.number()) },
  returns: result,
  handler: async (ctx, { key, runnerId, startedAt, workspaceId, moveId, targetRunnerId, epoch }) => {
    await requireBotRunnerProcess(ctx, await runnerAuth(ctx, key, 'cancelBotWorkspaceMove'), runnerId, startedAt);
    const prior = await cancelledMove(ctx, workspaceId, moveId);
    if (prior) {
      if (prior.sourceRunnerId !== runnerId || (epoch !== undefined && epoch !== prior.epoch) ||
          (targetRunnerId !== undefined && targetRunnerId !== prior.targetRunnerId)) throw forbidden('cancel this Bot workspace move');
      return cancelledReceipt(prior);
    }
    const row = await botWorkspaceOwner(ctx, workspaceId);
    if (!row || row.ownerRunnerId !== runnerId) throw forbidden('resume this Bot workspace');
    const move = row.transfer?.moveId === moveId ? row.transfer : undefined;
    const target = move?.targetRunnerId ?? targetRunnerId;
    if (!target || target === runnerId || !/^[a-zA-Z0-9_-]{1,100}$/.test(moveId) ||
        (epoch !== undefined && epoch !== row.epoch) || (targetRunnerId !== undefined && targetRunnerId !== target) ||
        (move ? move.sourceRunnerId !== runnerId || move.epoch !== row.epoch || move.state === 'claimed' :
          epoch !== row.epoch || row.transfer?.state === 'staged')) throw forbidden('resume this Bot workspace');
    const cancelled = { moveId, workspaceId, sourceRunnerId: runnerId, targetRunnerId: target, epoch: row.epoch };
    await ctx.db.insert('botWorkspaceMoveCancellations', cancelled);
    if (move?.state === 'staged') await ctx.db.patch('botWorkspaceOwners', row._id, { transfer: { ...move, state: 'cancelled' } });
    if (move) await queueDiscard(ctx, workspaceId, moveId);
    return cancelledReceipt(cancelled);
  },
});
