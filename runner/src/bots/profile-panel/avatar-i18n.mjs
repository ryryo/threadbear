import japanese from './profile-ja.json' with { type: 'json' };

export const language = new URLSearchParams(globalThis.location?.search).get('lang') === 'ja' ? 'ja' : 'en';
export const t = (text, fields = {}) => (language === 'ja' ? japanese[text] ?? text : text)
  .replace(/\{(\w+)\}/g, (slot, field) => fields[field] ?? slot);

// Avatar errors from DS-Bot's HOST_ERRORS_JA.
const avatarErrors = [
  [/^The avatar library holds at most (\d+) photos\.$/, 'アバターライブラリには最大 $1 枚まで写真を保存できます。'],
  [/^The avatar must be a PNG, JPEG, WebP, or GIF image\. Use a square image; 256x256 is recommended\.$/, 'アバターは PNG、JPEG、WebP、または GIF 画像にしてください。正方形の画像（256x256 推奨）を使用してください。'],
  [/^The avatar image is too large: .+$/, 'アバター画像のサイズが大きすぎます'],
];

export function hostText(message) {
  if (language === 'en') return message;
  if (Object.hasOwn(japanese, message)) return t(message);
  const match = avatarErrors.find(([pattern]) => pattern.test(message));
  return match ? message.replace(...match) : message;
}
