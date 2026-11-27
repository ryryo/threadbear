import { characterMarkup, lookOf, markupCache, MASK_ID, shapeOf } from './profile-panel/characters.mjs';
import { INKS } from './profile-panel/inks.mjs';

// Give DS-Bot's unchanged character a standalone SVG view for native rows.
// Unlike the profile's DOM, a native image has no inherited theme variables.
export function rosterMark(bot) {
  const { shape, color } = lookOf(bot);
  const { size } = shapeOf(shape);
  if (markupCache.size >= 512) markupCache.clear();
  const body = characterMarkup(shape, color).replaceAll(MASK_ID, 'bot-mark');
  const svg = mode => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${
    body.replace(/var\(--bt-ink-([a-z-]+)\)/g, (_, ink) => INKS[ink]?.[mode] ?? INKS.gray[mode])}</svg>`;
  const light = svg(0);
  const dark = svg(1);
  return light === dark ? { light } : { light, dark };
}
