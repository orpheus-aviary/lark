// Steps ⑥ and ⑦ of the frozen boot sequence (§2.2), and nothing else.
//
// ⑥ open the real library for writing
// ⑦ version dispatch / migrate / assert the signature
//
// **This does not hand back a usable library.** §2.2 continues with converge
// (⑧), `ensureDeviceUuid` (⑨), commit the identity intent (⑩) and the file-op
// drain (⑪), and the D16 gate in N2c is what composes all of them. Skipping ⑨
// in particular produces a library that reads perfectly and throws on the
// first write, which is why it is not quietly folded in here — a boot step
// that is somebody's responsibility is better than one that is nobody's.
//
// Deliberately NOT wired into the app yet, for the reason the subplan's §3
// gives: a persistent startup path without D16 in front of it is a build that
// will happily open a restored library as its own. `apps/mobile/index.ts` still
// renders a screen that touches no file.
//
// PRAGMA ORDER IS THE MEASURED ONE (N0b-3), matching `db/index.ts`:
// connection-level `busy_timeout` and `foreign_keys` first, `user_version`
// read next, and `journal_mode = WAL` only once the verdict is in — WAL is a
// FILE-level property, so setting it earlier would modify a database about to
// be refused. That last ordering is not re-derived here; `prepareLibrary`
// hands it to us as `onVerdict`.

import {
  type LibraryVerdict,
  type PortableDb,
  type SqliteLike,
  prepareLibrary,
} from '@lark/core/portable';
import { type SQLiteDatabase, openDatabaseSync } from 'expo-sqlite';
import { DATABASE_NAME, databaseDirectoryUri } from '../ports/paths';
import { portableDbOf } from './portable-db';

export interface OpenedLibrary {
  /** The native handle. Closing it is the caller's job. */
  handle: SQLiteDatabase;
  /** The pair core takes. */
  db: PortableDb;
  /** What the dispatch found (§2.4). */
  verdict: LibraryVerdict;
}

export interface OpenLibraryOptions {
  /** Overridden by acceptance builds that work on a fixture library. */
  databaseName?: string;
  directoryUri?: string;
}

/**
 * Open — or create — the library at `<Paths.document>/lark/songs.db`.
 *
 * Throws for every shape §2.4 refuses, having written nothing, with the handle
 * closed.
 */
export function openLibrary(options: OpenLibraryOptions = {}): OpenedLibrary {
  const name = options.databaseName ?? DATABASE_NAME;
  const directory = options.directoryUri ?? databaseDirectoryUri();
  // The parent directory is created by expo-sqlite's Android side on the way
  // in (`ensureDatabasePathExists`), so there is nothing to mkdir here.
  const handle = openDatabaseSync(name, {}, directory);

  try {
    const db = portableDbOf(handle);
    const sqlite: SqliteLike = db.sqlite;

    // Connection-level, neither persists to the file.
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('foreign_keys = ON');

    const verdict = prepareLibrary(sqlite, `${directory}/${name}`, {
      onVerdict: () => {
        sqlite.pragma('journal_mode = WAL');
      },
    });

    return { handle, db, verdict };
  } catch (err) {
    // No fd and no WAL lock left behind on any refusal path.
    handle.closeSync();
    throw err;
  }
}
