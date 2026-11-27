import type { PackEntry } from '../move-pack.ts';

export type RequiredNoteErasure = {
  scope: { kind: 'bot' | 'group'; id: string };
  entryId: string;
};

export function assertWorkspaceMemoryErased(entries: readonly PackEntry[], requirements: readonly RequiredNoteErasure[]): void;
