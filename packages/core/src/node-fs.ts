// The desktop's `FileSystemPort` (N1a).
//
// Thin by design: every method is the `node:fs` call core already made, with
// ENOENT turned into a return value at the ONE place that is allowed to know
// what ENOENT is. Everything else propagates untouched — a permission error
// reaching a caller as a permission error is the whole point of not
// normalising errors here.

import { statSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileStat, FileSystemPort } from './portable/ports/fs.js';
import { uuid } from './portable/runtime/random.js';

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export function nodeFileSystem(): FileSystemPort {
  return {
    statSync(path: string): FileStat | null {
      try {
        return { size: statSync(path).size };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    unlinkSync(path: string): boolean {
      try {
        unlinkSync(path);
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },

    async readText(path: string): Promise<string | null> {
      try {
        return await readFile(path, 'utf-8');
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    /**
     * Temp sibling, then rename (R22).
     *
     * The temp name is random rather than derived from the target: two writers
     * for the same file would otherwise share one temp path, and the loser
     * would rename the winner's half-written bytes into place. The sibling has
     * to be in the SAME directory — a rename across filesystems is a copy, and
     * a copy has the truncation window this method exists to close.
     */
    async writeTextAtomic(path: string, text: string): Promise<void> {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      const tmpPath = join(dir, `.${uuid()}.tmp`);
      try {
        await writeFile(tmpPath, text, 'utf-8');
        await rename(tmpPath, path);
      } catch (err) {
        await unlink(tmpPath).catch(() => {
          /* best-effort: the write/rename error is the one that matters */
        });
        throw err;
      }
    },

    async unlink(path: string): Promise<boolean> {
      try {
        await unlink(path);
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
  };
}
