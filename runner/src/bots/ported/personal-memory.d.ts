export type MemoryNote = { id: string; text: string; pinned: boolean; until?: string };

export class PersonalMemory {
  constructor(root: string);
  list(today: string): MemoryNote[];
  add(text: string, options: { until?: string; sourceThreadId?: string }, time: string): MemoryNote;
  replace(id: string, text: string, time: string): MemoryNote;
  remove(id: string, time: string): void;
  restore(id: string, time: string): void;
}
