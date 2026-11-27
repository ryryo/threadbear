type SearchLine = { seq: number; time: string | number; text?: string; botId?: string; who?: string };
type HitLine = { seq: number; time: string | number; text: string; botId?: string; name?: string };

export function searchGroupBook(
  records: readonly SearchLine[], query: string, options?: { before?: number; offset?: number },
): { results: (HitLine & { before?: HitLine; after?: HitLine })[]; hasMore: boolean };
