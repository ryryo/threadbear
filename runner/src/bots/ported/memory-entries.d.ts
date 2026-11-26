export const MEMORY_LIMITS: { entry: number };
export function cleanEntry(raw: unknown): string;
export function cleanDay(raw: unknown): string | undefined;
export function looksSecret(raw: string): boolean;
export function parseReview(text: string): {
  changes: { op: 'add' | 'edit' | 'remove'; entry?: number; text?: string; until?: unknown; team?: unknown; topic?: unknown; for?: unknown; group?: unknown }[];
  leftOut: unknown[];
} | undefined;
