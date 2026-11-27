import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../fsutil.ts';
import type { BotNoteErasure, BotNoteErasureReply } from './device-workspace.ts';
import { botOperationId, type BotWorkspaceIdentity } from './repository.ts';

const erasureScope = z.object({ kind: z.enum(['bot', 'group']), id: z.uuid() });
const intentSchema = z.object({
  workspaceId: z.uuid(),
  epoch: z.int().positive(),
  scope: erasureScope,
  entryId: z.string().min(1).max(128),
  operationId: botOperationId,
  expectedRevision: z.string().min(1).max(128),
  time: z.iso.datetime({ offset: true }),
});
const progress = z.enum(['queued', 'waitingForLocalCopies', 'waitingForSync', 'waitingForLegacy', 'waitingForSources', 'waitingForDevices']);
const savedIntent = intentSchema.extend({ state: progress.default('queued') });
const intentsSchema = z.array(savedIntent);
export type NoteErasureIntent = z.infer<typeof intentSchema>;
type SavedIntent = z.infer<typeof savedIntent>;
export const noteErasureStatusInput = z.object({ scope: erasureScope });
export const noteErasureInput = intentSchema.omit({ time: true }).extend({ confirmed: z.literal(true) });
export type ConfirmedNoteErasure = z.infer<typeof noteErasureInput>;
type Options = {
  home: string;
  identity: () => BotWorkspaceIdentity;
  canWrite: () => boolean;
  eraseLocal: (intent: NoteErasureIntent, beforeWrite: () => void) => { revision: string };
  eraseLocalReviews?: (intent: NoteErasureIntent) => void;
  eraseLocalBackups?: (intent: NoteErasureIntent) => void;
  eraseMirror: (input: BotNoteErasure) => Promise<BotNoteErasureReply>;
};

// The local memory journal is still the write and replay authority. The
// intent only remembers which erasure needs to reach the mirror, with no
// copied note body. It is written after validation, before the first effect.
export class BotNoteErasureQueue {
  private readonly file: string;
  private readonly options: Options;
  private flight?: Promise<BotNoteErasureReply | undefined>;
  private lastTried?: string;

  constructor(options: Options) {
    this.options = options;
    this.file = join(options.home, 'bot-note-erasures.json');
  }

  private read(): SavedIntent[] {
    const file = lstatSync(this.file, { throwIfNoEntry: false });
    if (!file) return [];
    if (!file.isFile()) throw new Error('The Bot note erasure queue must be a regular file.');
    return intentsSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
  }

  private save(intents: SavedIntent[]): void {
    atomicWriteFileSync(this.file, JSON.stringify(intents) + '\n', 0o600);
  }

  private sameOwnership(intent: BotNoteErasure): boolean {
    if (!this.options.canWrite()) return false;
    const owner = this.options.identity();
    return owner.workspaceId === intent.workspaceId && owner.epoch === intent.epoch;
  }

  pending(): boolean {
    return this.read().length !== 0;
  }

  progress(identity: Pick<BotWorkspaceIdentity, 'workspaceId' | 'epoch'>, scope: NoteErasureIntent['scope']) {
    return this.read().filter(row => row.workspaceId === identity.workspaceId && row.epoch === identity.epoch &&
      row.scope.kind === scope.kind && row.scope.id === scope.id)
      .map(({ operationId, entryId, state }) => ({ operationId, entryId, state }));
  }

  private updateProgress(intent: SavedIntent, state: SavedIntent['state']): void {
    if (!this.sameOwnership(intent) || intent.state === state) return;
    this.save(this.read().map(row => row.operationId === intent.operationId ? { ...row, state } : row));
  }

  begin(raw: NoteErasureIntent): { revision: string } {
    const intent = intentSchema.parse(raw);
    if (!this.sameOwnership(intent)) throw new Error('Only the current Bot workspace owner can start erasure.');
    const queue = this.read();
    const saved = queue.find(row => row.operationId === intent.operationId);
    if (saved && (saved.workspaceId !== intent.workspaceId || saved.epoch !== intent.epoch ||
        saved.scope.kind !== intent.scope.kind || saved.scope.id !== intent.scope.id || saved.entryId !== intent.entryId)) {
      throw new Error('This operation ID belongs to another note erasure.');
    }
    return this.options.eraseLocal(saved ?? intent, () => {
      if (!saved) this.save([...queue, { ...intent, state: 'queued' }]);
    });
  }

  resume(): Promise<BotNoteErasureReply | undefined> {
    if (this.flight) return this.flight;
    const flight = this.deliver().finally(() => { this.flight = undefined; });
    this.flight = flight;
    return flight;
  }

  private async deliver(): Promise<BotNoteErasureReply | undefined> {
    if (!this.options.canWrite()) return undefined;
    const pending = this.read();
    if (!pending.length) return undefined;
    const previous = pending.findIndex(row => row.operationId === this.lastTried);
    const intent = pending[(previous + 1) % pending.length];
    this.lastTried = intent.operationId;
    if (!this.sameOwnership(intent)) return undefined;
    // An interruption before the journal changed is retried at the recorded
    // revision. A finished local write reuses the journal's operation receipt.
    try {
      this.options.eraseLocal(intent, () => {});
      this.options.eraseLocalReviews?.(intent);
    } catch (error) {
      this.updateProgress(intent, 'waitingForLocalCopies');
      throw error;
    }
    // Scrub local packs even when sync is offline, and still send the
    // tombstone to the mirror if a local archive needs attention.
    const backups = Promise.resolve().then(() => {
      if (this.sameOwnership(intent)) this.options.eraseLocalBackups?.(intent);
    });
    const { workspaceId, epoch, scope, entryId } = intent;
    const [remote, local] = await Promise.allSettled([this.options.eraseMirror({ workspaceId, epoch, scope, entryId }), backups]);
    if (local.status === 'rejected') {
      this.updateProgress(intent, 'waitingForLocalCopies');
      throw local.reason;
    }
    if (remote.status === 'rejected') {
      this.updateProgress(intent, 'waitingForSync');
      throw remote.reason;
    }
    const reply = remote.value;
    if (!this.sameOwnership(intent)) return { done: false };
    if (!reply.done) {
      const state = reply.waitingForLegacy ? 'waitingForLegacy' : reply.waitingForSources ? 'waitingForSources'
        : reply.waitingForDevices ? 'waitingForDevices' : 'waitingForSync';
      this.updateProgress(intent, state);
      return reply;
    }
    this.save(this.read().filter(row => row.operationId !== intent.operationId));
    return reply;
  }
}
