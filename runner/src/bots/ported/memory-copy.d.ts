export const REVIEW_CHANGES_MAX: number;
export function reviewSystem(options?: { teamWrites?: boolean; group?: boolean; routes?: boolean; rooms?: string[] }): string;
export function writtenIn(texts: string[], fallback: string): string;
export function tidySystem(options: { who: string; max: number }): string;
export function tidyRequest(options: { entries: { text: string; file: { topic?: string }; meta: { added?: string } }[]; language: string }): string;
export function reviewRequest(options: {
  who: string;
  tag?: 'own' | 'group';
  numbered: { scope: 'own' | 'group'; file: { topic?: string }; meta?: { pinned?: boolean }; text: string }[];
  where: string;
  earlier: string[];
  fresh: string[];
  more: boolean;
  language: string;
}): string;
