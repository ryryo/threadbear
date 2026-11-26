import { msg, useMessages } from 'gt-react';
import { useSyncExternalStore } from 'react';
import { readLanguage, setLanguage, subscribeLanguage } from '../language';
import { MenuChoice, Pop } from '../menu';
import * as Icon from '../icons';

export function LanguageChoices() {
  const m = useMessages();
  const language = useSyncExternalStore(subscribeLanguage, readLanguage);
  return (
    <>
      <MenuChoice icon={<Icon.Globe />} label={m(msg('Use browser language'))} on={language === 'system'} pick={() => setLanguage('system')} />
      <MenuChoice icon={<Icon.Globe />} label="English" on={language === 'en'} pick={() => setLanguage('en')} />
      <MenuChoice icon={<Icon.Globe />} label="日本語" on={language === 'ja'} pick={() => setLanguage('ja')} />
    </>
  );
}

export function LanguageMenu() {
  const m = useMessages();
  return <Pop title={m(msg('Language'))} icon={<Icon.Globe />}>{() => <LanguageChoices />}</Pop>;
}
