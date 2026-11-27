import { z } from 'zod';
import { chunks, MAX_SEALED_BYTES, safeEntryPath, sealInfo, sha256, type PackEntry } from '../move-pack.ts';
import { sealBytes } from '../secrets.ts';
import type { Runner } from '../runner.ts';
import { workspaceTransferConversations, type BotWorkspaceIdentity } from './repository.ts';
import { assertWorkspaceMemoryErased, type RequiredNoteErasure } from './memory-erasure.js';
import { managedBackupScope } from './managed-memory-restore.ts';
import { verifyTargetProjects, workspaceProjectChoice, type WorkspaceProjectChoice } from './workspace-projects.ts';
import { adoptWorkspaceThread, packWorkspaceThread, placeWorkspaceThread, workspaceThreadFiles, workspaceThreadPacks } from './workspace-threads.ts';
import { workspaceScheduleRevisions, type BotWorkspaceTransfer, type WorkspaceMoveProof, type WorkspaceScheduleRevision } from './workspace-transfer.ts';

export const BOT_WORKSPACE_PART_BYTES = 192 * 1024;
const moveId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const workspaceMoveInput = z.object({
  moveId, runnerId: z.string().min(1).max(128), projects: workspaceProjectChoice,
});
export const workspaceMoveReceipt = z.object({ moveId });
export const workspaceMovePreviewInput = z.object({ runnerId: z.string().min(1).max(128).optional() });
export type WorkspaceMoveCall = 'botWorkspaceMoves:begin' | 'botWorkspaceMoves:state' | 'botWorkspaceMoves:putPart' |
  'botWorkspaceMoves:pending' | 'botWorkspaceMoves:part' | 'botWorkspaceMoves:claim' | 'botWorkspaceMoves:cancel' |
  'botWorkspaceMoves:destinationProjects' | 'botWorkspaceMoves:verifyBotWorkspaceNoteErasures' |
  'botWorkspaceMoves:retiredNoteErasure' | 'botWorkspaceMoves:ackRetiredNoteErasure';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const plan = z.object({
  workspaceId: z.string().min(1), moveId: z.string().min(1), sourceRunnerId: z.string().min(1), targetRunnerId: z.string().min(1),
  epoch: z.number().int().positive(), checksum: digest, sealedChecksum: digest,
  parts: z.number().int().positive(), bytes: z.number().int().positive().max(MAX_SEALED_BYTES), threadIds: z.array(z.string()),
  schedules: workspaceScheduleRevisions.default([]),
}).refine(row => row.parts === Math.ceil(row.bytes / BOT_WORKSPACE_PART_BYTES));
const proof = z.object({
  moveId: z.string().min(1), workspaceId: z.string().min(1), ownerRunnerId: z.string().min(1),
  epoch: z.number().int().positive(), state: z.enum(['staged', 'claimed', 'cancelled']),
});
const noteErasurePage = z.object({
  revision: z.int().nonnegative(), epoch: z.int().positive(), ownerRunnerId: z.string().min(1),
  rows: z.array(z.object({
    scope: z.object({ kind: z.enum(['bot', 'group']), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
    entryId: z.string().min(1).max(128),
  })).max(128),
  cursor: z.string().min(1).nullable(),
});
const retiredNoteErasure = z.union([
  z.strictObject({ revision: z.int().positive() }),
  z.strictObject({ revision: z.int().positive(),
    scope: z.object({ kind: z.enum(['bot', 'group']), id: z.uuid() }), entryId: z.string().min(1).max(128) }),
]).nullable();
type NoteErasureProof = { revision: number; rows: RequiredNoteErasure[] };
type MoveLocator = { workspaceId: string; moveId: string };

type Ports = {
  runnerId: string;
  supportsNoteErasures?: () => boolean;
  canScrubRetiredNoteErasures?: () => boolean;
  store: BotWorkspaceTransfer;
  key: (targetRunnerId: string) => Promise<string>;
  call: (kind: 'query' | 'mutation', method: WorkspaceMoveCall, args: Record<string, unknown>) => Promise<unknown>;
  open: (bytes: Buffer, info: string) => Buffer;
  placeThreads?: (entries: PackEntry[]) => Promise<void>;
  adoptThreads?: (entries: PackEntry[], proof: WorkspaceMoveProof) => Promise<void>;
  retireThreads?: (threadIds: string[]) => Promise<void>;
  discardThreads?: (entries: PackEntry[]) => Promise<void>;
  validateTarget: (manifest: ReturnType<BotWorkspaceTransfer['stage']>) => void;
  adopted: (identity: BotWorkspaceIdentity) => void;
};
const transferInfo = (id: string) => sealInfo('bot-workspace:' + id);

export class BotWorkspaceWire {
  private readonly ports: Ports;
  private checkingRetiredNote = false;
  constructor(ports: Ports) { this.ports = ports; }

  private async pollRetiredNote(locator: { workspaceId: string; moveId: string; epoch: number }): Promise<void> {
    const { call, store, canScrubRetiredNoteErasures } = this.ports;
    if (this.checkingRetiredNote || !canScrubRetiredNoteErasures?.()) return;
    this.checkingRetiredNote = true;
    try {
      const item = retiredNoteErasure.parse(await call('query', 'botWorkspaceMoves:retiredNoteErasure', locator));
      if (item === null || !canScrubRetiredNoteErasures()) return;
      if ('scope' in item) store.eraseRetiredNote(locator, item);
      await call('mutation', 'botWorkspaceMoves:ackRetiredNoteErasure', { ...locator, ...item });
    } finally {
      this.checkingRetiredNote = false;
    }
  }

  private async noteErasures(locator: { workspaceId: string; moveId?: string }, expected: Pick<BotWorkspaceIdentity, 'epoch' | 'ownerRunnerId'>): Promise<NoteErasureProof | undefined> {
    if (!this.ports.supportsNoteErasures?.()) return undefined;
    let cursor: string | null = null;
    let revision: number | undefined;
    const rows: RequiredNoteErasure[] = [];
    const visited = new Set<string>();
    do {
      const page = noteErasurePage.parse(await this.ports.call('query', 'botWorkspaceMoves:verifyBotWorkspaceNoteErasures', {
        ...locator, ...(cursor === null ? {} : { cursor }),
      }));
      revision ??= page.revision;
      if (revision !== page.revision || page.epoch !== expected.epoch || page.ownerRunnerId !== expected.ownerRunnerId ||
          (page.cursor !== null && visited.has(page.cursor))) {
        throw new Error('The Bot workspace note erasures changed while checking the move.');
      }
      rows.push(...page.rows);
      cursor = page.cursor;
      if (cursor !== null) visited.add(cursor);
    } while (cursor !== null);
    if (rows.length !== revision) throw new Error('The Bot workspace note erasures are incomplete.');
    return { revision, rows };
  }

  async verifyMemoryRestore(files: readonly PackEntry[], identity: BotWorkspaceIdentity): Promise<void> {
    if (identity.ownerRunnerId !== this.ports.runnerId) throw new Error('Only the workspace owner can check a Bot backup.');
    const paths = new Set<string>();
    for (const { path } of files) {
      const canonical = path.normalize('NFC').toLowerCase();
      if (!path.startsWith('bots/') || !safeEntryPath(path) || paths.has(canonical)) {
        throw new Error('The Bot backup contains an unexpected or duplicate file.');
      }
      paths.add(canonical);
    }
    const state = files.find(file => file.path === 'bots/state.json');
    if (!state) throw new Error('The backup does not contain its saved Bot workspace identity.');
    workspaceTransferConversations(state.data.toString('utf8'), identity);
    const noteProof = await this.noteErasures({ workspaceId: identity.workspaceId }, identity);
    if (!noteProof) throw new Error('A Bot backup needs updated sync to check its note erasures.');
    const scope = managedBackupScope(files);
    assertWorkspaceMemoryErased(files, scope ? noteProof.rows.filter(row => row.scope.kind === scope.kind && row.scope.id === scope.id) : noteProof.rows);
  }

  async cancel(moveId: string): Promise<void> {
    const { store, call } = this.ports;
    const current = store.progress();
    if (current?.moveId !== moveId || !['preparing', 'frozen'].includes(current.state)) {
      throw new Error('Only this Runner’s outgoing workspace move can be cancelled.');
    }
    if (current.state === 'preparing') {
      store.abandonPreparation(moveId);
      return;
    }
    const cancelled = proof.parse(await call('mutation', 'botWorkspaceMoves:cancel', {
      moveId, workspaceId: current.identity.workspaceId, targetRunnerId: current.target, epoch: current.identity.epoch,
    }));
    if (cancelled.state !== 'cancelled') throw new Error('The authority did not cancel this Bot workspace move.');
    await this.settleSource(cancelled, moveId);
  }

  async send(input: { identity: BotWorkspaceIdentity; target: string; moveId: string; projects?: WorkspaceProjectChoice; idle: () => boolean; threadFiles: () => PackEntry[] | Promise<PackEntry[]>; schedules?: () => WorkspaceScheduleRevision[] }) {
    const { store, call, key } = this.ports;
    const current = store.progress();
    const replay = current?.state === 'frozen' && current.moveId === input.moveId;
    const recipient = replay ? undefined : await key(input.target);
    const revisions = replay ? undefined : input.schedules?.();
    if (!replay) store.prepare(input);
    const threadFiles = replay ? [] : await input.threadFiles();
    const locator = { moveId: input.moveId, workspaceId: input.identity.workspaceId };
    const noteProof = await this.noteErasures(locator, input.identity);
    const local = store.freeze({ ...input, threadFiles, schedules: revisions, noteErasures: noteProof?.rows });
    const saved = store.offer(input.moveId);
    const sealed = await store.sealed(input.moveId, async () =>
      sealBytes(recipient ?? await key(input.target), local.packed, transferInfo(input.moveId)));
    const parts = chunks(sealed, BOT_WORKSPACE_PART_BYTES);
    const answer = proof.parse(await call('mutation', 'botWorkspaceMoves:begin', {
      ...locator, targetRunnerId: input.target, epoch: input.identity.epoch, checksum: local.checksum,
      sealedChecksum: sha256(sealed), bytes: sealed.length, parts: parts.length, ...saved,
      ...(noteProof ? { noteErasureRevision: noteProof.revision } : {}),
    }));
    if (answer.state !== 'staged') {
      await this.settleSource(answer, locator.moveId);
      return answer;
    }
    if (!current?.uploaded || !replay) {
      for (const [index, data] of parts.entries()) {
        await call('mutation', 'botWorkspaceMoves:putPart', { ...locator, index, data: data.toString('base64') });
      }
      store.markUploaded(input.moveId);
    }
    return answer;
  }

  async poll(): Promise<void> {
    const { store, call } = this.ports;
    const current = store.progress();
    if (current?.state === 'frozen' || current?.state === 'receiving') {
      const locator = { workspaceId: current.identity.workspaceId, moveId: current.moveId };
      const answer = proof.nullable().parse(await call('query', 'botWorkspaceMoves:state', locator));
      if (current.state === 'frozen') {
        if (answer?.state === 'claimed' || answer?.state === 'cancelled') await this.settleSource(answer, current.moveId);
        else if (!current.uploaded) await this.send({
          ...locator, identity: current.identity, target: current.target,
          idle: () => false, threadFiles: () => { throw new Error('A frozen workspace must reuse its saved pack.'); },
        });
      } else if (answer?.state === 'cancelled') {
        await store.discardTarget({ ...answer, state: 'cancelled' }, current.moveId, async () => {
          const threads = store.pendingThreads(current.moveId);
          if (threads.length) {
            if (!this.ports.discardThreads) throw new Error('This Runner cannot discard the placed Bot Threads.');
            await this.ports.discardThreads(threads);
          }
        });
      } else if (answer?.state === 'claimed') {
        await this.adopt({ ...answer, state: 'claimed' });
      } else if (answer?.state === 'staged') {
        await this.claim(locator, current.checksum);
      }
      return;
    }
    if (current?.state === 'moved') {
      return this.pollRetiredNote({ workspaceId: current.identity.workspaceId, moveId: current.moveId, epoch: current.identity.epoch });
    }
    if (current?.state === 'preparing') return;
    const pending = plan.nullable().parse(await call('query', 'botWorkspaceMoves:pending', {}));
    if (!pending) return;
    if (pending.targetRunnerId !== this.ports.runnerId) throw new Error('The Bot workspace move names another Runner.');
    const locator = { workspaceId: pending.workspaceId, moveId: pending.moveId };
    const encrypted = [];
    for (let index = 0; index < pending.parts; index++) {
      const raw = z.base64().max(4 * Math.ceil(BOT_WORKSPACE_PART_BYTES / 3)).parse(await call('query', 'botWorkspaceMoves:part', { ...locator, index }));
      encrypted.push(Buffer.from(raw, 'base64'));
    }
    const sealed = Buffer.concat(encrypted);
    if (sealed.length !== pending.bytes || sha256(sealed) !== pending.sealedChecksum) {
      throw new Error('The sealed Bot workspace does not match the declared bytes.');
    }
    const packed = this.ports.open(sealed, transferInfo(pending.moveId));
    const noteProof = await this.noteErasures(locator, { epoch: pending.epoch, ownerRunnerId: pending.sourceRunnerId });
    store.stage({
      moveId: pending.moveId, checksum: pending.checksum, packed, noteErasures: noteProof?.rows,
      check: manifest => {
        if (manifest.identity.workspaceId !== pending.workspaceId || manifest.identity.epoch !== pending.epoch ||
            manifest.identity.ownerRunnerId !== pending.sourceRunnerId) throw new Error('The Bot workspace manifest does not match its offer.');
        const ids = manifest.files.filter(file => file.path.startsWith('moves/') && file.path.endsWith('/plan.json'))
          .map(file => file.path.split('/')[1]).sort();
        if (JSON.stringify(ids) !== JSON.stringify([...pending.threadIds].sort())) {
          throw new Error('The Bot workspace pack does not contain the declared Threads.');
        }
        if (JSON.stringify(manifest.schedules) !== JSON.stringify(pending.schedules)) {
          throw new Error('The Bot workspace pack does not contain the declared reservation revisions.');
        }
        this.ports.validateTarget(manifest);
      },
    });
    await this.claim(locator, pending.checksum, noteProof);
  }

  private async claim(locator: MoveLocator, checksum: string, ready?: NoteErasureProof): Promise<void> {
    const { entries, manifest } = this.ports.store.pending(locator.moveId);
    const noteProof = ready ?? await this.noteErasures(locator, manifest.identity);
    assertWorkspaceMemoryErased(entries, noteProof?.rows ?? []);
    const threads = entries.filter(entry => entry.path.startsWith('moves/'));
    if (threads.length) {
      if (!this.ports.placeThreads || !this.ports.adoptThreads) throw new Error('This Runner cannot place the Bot Thread files.');
      await this.ports.placeThreads(threads);
    }
    this.ports.validateTarget(manifest);
    const answer = proof.parse(await this.ports.call('mutation', 'botWorkspaceMoves:claim', {
      ...locator, checksum, ...(noteProof ? { noteErasureRevision: noteProof.revision } : {}),
    }));
    if (answer.state !== 'claimed') throw new Error('The Bot workspace move has not been claimed.');
    await this.adopt({ ...answer, state: 'claimed' }, noteProof);
  }

  private async adopt(answer: WorkspaceMoveProof, ready?: NoteErasureProof): Promise<void> {
    const { entries } = this.ports.store.pending(answer.moveId);
    const noteProof = ready ?? await this.noteErasures({ moveId: answer.moveId, workspaceId: answer.workspaceId }, answer);
    assertWorkspaceMemoryErased(entries, noteProof?.rows ?? []);
    const threads = entries.filter(entry => entry.path.startsWith('moves/'));
    if (threads.length) {
      if (!this.ports.adoptThreads) throw new Error('This Runner cannot adopt the claimed Bot Threads.');
      await this.ports.adoptThreads(threads, answer);
    }
    const identity = this.ports.store.accept(answer, answer.moveId);
    this.ports.adopted(identity);
  }

  private async settleSource(answer: z.infer<typeof proof>, moveId: string): Promise<void> {
    if (answer.state === 'staged') return;
    const receipt = { ...answer, state: answer.state };
    this.ports.store.checkSourceReceipt(receipt, moveId);
    if (answer.state === 'claimed') {
      const ids = this.ports.store.offer(moveId).threadIds;
      if (ids.length) {
        if (!this.ports.retireThreads) throw new Error('This Runner cannot retire the transferred Bot Threads.');
        await this.ports.retireThreads(ids);
      }
    }
    this.ports.store.closeSource(receipt, moveId);
  }
}

// The manifest has checked each native plan against the saved workspace book.
// The existing Thread move code chooses the target folder and login, places the
// exact linked record, and retires the source after the authority confirms it.
export function connectNativeWorkspaceRunner(
  runner: Runner, ports: Omit<Ports, 'placeThreads' | 'adoptThreads' | 'retireThreads' | 'discardThreads'>,
) {
  const threadStates = () => [...runner.threads.values()].filter(({ rec }) => rec.botLink && !rec.botWorker && !rec.copied);
  const packs = (entries: PackEntry[]) => {
    const current = ports.store.progress();
    if (!current || current.state !== 'receiving') throw new Error('The Bot workspace is not staged on this Runner.');
    return workspaceThreadPacks(entries, { ...current.identity, moveId: current.moveId });
  };
  const wire = new BotWorkspaceWire({
    ...ports,
    validateTarget: manifest => {
      const selected = manifest.projects;
      if (selected !== 'detach') {
        verifyTargetProjects(runner.projects, Object.values(selected.assign).flatMap(id => id ? [id] : []));
      }
      ports.validateTarget(manifest);
    },
    placeThreads: async entries => {
      for (const pack of packs(entries)) await placeWorkspaceThread(runner, ports.runnerId, pack);
    },
    adoptThreads: async (entries, proof) => {
      for (const pack of packs(entries)) await adoptWorkspaceThread(runner, pack, pack.row, proof);
    },
    retireThreads: async ids => {
      for (const id of ids) {
        if (runner.threads.has(id) || runner.store.load(id)) await runner.putAwayMoved(id);
      }
    },
    discardThreads: async entries => {
      for (const pack of packs(entries)) await runner.discardMove(pack.row);
    },
  });
  let busy = false;
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (busy) throw new Error('A Bot workspace move operation is already in progress.');
    busy = true;
    try { return await operation(); }
    finally { busy = false; }
  }
  const resume = () => {
    for (const state of threadStates()) runner.kickQueue(state);
  };
  return {
    recoverMemory: <T>(files: readonly PackEntry[], identity: BotWorkspaceIdentity, apply: () => T) => run(async () => {
      await wire.verifyMemoryRestore(files, identity);
      return apply();
    }),
    poll: async () => {
      if (busy) return;
      const wasFrozen = ports.store.progress()?.state === 'frozen';
      await run(() => wire.poll());
      if (wasFrozen && ports.store.progress()?.state === 'cancelled') resume();
    },
    cancel: (id: string) => run(async () => {
      await wire.cancel(id);
      resume();
    }),
    start: (layout: { moveId: string; target: string; projects: WorkspaceProjectChoice; identity: BotWorkspaceIdentity; idle: () => boolean; schedules?: () => WorkspaceScheduleRevision[] }) =>
      run(async () => {
        try {
          return await wire.send({
            ...layout,
            idle: () => layout.idle() && threadStates().every(({ rec }) => runner.moveIdle(rec.id) && !rec.queue.length),
            threadFiles: async () => {
              const files: PackEntry[] = [];
              for (const { rec } of threadStates()) {
                const pack = await packWorkspaceThread(runner, ports.store, layout.identity, rec.id, layout, link => rec.botLink === link);
                files.push(...workspaceThreadFiles(pack));
              }
              return files;
            },
          });
        } catch (error) {
          const current = ports.store.progress();
          if (current?.state === 'preparing' && current.moveId === layout.moveId &&
              current.target === layout.target && current.identity.workspaceId === layout.identity.workspaceId) {
            ports.store.abandonPreparation(layout.moveId);
            resume();
          }
          throw error;
        }
      }),
  };
}
