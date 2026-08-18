// The desktop's `FileSystemPort` (N1a).
//
// Thin by design: every method is the `node:fs` call core already made, with
// ENOENT turned into a return value at the ONE place that is allowed to know
// what ENOENT is. Everything else propagates untouched — a permission error
// reaching a caller as a permission error is the whole point of not
// normalising errors here.

import { statSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { nodePaths } from './paths.js';
import type { FileContext, FileStat, FileSystemPort } from './portable/ports/fs.js';
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
     * The sibling has to be in the SAME directory — a rename across
     * filesystems is a copy, and a copy has the truncation window this method
     * exists to close.
     *
     * `.<basename>.<uuid>.tmp` and not a bare uuid, for two reasons that pull
     * the same way. The uuid half: two writers for one file would otherwise
     * share a temp path, and the loser would rename the winner's half-written
     * bytes into place. The basename half: the startup recovery deletes
     * leftover temp files by PREFIX (`.lyrics.` among them, `resolve.ts`), so
     * a name that does not start with the target's would leave a crash's
     * residue in the song directory forever.
     */
    async writeTextAtomic(path: string, text: string): Promise<void> {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      const tmpPath = join(dir, `.${basename(path)}.${uuid()}.tmp`);
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

/**
 * The desktop's `FileContext` — the filesystem and the paths it resolves,
 * together (N1c).
 *
 * Built once per process at the composition root (the daemon's context, the
 * CLI's direct backend) and passed down, for the same reason `PortableDb` is:
 * portable code must not be able to reach for a host, and a capability that
 * arrives as a parameter is one a phone can hand over differently.
 *
 * Desktop-only modules — the journal executor, the download landing protocol,
 * the audio migration — may call this directly. They are not going anywhere.
 */
export function nodeFileContext(): FileContext {
  return { fs: nodeFileSystem(), paths: nodePaths() };
}
