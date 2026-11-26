export type MemoryNote = { id: string; text: string; pinned: boolean; until?: string };
export type MemoryChange = {
  id: string;
  time: string;
  op: 'add' | 'remove' | 'replace';
  before?: string;
  after?: string;
  restored?: string;
  sourceThreadId?: string;
};

export class PersonalMemory {
  constructor(root: string);
  list(today: string): MemoryNote[];
  history(): MemoryChange[];
  add(text: string, options: { until?: string; sourceThreadId?: string }, time: string): MemoryNote;
  replace(id: string, text: string, time: string): MemoryNote;
  remove(id: string, time: string): void;
  restore(id: string, time: string): void;
}
