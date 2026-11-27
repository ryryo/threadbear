import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config.ts';
import { atomicWriteFileSync } from '../fsutil.ts';
import { archive, MAX_ENTRIES, MAX_SEALED_BYTES, MAX_UNPACKED_BYTES, safeEntryPath, sha256, unarchive, unpackedSize, type PackEntry } from '../move-pack.ts';
import { isThreadIdShape } from '../thread-id.ts';
import { readGroupBook } from './group-store.ts';
import { rehomeBotWorkspaceState, workspaceTransferConversations, type BotWorkspaceIdentity } from './repository.ts';
import { readTaskJournal } from './task-journal.ts';
import { allowedWorkspaceProjectFile, workspaceProjectChoice, workspaceProjectFiles, type WorkspaceProjectChoice } from './workspace-projects.ts';
import { workspaceThreadPlan } from './workspace-threads.ts';

const transferId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const identity = z.object({ workspaceId: z.string().min(1), ownerRunnerId: z.string().min(1), epoch: z.number().int().positive() });
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const workspaceScheduleRevisions = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), updatedAt: z.string().min(1).max(64),
})).max(512);
export type WorkspaceScheduleRevision = z.infer<typeof workspaceScheduleRevisions>[number];
const manifest = z.object({
  format: z.literal(1), moveId: transferId, target: z.string().min(1), identity,
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), checksum })),
  schedules: workspaceScheduleRevisions.default([]),
  projects: workspaceProjectChoice.default('detach'),
});
const fence = z.object({
  moveId: transferId, target: z.string(), identity, checksum,
  state: z.enum(['preparing', 'frozen', 'receiving', 'moved', 'cancelled', 'accepted']),
  uploaded: z.literal(true).optional(),
});
type Fence = z.infer<typeof fence>;
type Manifest = z.infer<typeof manifest>;
export type WorkspaceMoveProof = { state: 'claimed' | 'cancelled'; moveId: string; workspaceId: string; ownerRunnerId: string; epoch: number };

function readFile(file: string): Buffer | undefined {
  const path = lstatSync(file, { throwIfNoEntry: false });
  if (!path) return undefined;
  if (!path.isFile()) throw new Error('A Bot workspace transfer needs regular files.');
  return readFileSync(file);
}

function checkFiles(entries: PackEntry[], transfer: { identity: BotWorkspaceIdentity; moveId: string; target: string; projects: WorkspaceProjectChoice }, sourceHome?: string): void {
  const keys = new Set<string>();
  const byPath = new Map(entries.map(entry => [entry.path, entry.data]));
  const destinations = new Set(transfer.projects === 'detach' ? [] : Object.values(transfer.projects.assign).filter((id): id is string => id !== null));
  for (const { path } of entries) {
    const canonical = path.normalize('NFC').toLowerCase();
    if (!safeEntryPath(path) || !/^(bots\/.+|threads\/[a-zA-Z0-9_-]+\/.+|moves\/[a-zA-Z0-9_-]+\/(plan\.json|files\.pack))$/.test(path) || keys.has(canonical)) {
      throw new Error('A Bot workspace transfer contains an unexpected file.');
    }
    if (!allowedWorkspaceProjectFile(path, destinations)) throw new Error('The workspace transfer contains an unassigned Project memory.');
    keys.add(canonical);
  }
  const state = byPath.get('bots/state.json');
  if (!state) throw new Error('The transfer does not contain the Bot workspace.');
  const declared = new Set<string>();
  const verifyConversation = (conversation: { threadId: string; botId: string; id: string; groupId?: string; taskId?: string }) => {
    const label = conversation.taskId ? 'Bot task' : conversation.groupId ? 'Group conversation' : 'Bot conversation';
    const prefix = 'moves/' + conversation.threadId;
    const descriptor = byPath.get(prefix + '/plan.json');
    if (!descriptor || !byPath.has(prefix + '/files.pack')) throw new Error(`The workspace transfer is missing a ${label}.`);
    const { workspaceId, moveId, epoch, link, row, projectIds } = workspaceThreadPlan(descriptor);
    if (workspaceId !== transfer.identity.workspaceId || moveId !== transfer.moveId || epoch !== transfer.identity.epoch ||
        row.from !== transfer.identity.ownerRunnerId || row.to !== transfer.target || row.threadId !== conversation.threadId ||
        link.botId !== conversation.botId || link.conversationId !== conversation.id ||
        link.groupId !== conversation.groupId || link.taskId !== conversation.taskId) {
      throw new Error(`A ${label} in the transfer does not match its saved identity.`);
    }
    if (projectIds.some(id => !destinations.has(id))) throw new Error('A Bot Thread names an unassigned destination Project.');
    declared.add(prefix + '/plan.json');
    declared.add(prefix + '/files.pack');
  };
  for (const conversation of workspaceTransferConversations(state.toString('utf8'), transfer.identity)) {
    verifyConversation(conversation);
  }
  for (const { path, data } of entries) {
    const groupId = /^bots\/groups\/([^/]+)\.jsonl$/.exec(path)?.[1];
    if (!groupId) continue;
    const book = readGroupBook(groupId, data.toString('utf8'));
    for (const [botId, link] of Object.entries(book.threads)) {
      verifyConversation({ ...link, botId, groupId });
    }
  }
  const tasks = byPath.get('bots/tasks.json');
  if (tasks) {
    for (const task of readTaskJournal(tasks.toString('utf8')).values()) {
      if (!('outcome' in task.state)) throw new Error('Finish or stop Bot tasks before moving this workspace.');
      if (!isThreadIdShape(task.threadId)) throw new Error('The saved Bot task has an invalid Thread identity.');
      // A reservation can be stopped before it gets an input or a Thread.
      // At the source, still require its history if native placement began.
      const materialized = byPath.has('moves/' + task.threadId + '/plan.json') ||
        (sourceHome && lstatSync(paths.thread(sourceHome, task.threadId), { throwIfNoEntry: false }));
      if (materialized || task.state.status !== 'stopped' || task.revision !== 2) {
        verifyConversation({ threadId: task.threadId, botId: task.botId, id: task.id, taskId: task.id });
      }
    }
  }
  if (entries.some(entry => entry.path.startsWith('moves/') && !declared.has(entry.path))) {
    throw new Error('The workspace transfer contains an undeclared Bot Thread.');
  }
}

function filesOf(entries: PackEntry[]): Manifest['files'] {
  return entries.map(entry => ({ path: entry.path, bytes: entry.data.length, checksum: sha256(entry.data) }));
}

function decode(packed: Buffer, expected: string): { manifest: Manifest; entries: PackEntry[] } {
  if (packed.length > MAX_SEALED_BYTES || !checksum.safeParse(expected).success || sha256(packed) !== expected) {
    throw new Error('The Bot workspace transfer checksum does not match.');
  }
  const [first, ...entries] = unarchive(packed);
  if (first?.path !== 'manifest.json') throw new Error('The Bot workspace transfer is missing its manifest.');
  const description = manifest.parse(JSON.parse(first.data.toString('utf8')));
  checkFiles(entries, description);
  if (JSON.stringify(filesOf(entries)) !== JSON.stringify(description.files)) throw new Error('The transfer files do not match its manifest.');
  return { manifest: description, entries };
}

// The primary Runner holds its normal data lock for these operations. A
// source keeps its fence until the authority reports cancellation or a
// claim. A target retains the received bundle until it can recover a claim.
export class BotWorkspaceTransfer {
  private readonly marker: string;
  private readonly home: string;
  private readonly runnerId: string;
  private readonly protect: () => void;

  constructor(home: string, runnerId: string, protect: () => void) {
    this.home = home;
    this.runnerId = runnerId;
    this.protect = protect;
    this.marker = join(home, 'bots-transfer.json');
  }

  progress(): Fence | undefined {
    const body = readFile(this.marker);
    return body === undefined ? undefined : fence.parse(JSON.parse(body.toString('utf8')));
  }

  blocked(): boolean {
    const current = this.progress();
    return current?.state === 'preparing' || current?.state === 'frozen' || current?.state === 'moved' || current?.state === 'receiving';
  }

  private save(next: Fence): void {
    this.protect();
    atomicWriteFileSync(this.marker, JSON.stringify(next) + '\n', 0o600);
  }

  private frozenSource(moveId: string): Fence | undefined {
    const current = this.progress();
    if (current?.moveId === moveId && current.state === 'frozen' && current.identity.ownerRunnerId === this.runnerId) return current;
    return undefined;
  }

  async sealed(moveId: string, create: () => Promise<Buffer>): Promise<Buffer> {
    if (!this.frozenSource(moveId)) throw new Error('Only the frozen source can seal this Bot workspace.');
    const name = this.bundle(moveId) + '.sealed';
    const saved = readFile(name);
    if (saved) return saved;
    const encoded = await create();
    if (!this.frozenSource(moveId)) throw new Error('The Bot workspace stopped being the frozen source.');
    const existing = readFile(name);
    if (existing) return existing;
    if (encoded.length > MAX_SEALED_BYTES) throw new Error('The sealed Bot workspace is too large.');
    atomicWriteFileSync(name, encoded, 0o600);
    return encoded;
  }

  markUploaded(moveId: string): void {
    const current = this.frozenSource(moveId);
    if (current && !current.uploaded) this.save({ ...current, uploaded: true });
  }

  private bundle(moveId: string): string {
    return join(this.home, `bots-transfer-${transferId.parse(moveId)}.pack`);
  }

  prepare(input: { moveId: string; identity: BotWorkspaceIdentity; target: string; idle: () => boolean }): void {
    const current = this.progress();
    const { moveId, target, identity: owner } = input;
    if (owner.ownerRunnerId !== this.runnerId || target === this.runnerId) throw new Error('This Runner does not own a move to that target.');
    if (current?.state === 'preparing' && current.moveId === moveId && current.target === target &&
        current.identity.workspaceId === owner.workspaceId && current.identity.epoch === owner.epoch) return;
    if (this.blocked() || current?.moveId === moveId) throw new Error('This Runner already has a workspace transfer.');
    if (!input.idle()) throw new Error('The Bot workspace still has active work.');
    this.save({ moveId, target, identity: owner, checksum: '0'.repeat(64), state: 'preparing' });
  }

  abandonPreparation(moveId: string): void {
    const current = this.progress();
    if (!current || current.state !== 'preparing' || current.moveId !== moveId || current.identity.ownerRunnerId !== this.runnerId) {
      throw new Error('Only a move that has not been offered can resume locally.');
    }
    this.save({ ...current, state: 'cancelled' });
    this.removePacks(moveId);
  }

  freeze(input: { moveId: string; identity: BotWorkspaceIdentity; target: string; idle: () => boolean; threadFiles: PackEntry[]; schedules?: WorkspaceScheduleRevision[]; projects?: WorkspaceProjectChoice }) {
    const { target, moveId } = input;
    const owner = input.identity;
    if (owner.ownerRunnerId !== this.runnerId || target === this.runnerId) throw new Error('This Runner does not own a move to that target.');
    const current = this.progress();
    if (current?.moveId === moveId && current.state === 'frozen' && current.target === target &&
        current.identity.workspaceId === owner.workspaceId && current.identity.epoch === owner.epoch) {
      const packed = readFile(this.bundle(moveId));
      if (!packed) throw new Error('The frozen Bot workspace pack is missing.');
      decode(packed, current.checksum);
      return { packed, checksum: current.checksum };
    }
    this.prepare(input);
    const projects = workspaceProjectChoice.parse(input.projects ?? 'detach');
    const entries = [...workspaceProjectFiles(join(this.home, 'bots'), projects), ...input.threadFiles];
    checkFiles(entries, { ...input, projects }, this.home);
    const schedules = [...(input.schedules ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const description = manifest.parse({ format: 1, moveId, target, identity: owner, files: filesOf(entries), schedules, projects });
    const files = [{ path: 'manifest.json', data: Buffer.from(JSON.stringify(description)) }, ...entries];
    if (files.length > MAX_ENTRIES || unpackedSize(files) > MAX_UNPACKED_BYTES) throw new Error('The Bot workspace is too large to move.');
    const packed = archive(files);
    if (packed.length > MAX_SEALED_BYTES) throw new Error('The Bot workspace is too large to move.');
    const digest = sha256(packed);
    this.protect();
    atomicWriteFileSync(this.bundle(moveId), packed, 0o600);
    this.save({ moveId, target, identity: owner, checksum: digest, state: 'frozen' });
    return { packed, checksum: digest };
  }

  stage(input: { moveId: string; checksum: string; packed: Buffer; check?: (manifest: Manifest) => void }): Manifest {
    const opened = decode(input.packed, input.checksum);
    const { target, moveId, identity: owner } = opened.manifest;
    if (target !== this.runnerId || moveId !== input.moveId || owner.ownerRunnerId === target) {
      throw new Error('The Bot workspace transfer names a different Runner or move.');
    }
    const current = this.progress();
    if (current?.moveId === moveId && current.checksum === input.checksum &&
        (current.state === 'receiving' || current.state === 'accepted')) return opened.manifest;
    if (this.blocked() || current?.moveId === moveId) throw new Error('This Runner already has a workspace transfer.');
    input.check?.(opened.manifest);
    this.preflight(this.destinationFiles(opened.entries, owner));
    this.protect();
    atomicWriteFileSync(this.bundle(moveId), input.packed, 0o600);
    this.save({ moveId, target, identity: owner, checksum: input.checksum, state: 'receiving' });
    return opened.manifest;
  }

  private preflight(entries: PackEntry[]) {
    for (const entry of entries) {
      const parts = entry.path.split('/');
      let prefix = this.home;
      for (const part of parts.slice(0, -1)) {
        prefix = join(prefix, part);
        const stat = lstatSync(prefix, { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) throw new Error('A Bot workspace transfer cannot replace a directory or link.');
      }
      const existing = readFile(join(this.home, entry.path));
      if (existing && !existing.equals(entry.data)) {
        if (entry.path === 'bots/state.json') throw new Error('The target stores another workspace.');
        throw new Error('The target already stores a different Bot file or Thread.');
      }
    }
  }

  private destinationFiles(entries: PackEntry[], source: BotWorkspaceIdentity): PackEntry[] {
    const record = entries.find(entry => entry.path === 'bots/state.json')!;
    const changed = rehomeBotWorkspaceState(record.data.toString('utf8'), source, this.runnerId);
    return [...entries.filter(entry => entry.path !== record.path && !entry.path.startsWith('moves/')),
      { ...record, data: Buffer.from(changed) }];
  }

  offer(moveId: string): { threadIds: string[]; schedules: WorkspaceScheduleRevision[] } {
    const current = this.progress();
    if (!current || current.state !== 'frozen' || current.moveId !== moveId) throw new Error('The Bot workspace is not frozen.');
    const packed = readFile(this.bundle(moveId));
    if (!packed) throw new Error('The frozen Bot workspace pack is missing.');
    const { entries, manifest } = decode(packed, current.checksum);
    const threadIds = entries.filter(entry => entry.path.startsWith('moves/') && entry.path.endsWith('/plan.json')).map(entry => entry.path.split('/')[1]);
    return { threadIds, schedules: manifest.schedules };
  }

  pendingThreads(moveId: string): PackEntry[] {
    return this.pending(moveId).entries.filter(entry => entry.path.startsWith('moves/'));
  }

  pending(moveId: string) {
    const current = this.progress();
    if (!current || current.state !== 'receiving' || current.moveId !== moveId || current.target !== this.runnerId) {
      throw new Error('The Bot workspace is not staged on this Runner.');
    }
    const packed = readFile(this.bundle(moveId));
    if (!packed) throw new Error('The verified Bot workspace pack is missing.');
    return decode(packed, current.checksum);
  }

  accept(claim: WorkspaceMoveProof, moveId: string): BotWorkspaceIdentity {
    const current = this.progress();
    if (!current || current.moveId !== moveId || claim.moveId !== moveId || claim.workspaceId !== current.identity.workspaceId ||
        current.target !== this.runnerId || claim.state !== 'claimed' ||
        claim.ownerRunnerId !== this.runnerId || claim.epoch !== current.identity.epoch + 1 ||
        (current.state !== 'receiving' && current.state !== 'accepted')) throw new Error('This Runner has no saved claim for that Bot workspace.');
    const next = { workspaceId: current.identity.workspaceId, ownerRunnerId: this.runnerId, epoch: claim.epoch };
    if (current.state === 'accepted') {
      this.removePacks(moveId);
      return next;
    }
    const packed = readFile(this.bundle(moveId));
    if (!packed) throw new Error('The verified Bot workspace pack is missing.');
    const { entries } = decode(packed, current.checksum);
    // Apply state last. A stopped target can repeat the copy from the same
    // bundle, but cannot replace an unrelated workspace or Thread.
    const recovered = this.destinationFiles(entries, current.identity);
    this.preflight(recovered);
    for (const entry of recovered) atomicWriteFileSync(join(this.home, entry.path), entry.data, 0o600);
    this.save({ ...current, state: 'accepted' });
    this.removePacks(moveId);
    return next;
  }

  checkSourceReceipt(claim: WorkspaceMoveProof, moveId: string): Fence {
    const current = this.progress();
    if (!current || current.moveId !== moveId || claim.moveId !== moveId || claim.workspaceId !== current.identity.workspaceId ||
        current.identity.ownerRunnerId !== this.runnerId ||
        (current.state !== 'frozen' && current.state !== 'moved' && current.state !== 'cancelled')) {
      throw new Error('This Runner has no saved source transfer.');
    }
    if (claim.state === 'cancelled') {
      if (current.state === 'moved') throw new Error('The Bot workspace already moved.');
      if (claim.ownerRunnerId !== this.runnerId || claim.epoch !== current.identity.epoch) throw new Error('The saved claim does not match this source.');
      return current;
    }
    if (current.state === 'cancelled' || claim.ownerRunnerId !== current.target || claim.epoch !== current.identity.epoch + 1) {
      throw new Error('The saved claim does not match the moving Bot workspace.');
    }
    return current;
  }

  closeSource(claim: WorkspaceMoveProof, moveId: string): void {
    const current = this.checkSourceReceipt(claim, moveId);
    const state = claim.state === 'claimed' ? 'moved' : 'cancelled';
    if (current.state !== state) this.save({ ...current, state });
    this.removePacks(moveId);
  }

  async discardTarget(proof: WorkspaceMoveProof, moveId: string, discard: () => Promise<void>): Promise<void> {
    const current = this.progress();
    if (!current || current.state !== 'receiving' || current.target !== this.runnerId || current.moveId !== moveId ||
        proof.state !== 'cancelled' || proof.moveId !== moveId || proof.workspaceId !== current.identity.workspaceId ||
        proof.ownerRunnerId !== current.identity.ownerRunnerId || proof.epoch !== current.identity.epoch) {
      throw new Error('The saved cancellation does not match this Bot workspace.');
    }
    await discard();
    this.save({ ...current, state: 'cancelled' });
    this.removePacks(moveId);
  }

  private removePacks(moveId: string): void {
    for (const file of [this.bundle(moveId), this.bundle(moveId) + '.sealed']) {
      try { rmSync(file, { force: true }); }
      catch { /* The retained owner-only pack can be reclaimed after the settled receipt. */ }
    }
  }
}
