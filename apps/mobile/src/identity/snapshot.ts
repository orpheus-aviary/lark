// Steps ② and ③: read the library's identity and compatibility, writing
// NOTHING to it.
//
// `SQLiteOpenOptions` has no readonly flag, and opening a WAL database can
// recover and checkpoint it — a write, during the one moment D16 says nothing
// may write. So: copy the file, open the COPY, read, throw the copy away.
// Whatever the open does to the copy is the write the original was spared.
// Frozen in N0b-5a and measured there: 50MB library max 75ms, with 4MB of hot
// WAL max 150ms, against a 500ms budget.
//
// main and `-wal`, NOT `-shm`. SQLite's own documentation: the shared-memory
// file carries no content and is rebuilt from the WAL. Copying it would be
// copying another process's view of a file we are not allowed to disturb.
//
// The source is snapshotted (size + mtime) either side of the copy. If it
// moved, retry once and then fail closed — a source that moves twice is one
// something else is writing, and reading it would be reading half of each of
// two states.

import { type LibraryVerdict, classifyLibrary } from '@lark/core/portable';
import { type Directory, File } from 'expo-file-system';
import { openDatabaseSync } from 'expo-sqlite';
import { ExpoSqliteShim } from '../db/shim';
import { DATABASE_NAME, nestDirectory } from '../ports/paths';

/** The row the mobile client stores its D16 identity in. */
export const INSTALL_ID_KEY = 'install_id';

const COPY_NAME = 'identity-probe.db';
/** Copied. `-shm` deliberately absent. */
const PARTS = ['', '-wal'] as const;

export class FailClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailClosedError';
  }
}

interface FileStat {
  exists: boolean;
  size: number;
  mtime: number | null;
}

function stat(file: File): FileStat {
  if (!file.exists) return { exists: false, size: 0, mtime: null };
  return { exists: true, size: file.size, mtime: file.modificationTime };
}

const sameStat = (a: FileStat, b: FileStat): boolean =>
  a.exists === b.exists && a.size === b.size && a.mtime === b.mtime;

const sourceFile = (part: string): File => new File(nestDirectory(), `${DATABASE_NAME}${part}`);
const copyFile = (part: string): File => new File(nestDirectory(), `${COPY_NAME}${part}`);

const snapshot = (): FileStat[] => PARTS.map((part) => stat(sourceFile(part)));
const sameSnapshot = (a: FileStat[], b: FileStat[]): boolean =>
  a.every((entry, index) => sameStat(entry, b[index] as FileStat));

/** The library file itself — the discriminant §2.2.1 decides on. */
export function libraryExists(): boolean {
  return sourceFile('').exists;
}

function removeCopy(): void {
  // `-shm` too: it is not copied, but opening the copy creates one.
  for (const part of [...PARTS, '-shm']) {
    const file = copyFile(part);
    if (file.exists) file.delete();
  }
}

function copyParts(): number {
  const directory: Directory = nestDirectory();
  let bytes = 0;
  for (const part of PARTS) {
    const source = sourceFile(part);
    if (!source.exists) continue;
    source.copySync(new File(directory, `${COPY_NAME}${part}`));
    bytes += source.size;
  }
  return bytes;
}

export interface LibraryProbe {
  /** What §2.4 makes of it. Throws instead when the library is refused. */
  verdict: LibraryVerdict;
  /** `local_metadata.install_id`, or `null` when the library carries none. */
  installId: string | null;
  /** How many times the source moved under us before it held still. */
  retries: number;
  copiedBytes: number;
}

/**
 * Copy, open the copy, read, delete. Never touches the original.
 *
 * Throws `FailClosedError` when the source will not hold still, and whatever
 * §2.4 throws when the library is one this client refuses — in which case
 * SecureStore has still not been touched, which is step ③'s other half.
 *
 * @param tamper test seam: runs between the two snapshots, where a concurrent
 * writer would land. A guard that has never been seen to trip is a guard
 * nobody has tested.
 */
export function probeLibrary(options: { tamper?: () => void } = {}): LibraryProbe {
  if (!libraryExists()) {
    throw new FailClosedError(`${DATABASE_NAME} does not exist — that is the fresh branch`);
  }

  for (let attempt = 0; attempt <= 1; attempt += 1) {
    const before = snapshot();
    try {
      const copiedBytes = copyParts();
      options.tamper?.();

      if (!sameSnapshot(before, snapshot())) {
        removeCopy();
        if (attempt === 0) continue;
        throw new FailClosedError('the library changed under the copy twice — refusing to read it');
      }

      const handle = openDatabaseSync(COPY_NAME, {}, nestDirectory().uri);
      try {
        const sqlite = new ExpoSqliteShim(handle);
        sqlite.pragma('busy_timeout = 5000');
        // Compatibility BEFORE identity: an incompatible library has no
        // `local_metadata` to ask, and §2.2 step ③ refuses it without having
        // touched SecureStore at all.
        const verdict = classifyLibrary(sqlite, DATABASE_NAME);
        const row = sqlite
          .prepare('SELECT value FROM local_metadata WHERE key = ?')
          .get(INSTALL_ID_KEY) as { value: string } | undefined;
        return {
          verdict,
          installId: row?.value ?? null,
          retries: attempt,
          copiedBytes,
        };
      } finally {
        handle.closeSync();
      }
    } finally {
      // The copy is somebody's library in a temp file. It goes whether or not
      // anything above worked.
      removeCopy();
    }
  }

  throw new FailClosedError('unreachable');
}
