import japanese from './profile-ja.json' with { type: 'json' };

export const language = new URLSearchParams(globalThis.location?.search).get('lang') === 'ja' ? 'ja' : 'en';
export const t = (text, fields = {}) => (language === 'ja' ? japanese[text] ?? text : text)
  .replace(/\{(\w+)\}/g, (slot, field) => fields[field] ?? slot);
