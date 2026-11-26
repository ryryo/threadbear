import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWebLocale } from './i18n/locales.ts';

test('the Web language setting overrides browser preferences', () => {
  assert.equal(resolveWebLocale('ja', ['en-US']), 'ja');
  assert.equal(resolveWebLocale('en', ['ja-JP']), 'en');
});

test('the Web system setting follows the first supported browser language', () => {
  assert.equal(resolveWebLocale('system', ['fr-FR', 'ja-JP', 'en-GB']), 'ja');
  assert.equal(resolveWebLocale('system', ['en-GB', 'ja']), 'en');
  assert.equal(resolveWebLocale('system', ['fr-FR']), 'en');
});
