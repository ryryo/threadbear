import { createElement as h, useRef, useState } from 'react';
import { BotProfileCards } from './profile-cards.mjs';
import { profileActions } from './profile-actions.mjs';

export function ProfilePanel({ initial, callOwner, memory, appearance, t }) {
  const [bot, setBot] = useState(initial);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(0);
  const current = useRef(initial);
  const saves = useRef(new Set());
  const queue = useRef(Promise.resolve());
  const actions = profileActions({
    visibleProfile: () => current.current,
    appearance,
    callOwner,
    enqueue: work => {
      setError(null);
      setPending(value => value + 1);
      const save = queue.current.then(work);
      queue.current = save.then(() => {}, () => {});
      saves.current.add(save);
      return save.finally(() => {
        saves.current.delete(save);
        setPending(value => value - 1);
      });
    },
    acceptProfile: profile => {
      current.current = profile;
      setBot(profile);
    },
    report: setError,
  });
  if (memory) {
    actions.memoryView = memory.memoryView;
    actions.openMemory = async botId => {
      try {
        // Focusing Manage can blur an edited profile field first.
        if ((await Promise.all(saves.current)).includes(false)) return;
        await memory.openMemory(botId);
      } catch (error) {
        setError(error);
      }
    };
  }
  return h('main', null,
    h(BotProfileCards, { bot, actions, appearance, t, run: result => result.catch(setError) }),
    pending > 0 ? h('p', { role: 'status' }, t('Saving…')) : null,
    error ? h('p', { role: 'alert' }, error.message) : null);
}
