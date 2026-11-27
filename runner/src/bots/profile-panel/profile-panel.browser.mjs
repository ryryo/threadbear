import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { ProfilePanel } from './profile-panel.mjs';
import { language, t } from './avatar-i18n.mjs';

const code = window.location.hash.slice(1);
const { pathname, search } = window.location;
window.history.replaceState(null, '', pathname + search);
const preferences = new URLSearchParams(search);
document.documentElement.lang = language;
document.body.toggleAttribute('data-ds-dark-theme', preferences.get('theme') === 'dark');
const root = createRoot(document.getElementById('root'));

async function request(path, method, data) {
  const response = await fetch(path, {
    method,
    headers: { 'X-Threadbear-Profile': code, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

try {
  const initial = await request('/api/profile', 'GET');
  const selected = botId => {
    if (botId !== initial.id) throw new Error('Reopen this Bot profile in Threadbear.');
  };
  root.render(h(ProfilePanel, {
    initial, t, appearance: true,
    async callOwner(method, params) {
      if (!['bots.update', 'bots.updateAppearance'].includes(method)) throw new Error('This Bot profile cannot be saved here.');
      selected(params.botId);
      const { botId: _id, ...patch } = params;
      return request(method === 'bots.updateAppearance' ? '/api/appearance' : '/api/profile', 'PATCH', patch);
    },
    memory: {
      async memoryView(botId) {
        selected(botId);
        const { count } = await request('/api/memory-count', 'GET');
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Could not read the Bot’s memory count.');
        // DS-Bot's unchanged hook only reads entries.length.
        return { entries: { length: count } };
      },
      async openMemory(botId) {
        selected(botId);
        await request('/api/open-memory', 'POST');
      },
    },
  }));
} catch (error) {
  root.render(h('p', { role: 'alert' }, error.message));
}
