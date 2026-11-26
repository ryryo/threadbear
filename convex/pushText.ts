// What a push says for a thread that needs Mike: the thread's title, and
// a line about why. Plain TypeScript with no Convex imports, so the
// runner's unit tests can check it.

export type PushThread = {
  title: string;
  mac?: string; // a runner key's Mac (devices.ts threadForPush): named in the title
  status: string;
  preview: string;
  pendingApproval?:
    | { kind: 'approval'; name: string; title: string; inputSummary?: string }
    | { kind: 'question'; questions: { question: string }[] }
    | { kind: 'secret'; label: string };
};

export const PUSH_BODY_CHARS = 180;

export type PushLocale = 'en' | 'ja';

export function pushLocale(tag: string | undefined): PushLocale {
  return tag?.split('-')[0].toLowerCase() === 'ja' ? 'ja' : 'en';
}

export function testNotification(locale?: PushLocale): string {
  return locale === 'ja' ? 'テスト通知' : 'Test notification';
}

export function pushText(t: PushThread, locale?: PushLocale): { title: string; body: string } {
  // A thread on a Mac with a runner key says which, so a push asking for a
  // secret or an approval can't pass for one from the main Mac.
  const title = t.mac ? `${t.mac} · ${t.title || 'Threadbear'}` : t.title || 'Threadbear';
  const p = t.pendingApproval;
  const japanese = locale === 'ja';
  let body: string;
  if (p?.kind === 'question') body = p.questions[0]?.question ?? (japanese ? '質問があります' : 'Has a question for you');
  else if (p?.kind === 'secret') body = japanese ? `シークレットの入力を求められています：${p.label}` : `Asking for a secret: ${p.label}`;
  else if (p?.kind === 'approval') body = p.inputSummary ? `${p.title}${japanese ? '：' : ': '}${p.inputSummary}` : p.title;
  else if (t.status === 'error') {
    if (t.preview) body = japanese ? `失敗：${t.preview}` : `Failed: ${t.preview}`;
    else body = japanese ? '直前のターンが失敗しました' : 'The last turn failed';
  } else body = t.preview || (japanese ? '完了しました' : 'Finished');
  body = body.replace(/\s+/g, ' ').trim();
  if (body.length > PUSH_BODY_CHARS) body = body.slice(0, PUSH_BODY_CHARS - 1) + '…';
  return { title, body };
}
