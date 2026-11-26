// Derived from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a,
// ds-bot/src/host/privacy.js (spellings and overlap).
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Compare both the path as written and as the filesystem resolves it, including
// an existing symlink above the missing tail of a prospective folder.
function realBeyond(absolute: string): string {
  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling link is not a missing folder: its destination is unknown.
      try {
        if (lstatSync(head).isSymbolicLink()) throw new Error('Could not resolve a Bot folder through a dangling link');
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
      }
      const parent = dirname(head);
      if (parent === head) throw error;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

const fold = (text: string): string => process.platform === 'linux' ? text : text.normalize('NFC').toLowerCase();
const spelling = (path: string): string[] => {
  const absolute = resolve(path);
  return [...new Set([fold(absolute), fold(realBeyond(absolute))])];
};
const within = (path: string, root: string): boolean => {
  const delta = relative(root, path);
  return delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
};
const overlap = (a: string, b: string): boolean => within(a, b) || within(b, a);

export function foldersOverlap(folder: string, other: string): boolean {
  const right = spelling(other);
  return spelling(folder).some(left => right.some(path => overlap(left, path)));
}
