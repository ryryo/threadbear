import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync, removeTempFiles } from '../fsutil.ts';
import { archive, MAX_SEALED_BYTES, sha256, unarchive, unpackedSize, type PackEntry } from '../move-pack.ts';
import { botOperationId, workspaceTransferConversations, type BotWorkspaceIdentity } from './repository.ts';
import { cleanTopic, entryId, MAIN, parseMemory } from './ported/memory-entries.js';
import { assertWorkspaceMemoryErased, eraseMemoryCopies, type RequiredNoteErasure } from './memory-erasure.js';
import type { BackupMemoryNote, MemoryChange, PersonalMemory } from './ported/personal-memory.js';

const backupScope = z.strictObject({ kind: z.enum(['bot', 'group']), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const memoryRevision = z.union([z.literal('empty'), z.uuid()]);
const managedBackupLocation = z.object({
  backupId: z.uuid(),
  scope: backupScope,
});
export const backupMemoryPreviewInput = managedBackupLocation;
export const backupMemoryRestoreInput = managedBackupLocation.extend({
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  entryId: z.string().min(1).max(128),
  expectedRevision: memoryRevision,
  operationId: botOperationId,
});
export type BackupMemoryRestoreInput = z.infer<typeof backupMemoryRestoreInput>;
export type BackupMemoryPreviewInput = z.infer<typeof backupMemoryPreviewInput>;
export const backupMemoryCreateInput = z.strictObject({ scope: backupScope, expectedRevision: memoryRevision, operationId: botOperationId });
export type BackupMemoryCreateInput = z.infer<typeof backupMemoryCreateInput>;

const MANIFEST = 'bots/memory-backup.json';
const STATE = 'bots/state.json';
const MAX_SCOPE_BACKUP_BYTES = 16 * 1024 * 1024;
const backupManifest = backupMemoryCreateInput.extend({ format: z.literal(1) });
type Manifest = z.infer<typeof backupManifest>;
type Scope = Manifest['scope'];
type CapturedBackup = { identity: BotWorkspaceIdentity; manifest: Manifest; files: PackEntry[] };

function prefixFor(scope: Scope): string {
  return `bots/memory/${scope.kind === 'group' ? 'group-' : ''}${scope.id}/`;
}

function sameScope(a: Scope, b: Scope): boolean { return a.kind === b.kind && a.id === b.id; }

function allowedNoteFile(file: string): boolean {
  const topic = cleanTopic(file);
  return file === MAIN || (topic !== undefined && file === `${topic}.md`);
}

export function managedBackupScope(files: readonly PackEntry[]): Scope | undefined {
  const marker = files.find(file => file.path === MANIFEST);
  if (!marker) return undefined;
  const { scope } = backupManifest.parse(JSON.parse(marker.data.toString('utf8')));
  const prefix = prefixFor(scope);
  for (const { path } of files) {
    if (path === MANIFEST || path === STATE) continue;
    if (!path.startsWith(prefix)) throw new Error('A scoped Bot backup contains a file outside its memory scope.');
    const name = path.slice(prefix.length);
    if (name !== 'journal.jsonl' && !allowedNoteFile(name)) throw new Error('A scoped Bot backup contains an unexpected file.');
  }
  return scope;
}

const asEntry = (path: string, text: string): PackEntry => ({ path, data: Buffer.from(text), mode: 0o600 });

function erasureReceipt(row: MemoryChange): MemoryChange {
  const { id, time, op, scope, file, entryId, transaction } = row;
  return { id, time, op, scope, file, entryId, transaction: transaction && { operationId: transaction.operationId, hash: transaction.hash } };
}

const journal = (path: string, rows: MemoryChange[]) => asEntry(path, rows.map(row => JSON.stringify(row) + '\n').join(''));

export function captureManagedMemoryBackup(identity: BotWorkspaceIdentity, input: BackupMemoryCreateInput, memory: PersonalMemory): CapturedBackup {
  const manifest = backupManifest.parse({ ...input, format: 1 });
  const history = memory.history();
  if ((history[0]?.id ?? 'empty') !== input.expectedRevision) throw new Error('These notes changed. Reload the current notes before backing them up.');
  const prefix = prefixFor(input.scope);
  const files = [
    asEntry(MANIFEST, JSON.stringify(manifest)),
    asEntry(STATE, JSON.stringify({ workspaceId: identity.workspaceId, ownerRunnerId: identity.ownerRunnerId,
      ownerEpoch: identity.epoch, formatVersion: 1, bots: [], conversations: [], pendingConversations: [] })),
    journal(prefix + 'journal.jsonl', history.filter(row => row.op === 'erase').reverse().map(erasureReceipt)),
  ];
  for (const file of memory.files()) {
    const lines = file.entries.map(row => {
      const line = file.lines[row.line];
      memory.refuseSecret(line);
      return line;
    });
    if (lines.length) files.push(asEntry(prefix + file.file, lines.join('\n') + '\n'));
  }
  if (unpackedSize(files) > MAX_SCOPE_BACKUP_BYTES) throw new Error('The selected Bot memory scope is too large to back up.');
  managedBackupScope(files);
  return { identity, manifest, files };
}

function backupIdFor(identity: BotWorkspaceIdentity, operationId: string): string {
  const hash = sha256(Buffer.from(JSON.stringify(['threadbear-bot-backup', identity.workspaceId, operationId])));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function savedManagedMemoryBackup(home: string, identity: BotWorkspaceIdentity, input: BackupMemoryCreateInput): string | undefined {
  const backupId = backupIdFor(identity, input.operationId);
  if (!lstatSync(join(home, 'bot-backups', backupId + '.pack'), { throwIfNoEntry: false })) return undefined;
  const { files } = openManagedMemoryBackup(home, { backupId });
  const marker = files.find(file => file.path === MANIFEST);
  const saved = backupManifest.parse(JSON.parse(marker?.data.toString('utf8') ?? 'null'));
  if (!sameScope(saved.scope, input.scope) || saved.operationId !== input.operationId || saved.expectedRevision !== input.expectedRevision) {
    throw new Error('This operation ID belongs to a different Bot backup.');
  }
  const state = files.find(file => file.path === STATE);
  if (!state) throw new Error('The Bot backup has no saved workspace identity.');
  workspaceTransferConversations(state.data.toString('utf8'), identity);
  return backupId;
}

export function saveManagedMemoryBackup(home: string, capture: CapturedBackup): string {
  const { files, identity, manifest } = capture;
  const prior = savedManagedMemoryBackup(home, identity, manifest);
  if (prior !== undefined) return prior;
  const root = join(home, 'bot-backups');
  if (!lstatSync(root, { throwIfNoEntry: false })) mkdirSync(root, { mode: 0o700 });
  if (!backupFolder(home)) throw new Error('The Bot backup folder is unavailable.');
  const id = backupIdFor(identity, manifest.operationId);
  atomicWriteFileSync(join(root, id + '.pack'), archive(files), 0o600);
  return id;
}

function backupFolder(home: string): string | undefined {
  const root = join(home, 'bot-backups');
  return lstatSync(root, { throwIfNoEntry: false })?.isDirectory() ? root : undefined;
}

export function listManagedMemoryBackups(home: string): { id: string; updatedAt: string }[] {
  const root = backupFolder(home);
  if (!root) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(file => {
    const id = file.name.replace(/\.pack$/, '');
    if (id === file.name || !file.isFile() || !z.uuid().safeParse(id).success) return [];
    const info = lstatSync(join(root, file.name), { throwIfNoEntry: false });
    return info?.isFile() && info.size <= MAX_SEALED_BYTES ? [{ id, updatedAt: info.mtime.toISOString() }] : [];
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function readManagedMemoryBackup(home: string, input: BackupMemoryRestoreInput): PackEntry[] {
  return openManagedMemoryBackup(home, input).files;
}

export function openManagedMemoryBackup(home: string, input: { backupId: string; checksum?: string }): { files: PackEntry[]; checksum: string } {
  const root = backupFolder(home);
  if (!root) throw new Error('The Bot backup folder is unavailable.');
  const path = join(root, z.uuid().parse(input.backupId) + '.pack');
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size > MAX_SEALED_BYTES) throw new Error('The selected Bot backup is unavailable or too large.');
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = fstatSync(file);
    if (!current.isFile() || current.size > MAX_SEALED_BYTES) throw new Error('The selected Bot backup is unavailable or too large.');
    const pack = readFileSync(file);
    if (pack.length > MAX_SEALED_BYTES) throw new Error('The selected Bot backup is too large.');
    const checksum = sha256(pack);
    if (input.checksum !== undefined && checksum !== input.checksum) throw new Error('The Bot backup does not match the selected checksum.');
    return { files: unarchive(pack), checksum };
  } finally {
    closeSync(file);
  }
}

export function scrubManagedMemoryBackups(home: string, identity: BotWorkspaceIdentity, required: RequiredNoteErasure, receipt: MemoryChange): void {
  const path = join(home, 'bot-backups');
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  const root = backupFolder(home);
  if (!root) throw new Error('The Bot backup folder is unavailable.');
  removeTempFiles(root);
  const prefix = prefixFor(required.scope);
  const journalPath = prefix + 'journal.jsonl';
  for (const candidate of readdirSync(root)) {
    if (/^\..+\.pack\.\d+\.[0-9a-f]{8}\.tmp$/.test(candidate)) throw new Error('A Bot backup write has not been recovered.');
    const backupId = candidate.replace(/\.pack$/, '');
    if (backupId === candidate || !z.uuid().safeParse(backupId).success) continue;
    const { files } = openManagedMemoryBackup(home, { backupId });
    const state = files.find(file => file.path === STATE);
    const workspaceId = z.uuid().parse(JSON.parse(state?.data.toString('utf8') ?? 'null')?.workspaceId);
    if (workspaceId !== identity.workspaceId) continue;
    const capturedScope = managedBackupScope(files);
    if (!capturedScope) {
      // Pre-staged full workspace packs may include review snapshots and other
      // history that the scoped writer never copies. Do not overwrite them.
      const containsScope = files.some(file => file.path.startsWith(prefix));
      const hasReviews = required.scope.kind === 'bot' && files.some(file => file.path.startsWith('bots/reviews/'));
      if (containsScope || hasReviews) assertWorkspaceMemoryErased(files, [required]);
      continue;
    }
    if (!sameScope(capturedScope, required.scope)) continue;
    const content = files.flatMap(file => file.path.startsWith(prefix) && file.path !== journalPath
      ? [{ file: file.path.slice(prefix.length), content: file.data.toString('utf8') }] : []);
    const savedJournal = files.find(file => file.path === journalPath);
    if (!savedJournal) throw new Error('The Bot backup has no memory erasure journal.');
    const history: MemoryChange[] = savedJournal.data.toString('utf8').split('\n').filter(Boolean).map(row => JSON.parse(row));
    const { rows, steps } = eraseMemoryCopies(required.entryId, content, history, true);
    const prior = rows.some(row => row.op === 'erase' && row.entryId === required.entryId);
    if (!prior) rows.push(erasureReceipt(receipt));
    const rewritten = files.map(file => {
      if (file.path === journalPath) return journal(journalPath, rows);
      const removed = steps.find(step => file.path === prefix + step.path);
      return removed ? asEntry(file.path, removed.text) : file;
    });
    assertWorkspaceMemoryErased(rewritten, [required]);
    if (steps.length || !savedJournal.data.equals(rewritten.find(file => file.path === journalPath)!.data)) {
      atomicWriteFileSync(join(root, candidate), archive(rewritten), 0o600);
    }
  }
}

export function scopedBackupNotes(files: readonly PackEntry[], scope: BackupMemoryRestoreInput['scope'], checksum: string): BackupMemoryNote[] {
  const capturedScope = managedBackupScope(files);
  if (capturedScope && !sameScope(capturedScope, scope)) return [];
  const prefix = prefixFor(scope);
  const matches: BackupMemoryNote[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const name = file.path.slice(prefix.length);
    if (!/^[^/]+\.md$/.test(name)) continue;
    const parsed = parseMemory(file.data.toString('utf8'));
    for (const row of parsed.entries) {
      matches.push({ entryId: entryId(row), file: name, line: parsed.lines[row.line], checksum });
    }
  }
  return matches;
}

export function selectBackupMemoryNote(files: readonly PackEntry[], input: BackupMemoryRestoreInput): BackupMemoryNote {
  const matches = scopedBackupNotes(files, input.scope, input.checksum).filter(note => note.entryId === input.entryId);
  if (matches.length !== 1) throw new Error('The backup does not contain one matching note in the selected scope.');
  return matches[0];
}
