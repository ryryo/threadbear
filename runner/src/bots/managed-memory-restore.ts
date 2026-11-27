import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_SEALED_BYTES, sha256, unarchive, type PackEntry } from '../move-pack.ts';
import { botOperationId } from './repository.ts';
import { entryId, parseMemory } from './ported/memory-entries.js';
import type { BackupMemoryNote } from './ported/personal-memory.js';

const managedBackupLocation = z.object({
  backupId: z.uuid(),
  scope: z.object({ kind: z.enum(['bot', 'group']), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
});
export const backupMemoryPreviewInput = managedBackupLocation;
export const backupMemoryRestoreInput = managedBackupLocation.extend({
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  entryId: z.string().min(1).max(128),
  expectedRevision: z.union([z.literal('empty'), z.uuid()]),
  operationId: botOperationId,
});
export type BackupMemoryRestoreInput = z.infer<typeof backupMemoryRestoreInput>;
export type BackupMemoryPreviewInput = z.infer<typeof backupMemoryPreviewInput>;

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

export function scopedBackupNotes(files: readonly PackEntry[], scope: BackupMemoryRestoreInput['scope'], checksum: string): BackupMemoryNote[] {
  const prefix = 'bots/memory/' + (scope.kind === 'group' ? 'group-' : '') + scope.id + '/';
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
