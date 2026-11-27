import type { MutationCtx, QueryCtx } from './_generated/server';
import { forbidden, ownerFenced } from './lib';
import { mayWrite, type Caller } from './runnerAccess';

export type BotWorkspaceRead = Pick<QueryCtx, 'db'>;

export function botWorkspaceOwner(ctx: BotWorkspaceRead, workspaceId: string) {
  return ctx.db.query('botWorkspaceOwners').withIndex('by_workspaceId', q => q.eq('workspaceId', workspaceId)).unique();
}

export function ownedWorkspace(ctx: BotWorkspaceRead, runnerId: string) {
  return ctx.db.query('botWorkspaceOwners').withIndex('by_owner', q => q.eq('ownerRunnerId', runnerId)).unique();
}

export function workspaceStagedFor(ctx: BotWorkspaceRead, runnerId: string) {
  return ctx.db.query('botWorkspaceOwners').withIndex('by_bot_target',
    q => q.eq('transfer.targetRunnerId', runnerId).eq('transfer.state', 'staged')).first();
}

export async function botSchedulesFrozen(ctx: BotWorkspaceRead, runnerId: string): Promise<boolean> {
  return (await ownedWorkspace(ctx, runnerId))?.transfer?.state === 'staged';
}

export async function botRunner(ctx: BotWorkspaceRead, runnerId: string) {
  return ctx.db.query('runners').withIndex('by_runnerId', q => q.eq('runnerId', runnerId)).unique();
}

export async function requireBotRunnerProcess(ctx: MutationCtx | QueryCtx, caller: Caller, runnerId: string, startedAt: string): Promise<void> {
  const live = await botRunner(ctx, runnerId);
  if (!mayWrite(caller, runnerId, runnerId) || await ownerFenced(ctx, caller, runnerId) || !live ||
      live.box || live.draining || live.startedAt !== startedAt) throw forbidden('move this Bot workspace');
}

export async function requireBotWorkspaceWrite(ctx: MutationCtx, workspaceId: string, runnerId: string, epoch: number): Promise<void> {
  const row = await botWorkspaceOwner(ctx, workspaceId);
  if (row) {
    if (row.ownerRunnerId !== runnerId || row.epoch !== epoch || row.transfer?.state === 'staged') {
      throw forbidden('mirror a Bot workspace that this Runner no longer writes');
    }
    return;
  }
  if (epoch !== 1 || await ownedWorkspace(ctx, runnerId)) throw forbidden('register a different Bot workspace');
  await ctx.db.insert('botWorkspaceOwners', { workspaceId, ownerRunnerId: runnerId, epoch });
}
