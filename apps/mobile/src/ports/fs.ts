// `FileSystemPort` over expo-file-system, plus decision a's native move (N2d).
//
// Four of the five calls map straight onto expo-file-system. The fifth,
// `writeTextAtomic`, is the reason `modules/lark-fs` exists at all: SDK 57
// cannot replace a file atomically on Android. `moveSync(overwrite: true)`
// DELETES the target first (`CopyMoveStrategy.kt`'s `prepareAsDestination`)
// and `rename()` refuses an existing target — so a reader in that window sees
// no file, and `readText` turns that into `null`. For lyrics, the one document
// in the library that cannot be re-downloaded, `null` does not mean "the old
// lyrics" — it means "there are no lyrics".
//
// TWO RULES FROM THE PORT, both easy to break by being helpful:
//
//   "Not there" is a RETURN VALUE. `statSync` → null, `unlink*` → false,
//   `readText` → null. Never an exception.
//
//   Everything else throws the HOST's error, unchanged. A permission failure
//   is not ours to translate, and swallowing it turns "your library is
//   unreadable" into "you have no songs".

import type { FileStat, FileSystemPort } from '@lark/core/portable';
import { uuid } from '@lark/core/portable';
import { type Directory, File } from 'expo-file-system';
import LarkFs from '../../modules/lark-fs';

const fileAt = (path: string): File => new File(path);

/**
 * `.<basename>.<uuid>.tmp`, a sibling of the target.
 *
 * The shape is the desktop's, and the port says why: a host whose recovery
 * sweeps residue by prefix has to keep producing names that sweep recognises.
 * Same directory is not a style choice either — a rename across filesystems is
 * not a rename.
 */
const tempName = (basename: string): string => `.${basename}.${uuid()}.tmp`;

export interface FileSystemDeps {
  /**
   * The atomic move. Defaults to `modules/lark-fs`.
   *
   * The only seam in this file, and it exists for one criterion: 10③ asks
   * that a FAILED write leave the old file untouched and no residue behind,
   * and the move is the only step that could do otherwise. There is no way to
   * make a real `Files.move` fail on demand inside one app-private directory,
   * so the acceptance build substitutes one that throws. Nothing else may pass
   * this.
   */
  moveAtomic?: (from: string, to: string) => Promise<void>;
}

export function createFileSystem(deps: FileSystemDeps = {}): FileSystemPort {
  const moveAtomic = deps.moveAtomic ?? ((from, to) => LarkFs.moveAtomic(from, to));

  return {
    statSync(path: string): FileStat | null {
      const file = fileAt(path);
      // `size` answers 0 for a missing file, so it cannot be the existence
      // test — a real empty file and a missing one would be the same answer.
      return file.exists ? { size: file.size } : null;
    },

    unlinkSync(path: string): boolean {
      const file = fileAt(path);
      if (!file.exists) return false;
      file.delete();
      return true;
    },

    async readText(path: string): Promise<string | null> {
      const file = fileAt(path);
      if (!file.exists) return null;
      return file.textSync();
    },

    async writeTextAtomic(path: string, text: string): Promise<void> {
      const target = fileAt(path);
      const directory = target.parentDirectory;
      // The port promises this; callers write lyrics for a song whose
      // directory may not exist yet.
      if (!directory.exists) directory.create({ intermediates: true });

      const temp = new File(directory, tempName(target.name));
      try {
        temp.create({ overwrite: true });
        temp.write(text);
        // The one operation Expo cannot do. It throws rather than degrading if
        // the platform will not promise atomicity (criterion 10④).
        await moveAtomic(temp.uri, target.uri);
      } catch (err) {
        // No residue, and — because the move either happened or did not — the
        // old file is still whatever it was.
        if (temp.exists) temp.delete();
        throw err;
      }
    },

    async unlink(path: string): Promise<boolean> {
      const file = fileAt(path);
      if (!file.exists) return false;
      file.delete();
      return true;
    },
  };
}

/** Residue from a write that died between `create` and the move. */
export function sweepWriteResidue(directory: Directory): number {
  if (!directory.exists) return 0;
  let swept = 0;
  for (const entry of directory.list()) {
    if (entry instanceof File && entry.name.startsWith('.') && entry.name.endsWith('.tmp')) {
      entry.delete();
      swept += 1;
    }
  }
  return swept;
}
