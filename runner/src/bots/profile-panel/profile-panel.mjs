import { createElement as h, useRef, useState } from 'react';
import { BotProfileCards } from './profile-cards.mjs';
import { profileActions } from './profile-actions.mjs';

export function ProfilePanel({ initial, callOwner, t }) {
  const [bot, setBot] = useState(initial);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(0);
  const current = useRef(initial);
  const actions = profileActions({
    visibleProfile: () => current.current,
    callOwner: async (method, params) => {
      setError(null);
      setPending(value => value + 1);
      try {
        return await callOwner(method, params);
      } finally {
        setPending(value => value - 1);
      }
    },
    acceptProfile: profile => {
      current.current = profile;
      setBot(profile);
    },
    report: setError,
  });
  return h('main', null,
    h(BotProfileCards, { bot, actions, t }),
    pending > 0 ? h('p', { role: 'status' }, t('Saving…')) : null,
    error ? h('p', { role: 'alert' }, error.message) : null);
}
