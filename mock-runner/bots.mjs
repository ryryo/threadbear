// Local Bot UI fixture. It uses the same note storage as the Runner and the
// server's ordinary demo thread rows for each new conversation.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PersonalMemory } from '../runner/src/bots/ported/personal-memory.js';

export function botDemo({ dataDir, createThread, error }) {
  const bots = new Map();
  const conversations = new Map();
  return (method, p) => {
    if (method === 'bots.status') return { enabled: true, available: true };
    if (method === 'bots.list') return { bots: [...bots.values()] };
    if (method === 'bots.create') {
      const name = String(p.name ?? '').trim();
      if (!name) throw error(-32602, 'A Bot needs a name');
      if ([...bots.values()].some(bot => bot.name === name)) throw error(-32602, 'This Bot already exists');
      const bot = { id: randomUUID(), name, role: '', instructions: '', revision: 1 };
      bots.set(bot.id, bot);
      conversations.set(bot.id, new Map());
      return { bot };
    }
    const bot = bots.get(p.botId);
    if (!bot) throw error(-32602, 'Unknown Bot');
    const links = conversations.get(bot.id);
    if (method === 'bots.get') return { bot, conversations: [...links.values()].map(row => row.conversation) };
    if (method === 'bots.conversations.create') {
      const saved = links.get(p.operationId);
      if (saved) return saved;
      const conversation = { id: randomUUID(), botId: bot.id, threadId: randomUUID() };
      const row = { conversation, thread: createThread(bot, conversation) };
      links.set(p.operationId, row);
      return row;
    }
    if (![...links.values()].some(row => row.conversation.threadId === p.threadId)) throw error(-32602, 'Unknown Bot conversation');
    const now = new Date().toISOString();
    const memory = new PersonalMemory(join(dataDir, 'bot-demo', bot.id));
    if (method === 'bots.memory.read') return { notes: memory.list(now.slice(0, 10)) };
    if (method === 'bots.memory.add') return { note: memory.add(p.text, { sourceThreadId: p.threadId }, now) };
    if (method === 'bots.memory.history') return { rows: memory.history(), more: null };
    throw error(-32601, `Unknown method ${method}`);
  };
}
