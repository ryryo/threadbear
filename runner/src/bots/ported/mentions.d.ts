export function nameProblem(name: string): string | undefined;
type Mention<T> = { start: number; end: number } & ({ bot: T } | { all: true });
export function mentionSpans<T extends { name: string }>(text: string, bots: readonly T[], options?: { references?: string[] }): Mention<T>[];
