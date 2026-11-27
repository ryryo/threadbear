import type { PackEntry } from '../move-pack.ts';
import type { MemoryChange } from './ported/personal-memory.js';

export type RequiredNoteErasure = {
  scope: { kind: 'bot' | 'group'; id: string };
  entryId: string;
};

export function assertWorkspaceMemoryErased(entries: readonly PackEntry[], requirements: readonly RequiredNoteErasure[]): void;
export function eraseMemoryCopies(id: string, files: readonly { file: string; content: string }[], history: readonly MemoryChange[], allowMissing?: boolean): {
  rows: MemoryChange[];
  steps: { path: string; action: 'write'; text: string }[];
};
