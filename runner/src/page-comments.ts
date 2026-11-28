// Display ranges into the already-authorized message. The payload has no
// independent strings or file paths to publish or to resolve on this runner.
export const PAGE_COMMENTS_API = 113;

export type PageCommentRef = {
  block: [number, number];
  title: [number, number];
  url: [number, number];
  target: [number, number];
  comment: [number, number];
  image?: number;
};

export function pageCommentsInText(raw: unknown, text: string, images: number): PageCommentRef[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) return undefined;
  const bytes = Buffer.from(text, 'utf8');
  const boundary = (n: number): boolean => n === bytes.length || (n < bytes.length && (bytes[n]! & 0xc0) !== 0x80);
  function pair(value: unknown): [number, number] | undefined {
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [start, end] = value as [number, number];
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end
      && boundary(start) && boundary(end) ? [start, end] : undefined;
  }
  const out: PageCommentRef[] = [];
  let previous = 0;
  for (const value of raw as unknown[]) {
    if (!value || typeof value !== 'object') return undefined;
    const { block: b, title: t, url: u, target: x, comment: c, image } = value as Record<string, unknown>;
    const block = pair(b), title = pair(t), url = pair(u), target = pair(x), comment = pair(c);
    if (!block || !title || !url || !target || !comment || block[0] < previous
      || !bytes.toString('utf8', block[0], block[1]).startsWith('Page comment on ')) return undefined;
    let at = block[0];
    for (const [start, end] of [title, url, target, comment]) {
      if (start < at || end > block[1]) return undefined;
      at = end;
    }
    if (image !== undefined && (typeof image !== 'number' || !Number.isSafeInteger(image) || image < 0 || image >= images)) return undefined;
    const slice = (from: number, to: number) => bytes.toString('utf8', from, to);
    if (title[0] !== block[0] + 'Page comment on '.length
      || slice(title[1], url[0]) !== '\n' || slice(url[1], target[0]) !== '\n'
      || slice(target[1], comment[0]) !== (comment[0] === comment[1] ? '' : '\n')
      || slice(comment[1], block[1]) !== (typeof image === 'number' ? ` [Picture ${image + 1}]` : '')) return undefined;
    out.push({ block, title, url, target, comment, ...(typeof image === 'number' ? { image } : {}) });
    previous = block[1];
  }
  return out;
}
