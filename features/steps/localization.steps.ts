import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

When('I choose Japanese as the desktop language', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Use Japanese', settings: true });
});

When('I choose English as the desktop language', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: '英語で表示する', settings: true });
});

When('I choose the system language for the desktop', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'OSの言語設定に従う', settings: true });
});

When('I relaunch the desktop with a Japanese Linux session locale', async function (this: ThreadbearWorld) {
  const previous = process.env.LANGUAGE;
  const previousAll = process.env.LC_ALL;
  try {
    await this.app.relaunch(() => {
      process.env.LANGUAGE = 'ja';
      process.env.LC_ALL = 'ja_JP.UTF-8';
    });
  } finally {
    if (previous === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = previous;
    if (previousAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previousAll;
  }
});

Then("the desktop's language preference is {string}", async function (this: ThreadbearWorld, language: string) {
  await this.until(`desktop language preference ${language}`, (dump) => {
    const settings = (dump as { settingsWindow?: { language: string } }).settingsWindow;
    return settings?.language === language;
  });
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
