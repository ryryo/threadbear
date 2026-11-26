import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

When('I choose Japanese as the desktop language', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Use Japanese', settings: true });
});

When('I choose English as the desktop language', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: '英語で表示する', settings: true });
});

Then('the Settings title is {string} in {string}', async function (this: ThreadbearWorld, title: string, locale: string) {
  await this.until(`Settings title ${title} in ${locale}`, (dump) => {
    const settings = (dump as { settingsWindow?: { title: string; locale: string } }).settingsWindow;
    return settings?.title === title && settings.locale === locale;
  });
});


When('I relaunch the localized desktop', async function (this: ThreadbearWorld) {
  await this.app.relaunch();
});
