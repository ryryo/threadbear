import type { FunctionArgs } from 'convex/server';
import type { api } from '../../convex/_generated/api';

type ErasureTarget = FunctionArgs<typeof api.phone.botNoteErasures>['targets'][number];
type StorageReader = Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'>;
type SavedNoteDraft = { key: string; target: ErasureTarget };

export function noteDraftTarget(workspaceId: string, value: unknown): ErasureTarget | undefined {
  const action = value as { kind?: unknown; scope?: { kind?: unknown; id?: unknown }; entryId?: unknown } | undefined;
  if ((action?.kind !== 'note.edit' && action?.kind !== 'note.remove') ||
      typeof action.entryId !== 'string' || !action.entryId || action.entryId.length > 128 ||
      typeof action.scope?.id !== 'string' || !action.scope.id || action.scope.id.length > 128 ||
      (action.scope.kind !== 'bot' && action.scope.kind !== 'group')) return undefined;
  return { workspaceId, scope: { kind: action.scope.kind, id: action.scope.id }, entryId: action.entryId };
}

export function matchesNoteTarget(a: ErasureTarget | undefined, b: ErasureTarget): boolean {
  return a?.workspaceId === b.workspaceId && a.scope.kind === b.scope.kind && a.scope.id === b.scope.id && a.entryId === b.entryId;
}

function storedTarget(storage: StorageReader, key: string): ErasureTarget | undefined {
  const parts = /^bot-action-draft:[^:]+:([^:]{1,128}):\d+:notes:(bot|group):([^:]{1,128})$/.exec(key);
  if (!parts) return undefined;
  const [, workspaceId, kind, scopeId] = parts;
  try {
    const body = JSON.parse(storage.getItem(key) ?? 'null') as { operationId?: unknown; action?: unknown } | null;
    if (typeof body?.operationId !== 'string') return undefined;
    const target = noteDraftTarget(workspaceId, body.action);
    return target?.scope.kind === kind && target.scope.id === scopeId ? target : undefined;
  } catch {
    return undefined;
  }
}

export function savedNoteDrafts(storage: StorageReader): SavedNoteDraft[] {
  const drafts: SavedNoteDraft[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key === null) continue;
    const target = storedTarget(storage, key);
    if (target) drafts.push({ key, target });
  }
  return drafts;
}

export function clearErasedDrafts(storage: StorageReader, drafts: SavedNoteDraft[], erased: readonly boolean[]): void {
  if (drafts.length !== erased.length) return;
  for (const [index, { key, target }] of drafts.entries()) {
    if (erased[index] === true && matchesNoteTarget(storedTarget(storage, key), target)) storage.removeItem(key);
  }
}
