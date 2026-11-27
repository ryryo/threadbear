import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { ProfilePanel } from './profile-panel.mjs';
import japanese from './profile-ja.json' with { type: 'json' };

const code = window.location.hash.slice(1);
const { pathname, search } = window.location;
window.history.replaceState(null, '', pathname + search);
const preferences = new URLSearchParams(search);
const language = preferences.get('lang') === 'ja' ? 'ja' : 'en';
const t = text => language === 'ja' ? japanese[text] ?? text : text;
document.documentElement.lang = language;
document.body.toggleAttribute('data-ds-dark-theme', preferences.get('theme') === 'dark');
const root = createRoot(document.getElementById('root'));

async function profile(method, data) {
  const response = await fetch('/api/profile', {
    method,
    headers: { 'X-Threadbear-Profile': code, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

try {
  const initial = await profile('GET');
  root.render(h(ProfilePanel, {
    initial, t,
    callOwner(method, params) {
      if (method !== 'bots.update' || params.botId !== initial.id) throw new Error('This Bot profile cannot be saved here.');
      const { botId: _id, ...patch } = params;
      return profile('PATCH', patch);
    },
  }));
} catch (error) {
  root.render(h('p', { role: 'alert' }, error.message));
}
