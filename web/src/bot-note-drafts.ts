import type { FunctionArgs } from 'convex/server';
import type { api } from '../../convex/_generated/api';

export type ErasureTarget = FunctionArgs<typeof api.phone.botNoteErasures>['targets'][number];
type StorageReader = Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'>;
type StorageWriter = StorageReader & Pick<Storage, 'setItem'>;
type SavedNoteDraft = { key: string; target: ErasureTarget };
type DraftRecord = { operationId: string; action: unknown };
const STORE_ID = 'bot-note-draft-store-id';
const COPY_PREFIX = 'bot-note-draft-copy:';
const ERASED_PREFIX = 'bot-note-draft-erased:';

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

function keyTarget(key: string, value: unknown): ErasureTarget | undefined {
  const parts = /^bot-action-draft:[^:]+:([^:]{1,128}):\d+:notes:(bot|group):([^:]{1,128})$/.exec(key);
  if (!parts) return undefined;
  const [, workspaceId, kind, scopeId] = parts;
  const body = value as Partial<DraftRecord> | null;
  if (typeof body?.operationId !== 'string') return undefined;
  const target = noteDraftTarget(workspaceId, body.action);
  return target?.scope.kind === kind && target.scope.id === scopeId ? target : undefined;
}

function readJSON(storage: StorageReader, key: string): unknown {
  try { return JSON.parse(storage.getItem(key) ?? 'null') as unknown; }
  catch { return null; }
}

function storedTarget(storage: StorageReader, key: string): ErasureTarget | undefined {
  return keyTarget(key, readJSON(storage, key));
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

function erasureKey({ workspaceId, scope, entryId }: ErasureTarget): string {
  return ERASED_PREFIX + JSON.stringify([workspaceId, scope.kind, scope.id, entryId]);
}

export function managedNoteWasErased(origin: StorageReader, target: ErasureTarget): boolean {
  return origin.getItem(erasureKey(target)) === '1';
}

export function withManagedNoteStorage<T>(work: () => T): Promise<T> {
  if (!navigator.locks) return Promise.reject(new Error('Shared Bot note storage is unavailable.'));
  return navigator.locks.request('threadbear-bot-note-drafts', work);
}

export function managedNoteStoreId(origin: StorageWriter, makeId: () => string): string {
  const current = origin.getItem(STORE_ID);
  if (current) return current;
  const id = makeId();
  origin.setItem(STORE_ID, id);
  return id;
}

function readManagedCopy(origin: StorageReader, slot: string): { key: string; draft: unknown } | undefined {
  const value = readJSON(origin, COPY_PREFIX + slot) as { key?: unknown; draft?: unknown } | null;
  return typeof value?.key === 'string' && keyTarget(value.key, value.draft) ? { key: value.key, draft: value.draft } : undefined;
}

export function readNoteDraft(origin: StorageReader, session: StorageReader, key: string): unknown {
  const value = readJSON(session, key) as { managedNoteSlot?: unknown } | null;
  let body: unknown = value;
  if (typeof value?.managedNoteSlot === 'string') {
    const copy = readManagedCopy(origin, value.managedNoteSlot);
    if (copy?.key !== key) return null;
    body = copy.draft;
  }
  const target = keyTarget(key, body);
  return target && managedNoteWasErased(origin, target) ? null : body;
}

export function matchesManagedNoteDraft(origin: StorageReader, session: StorageReader, key: string, draft: DraftRecord): boolean {
  const ref = readJSON(session, key) as { managedNoteSlot?: unknown } | null;
  return typeof ref?.managedNoteSlot === 'string' && JSON.stringify(readNoteDraft(origin, session, key)) === JSON.stringify(draft);
}

// Text lives in one shared store. Duplicating sessionStorage copies only
// the reference. Serialize these changes with the same Web Lock in the app.
export function saveManagedNoteDraft(origin: StorageWriter, session: StorageWriter, key: string, slot: string, draft: DraftRecord): boolean {
  const target = keyTarget(key, draft);
  if (!target || managedNoteWasErased(origin, target)) return false;
  origin.setItem(COPY_PREFIX + slot, JSON.stringify({ key, draft }));
  session.setItem(key, JSON.stringify({ managedNoteSlot: slot }));
  return true;
}

export function dropManagedNoteDraft(origin: StorageReader, session: StorageReader, key: string, slot?: string): void {
  if (slot && readManagedCopy(origin, slot)?.key === key) origin.removeItem(COPY_PREFIX + slot);
  const ref = readJSON(session, key) as { managedNoteSlot?: unknown } | null;
  if (typeof ref?.managedNoteSlot === 'string') session.removeItem(key);
}

export function removeManagedNoteDrafts(origin: StorageWriter, session: StorageReader, targets: readonly ErasureTarget[]): ErasureTarget[] {
  const selected = new Set(targets.map(erasureKey));
  for (const key of selected) origin.setItem(key, '1');
  const keys = Array.from({ length: origin.length }, (_, index) => origin.key(index));
  let unknownCopy = false;
  for (const key of keys) {
    if (!key?.startsWith(COPY_PREFIX)) continue;
    const copy = readManagedCopy(origin, key.slice(COPY_PREFIX.length));
    const target = copy && keyTarget(copy.key, copy.draft);
    if (!target) unknownCopy = true;
    else if (selected.has(erasureKey(target))) origin.removeItem(key);
  }
  const legacy = savedNoteDrafts(session);
  clearErasedDrafts(session, legacy, legacy.map(({ target }) => selected.has(erasureKey(target))));
  return unknownCopy ? [] : [...targets];
}
