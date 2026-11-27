import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { sha256 } from '../move-pack.ts';
import { scrubManagedMemoryBackups } from './managed-memory-restore.ts';
import type { RequiredNoteErasure } from './memory-erasure.js';
import { PersonalMemory } from './ported/personal-memory.js';
import { workspaceTransferConversations, type BotWorkspaceIdentity } from './repository.ts';
import { ReviewCheckpoints } from './review-checkpoints.ts';

// Only called with a matching moved fence under the primary Runner lock.
export function scrubRetiredWorkspaceNote(home: string, identity: BotWorkspaceIdentity, note: RequiredNoteErasure, protect: () => void): void {
  const { scope, entryId } = note;
  const id = z.uuid().parse(scope.id);
  const root = join(home, 'bots');
  const state = join(root, 'state.json');
  if (!lstatSync(root).isDirectory() || !lstatSync(state).isFile()) throw new Error('The retired Bot workspace needs its original state file.');
  const links = workspaceTransferConversations(readFileSync(state, 'utf8'), identity);
  const folder = scope.kind === 'bot' ? id : 'group-' + id;
  const memory = new PersonalMemory(join(root, 'memory', folder), { base: root, scope: scope.kind === 'bot' ? 'own' : 'group' });
  const operationId = 'retired-note-' + sha256(Buffer.from(JSON.stringify([identity.workspaceId, identity.epoch, scope.kind, id, entryId])));
  const hash = sha256(Buffer.from(JSON.stringify({ op: 'erase', id: entryId })));
  const erasure = (row: ReturnType<typeof memory.history>[number]) =>
    row.op === 'erase' && row.entryId === entryId && row.transaction?.hash === hash;
  protect();
  let history = memory.history();
  let receipt = history.find(erasure);
  if (!receipt) {
    memory.erase(entryId, operationId, history[0]?.id ?? 'empty', new Date().toISOString(), protect, true);
    history = memory.history();
    receipt = history.find(erasure);
  }
  if (!receipt) throw new Error('The retired Bot note erasure receipt is missing.');
  if (scope.kind === 'bot') {
    new ReviewCheckpoints(join(root, 'reviews')).eraseMemoryCopies(id, links.filter(link => link.botId === id), history);
  }
  scrubManagedMemoryBackups(home, identity, note, receipt);
}
