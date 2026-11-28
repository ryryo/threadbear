import { v, type Infer } from 'convex/values';

const span = v.array(v.number());
const commentRef = v.object({
  block: span, title: span, url: span, target: span, comment: span, image: v.optional(v.number()),
});
export const pageComments = v.array(commentRef);
type PageComment = Infer<typeof commentRef>;

// A runner's write is not trusted to say what to show or hide by itself.
// The ranges carry only display information for the matching public text.
export function pageCommentsInText(raw: unknown, text: string, images: number): PageComment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) return undefined;
  const bytes = new TextEncoder().encode(text);
  const boundary = (n: number): boolean => n === bytes.length || (n < bytes.length && (bytes[n]! & 0xc0) !== 0x80);
  function pair(value: unknown): [number, number] | undefined {
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [start, end] = value as [number, number];
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end
      && boundary(start) && boundary(end) ? [start, end] : undefined;
  }
  const out: PageComment[] = [];
  let previous = 0;
  const prefix = new TextEncoder().encode('Page comment on ');
  for (const value of raw as unknown[]) {
    if (!value || typeof value !== 'object') return undefined;
    const { block: b, title: t, url: u, target: x, comment: c, image } = value as Record<string, unknown>;
    const block = pair(b), title = pair(t), url = pair(u), target = pair(x), comment = pair(c);
    if (!block || !title || !url || !target || !comment || block[0] < previous
      || block[1] - block[0] < prefix.length
      || !prefix.every((byte, i) => bytes[block[0] + i] === byte)) return undefined;
    let at = block[0];
    for (const [start, end] of [title, url, target, comment]) {
      if (start < at || end > block[1]) return undefined;
      at = end;
    }
    if (image !== undefined && (typeof image !== 'number' || !Number.isSafeInteger(image) || image < 0 || image >= images)) return undefined;
    const decoder = new TextDecoder();
    const slice = (from: number, to: number) => decoder.decode(bytes.subarray(from, to));
    if (title[0] !== block[0] + 'Page comment on '.length
      || slice(title[1], url[0]) !== '\n' || slice(url[1], target[0]) !== '\n'
      || slice(target[1], comment[0]) !== (comment[0] === comment[1] ? '' : '\n')
      || slice(comment[1], block[1]) !== (typeof image === 'number' ? ` [Picture ${image + 1}]` : '')) return undefined;
    out.push({ block, title, url, target, comment, ...(typeof image === 'number' ? { image } : {}) });
    previous = block[1];
  }
  return out;
}
