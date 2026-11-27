export const MEMORY_LIMITS: { entry: number; bot: number; team: number; group: number };
export function cleanEntry(raw: unknown): string;
export function cleanDay(raw: unknown): string | undefined;
export function looksSecret(raw: string): boolean;
export function parseReview(text: string): {
  changes: { op: 'add' | 'edit' | 'remove'; entry?: number; text?: string; until?: unknown; team?: unknown; topic?: unknown; for?: unknown; group?: unknown }[];
  leftOut: unknown[];
} | undefined;

type MemoryEntry = { line: number; text: string; meta?: { id?: string } };
export function parseMemory(content: unknown): { lines: string[]; entries: MemoryEntry[]; links: string[] };
export function entryId(entry: Pick<MemoryEntry, 'meta' | 'text'>): string;
