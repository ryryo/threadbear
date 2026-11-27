import { ConvexError } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { forbidden, ownerFenced } from './lib';
import { mayWrite, type Caller } from './runnerAccess';

export type BotWorkspaceRead = Pick<QueryCtx, 'db'>;

export function botWorkspaceOwner(ctx: BotWorkspaceRead, workspaceId: string) {
  return ctx.db.query('botWorkspaceOwners').withIndex('by_workspaceId', q => q.eq('workspaceId', workspaceId)).unique();
}

export function retiredBotSource(ctx: BotWorkspaceRead, workspaceId: string, epoch: number) {
  return ctx.db.query('botWorkspaceRetiredSources').withIndex('by_workspace_epoch',
    q => q.eq('workspaceId', workspaceId).eq('epoch', epoch)).unique();
}

type Authority = Doc<'botWorkspaceOwners'>;
type RetiredMove = Pick<NonNullable<Authority['transfer']>, 'epoch' | 'moveId' | 'sourceRunnerId'>;

export async function rememberRetiredBotSource(ctx: MutationCtx, owner: Authority, { epoch, moveId, sourceRunnerId }: RetiredMove) {
  const { workspaceId } = owner;
  const prior = await retiredBotSource(ctx, workspaceId, epoch);
  if (prior && (prior.moveId !== moveId || prior.sourceRunnerId !== sourceRunnerId)) {
    throw new ConvexError({ kind: 'conflict', message: 'The retiring Bot workspace owner does not match its recorded move.' });
  }
  if (!prior) await ctx.db.insert('botWorkspaceRetiredSources', { workspaceId, moveId, sourceRunnerId, epoch });
  const covered = owner.retiredSourcesCovered ?? 0;
  if (epoch !== covered + 1) return covered;
  await ctx.db.patch('botWorkspaceOwners', owner._id, { retiredSourcesCovered: epoch });
  return epoch;
}

export async function retiredBotSourcesErased(ctx: MutationCtx, owner: Authority, revision: number): Promise<boolean> {
  if (owner.epoch === 1) return true;
  const covered = owner.transfer?.state === 'claimed' ? await rememberRetiredBotSource(ctx, owner, owner.transfer) : owner.retiredSourcesCovered ?? 0;
  if (covered !== owner.epoch - 1) return false;
  const untouched = await ctx.db.query('botWorkspaceRetiredSources').withIndex('by_erasure_revision',
    q => q.eq('workspaceId', owner.workspaceId).eq('erasureRevision', undefined)).first();
  return !untouched && !await ctx.db.query('botWorkspaceRetiredSources').withIndex('by_erasure_revision',
    q => q.eq('workspaceId', owner.workspaceId).lt('erasureRevision', revision)).first();
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

type NoteScope = { kind: 'bot' | 'group'; id: string };

function erasuresInScope(ctx: BotWorkspaceRead, workspaceId: string, scope: NoteScope) {
  return ctx.db.query('botWorkspaceErasedNotes').withIndex('by_scope_entry',
    q => q.eq('workspaceId', workspaceId).eq('kind', scope.kind).eq('scopeId', scope.id));
}

export function botNoteErasure(ctx: BotWorkspaceRead, workspaceId: string, scope: NoteScope, entryId: string) {
  return ctx.db.query('botWorkspaceErasedNotes').withIndex('by_scope_entry',
    q => q.eq('workspaceId', workspaceId).eq('kind', scope.kind).eq('scopeId', scope.id).eq('entryId', entryId)).unique();
}

export async function botNoteErased(ctx: BotWorkspaceRead, workspaceId: string, scope: NoteScope, entryId: string): Promise<boolean> {
  return (await botNoteErasure(ctx, workspaceId, scope, entryId)) !== null;
}

export async function withoutErasedBotNotes<Row extends { id: string }>(
  ctx: BotWorkspaceRead, workspaceId: string, scope: NoteScope, rows: Row[],
): Promise<Row[]> {
  if (!rows.length) return rows;
  // A frequently published scope may have a long history. Bound the scan
  // by the current snapshot, then check exact keys if history is larger.
  const seen = await erasuresInScope(ctx, workspaceId, scope).take(rows.length + 1);
  if (seen.length <= rows.length) {
    const erased = new Set(seen.map(row => row.entryId));
    return rows.filter(row => !erased.has(row.id));
  }
  const erased = await Promise.all(rows.map(row => botNoteErased(ctx, workspaceId, scope, row.id)));
  return rows.filter((_, index) => !erased[index]);
}

type NoteReceipt = NonNullable<Doc<'commands'>['botNote']>;
type CommandWithNote = Pick<Doc<'commands'>, 'kind' | 'args' | 'botNote'>;

export function botNoteCommand(args: unknown): NoteReceipt | undefined {
  const input = args as { workspaceId?: unknown; action?: { kind?: unknown; entryId?: unknown; scope?: { kind?: unknown; id?: unknown } } } | undefined;
  const action = input?.action;
  const scope = action?.scope;
  if (typeof input?.workspaceId !== 'string' || typeof scope?.id !== 'string' ||
      (scope.kind !== 'bot' && scope.kind !== 'group')) return undefined;
  const receipt = { workspaceId: input.workspaceId, scope: { kind: scope.kind, id: scope.id } } satisfies NoteReceipt;
  if (action?.kind === 'note.add') return receipt;
  if ((action?.kind === 'note.edit' || action?.kind === 'note.remove') && typeof action.entryId === 'string') {
    return { ...receipt, entryId: action.entryId };
  }
  return undefined;
}

function noteReceipt(command: CommandWithNote): NoteReceipt | undefined {
  return command.kind === 'botDeviceAction' ? command.botNote ?? botNoteCommand(command.args) : undefined;
}

export async function erasedBotNoteCommand(ctx: BotWorkspaceRead, command: CommandWithNote): Promise<boolean> {
  const note = noteReceipt(command);
  return note?.entryId !== undefined && await botNoteErased(ctx, note.workspaceId, note.scope, note.entryId);
}

export async function safeBotNoteResult(ctx: BotWorkspaceRead, command: CommandWithNote, result: string): Promise<string> {
  const receipt = noteReceipt(command);
  if (!receipt) return result;
  const targeted = await erasedBotNoteCommand(ctx, command);
  let body: { rows?: { id: string }[]; draft?: string; outcome?: string; revision?: string } | null;
  try {
    body = JSON.parse(result);
  } catch {
    return targeted ? '{}' : result;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return targeted ? '{}' : result;
  const originalRows = Array.isArray(body.rows) && body.rows.every(row => typeof row?.id === 'string') ? body.rows : undefined;
  const rows = originalRows && await withoutErasedBotNotes(ctx, receipt.workspaceId, receipt.scope, originalRows);
  if (targeted) {
    if (body.outcome !== 'saved' && body.outcome !== 'conflict') return '{}';
    // Only return the known note result fields for the erased target.
    const revision = typeof body.revision === 'string' ? body.revision : undefined;
    return JSON.stringify({ outcome: body.outcome, revision, rows });
  }
  return rows?.length !== originalRows?.length ? JSON.stringify({ ...body, rows }) : result;
}
