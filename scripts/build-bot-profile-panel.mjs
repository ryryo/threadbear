import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { avatarStyle } from '../runner/src/bots/profile-panel/avatar-style.mjs';

const assets = new URL('../runner/src/bots/profile-panel/', import.meta.url);
const bundled = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: [fileURLToPath(new URL('profile-panel.browser.mjs', assets))],
  bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'chrome120', write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
});
const file = new URL('profile.js.gz', assets);
const css = new URL('avatar.css', assets);
const bytes = Buffer.from(bundled.outputFiles[0].contents);
if (process.argv.includes('--check')) {
  if (!gunzipSync(readFileSync(file)).equals(bytes) || readFileSync(css, 'utf8') !== avatarStyle) {
    throw new Error('Run node scripts/build-bot-profile-panel.mjs to rebuild the Bot profile assets.');
  }
} else {
  writeFileSync(file, gzipSync(bytes, { level: 9 }));
  writeFileSync(css, avatarStyle);
}
