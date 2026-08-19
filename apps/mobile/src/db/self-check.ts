// The data layer, rehearsed on a library it makes itself (N2b).
//
// The desktop half of this batch tests the same policy through better-sqlite3
// (`portable/open-library.test.ts`, `portable/db-identity.test.ts`). This is
// the other half: the SAME portable functions driven through the expo-sqlite
// shim, on a phone. Neither alone is worth much — a policy that only passes on
// the host that has a test runner is a policy nobody has run.
//
// SCRATCH LIBRARY, ALWAYS. It opens `self-check.db` beside the real
// `songs.db`, never `songs.db` itself, and deletes it afterwards. The subplan
// forbids N2b from wiring a persistent startup path (there is no D16 in front
// of it yet), and it forbids pointing anything at a real library copy until
// N2c; a throwaway file honours both.
//
// It also puts the data layer in Metro's module graph, which is what makes
// `just mobile-bundle-smoke` mean something for it — an isolated file nothing
// imports is not in the graph and stays green no matter what is in it (N1i).

import {
  LATEST_KNOWN_VERSION,
  createPlaylist,
  ensureDeviceUuid,
  isAudioMigrationPending,
} from '@lark/core/portable';
import { deleteDatabaseSync } from 'expo-sqlite';
import { databaseDirectoryUri } from '../ports/paths';
import { type OpenedLibrary, openLibrary } from './open';

const SCRATCH = 'self-check.db';

export interface CheckRow {
  name: string;
  ok: boolean;
  detail: string;
}

function pendingValue(library: OpenedLibrary): string | undefined {
  const row = library.db.sqlite
    .prepare("SELECT value FROM local_metadata WHERE key='audio_migration_pending'")
    .get() as { value: string } | undefined;
  return row?.value;
}

function deviceUuid(library: OpenedLibrary): string | undefined {
  const row = library.db.sqlite
    .prepare("SELECT value FROM local_metadata WHERE key='device_uuid'")
    .get() as { value: string } | undefined;
  return row?.value;
}

/** Open the scratch library, run `body`, always close. */
function withScratch<T>(body: (library: OpenedLibrary) => T): T {
  const library = openLibrary({ databaseName: SCRATCH });
  try {
    return body(library);
  } finally {
    library.handle.closeSync();
  }
}

function discardScratch(): void {
  try {
    deleteDatabaseSync(SCRATCH, databaseDirectoryUri());
  } catch {
    // Nothing to delete — the normal case on a first run.
  }
}

/**
 * Run the checks. Synchronous and blocking, like everything else that touches
 * this shim: `SqliteLike` is a synchronous surface by contract.
 */
export function runDataLayerSelfCheck(): CheckRow[] {
  const rows: CheckRow[] = [];
  const check = (name: string, fn: () => string): void => {
    try {
      rows.push({ name, ok: true, detail: fn() });
    } catch (err) {
      rows.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  // A leftover from an interrupted run would hand the first case a library
  // that is not fresh, which is the one thing it assumes.
  discardScratch();

  try {
    check('fresh library reaches v3', () =>
      withScratch((library) => {
        if (library.verdict !== 'fresh') throw new Error(`verdict was '${library.verdict}'`);
        const v = library.db.sqlite.pragma('user_version', { simple: true });
        if (v !== LATEST_KNOWN_VERSION) throw new Error(`user_version is ${String(v)}`);
        return `verdict 'fresh', user_version ${LATEST_KNOWN_VERSION}`;
      }),
    );

    check("0003's flag is cleared, row kept", () =>
      withScratch((library) => {
        if (isAudioMigrationPending(library.db.sqlite)) throw new Error('still pending');
        const value = pendingValue(library);
        // "We cleared this" and "this was never set" are different facts.
        if (value !== '0') throw new Error(`row is ${JSON.stringify(value)}, expected '0'`);
        return "audio_migration_pending = '0'";
      }),
    );

    check('reopening reads as current, flag untouched', () =>
      withScratch((library) => {
        if (library.verdict !== 'current') throw new Error(`verdict was '${library.verdict}'`);
        const value = pendingValue(library);
        if (value !== '0') throw new Error(`flag moved to ${JSON.stringify(value)}`);
        return `verdict 'current', flag still '0'`;
      }),
    );

    check('step ⑨ mints device_uuid, and it survives a reopen', () => {
      const minted = withScratch((library) => {
        // MEASURED, and the first version of this case got it backwards: an
        // opened library has NO local identity yet. `openLibrary` stops after
        // §2.2 step ⑦ on purpose, so this assertion is what goes red the day
        // somebody folds step ⑨ into it "for convenience".
        const before = deviceUuid(library);
        if (before !== undefined) {
          throw new Error(`openLibrary minted one (${before}) — step ⑨ is not its job`);
        }
        return ensureDeviceUuid(library.db.sqlite);
      });

      return withScratch((library) => {
        const after = deviceUuid(library);
        if (after !== minted) throw new Error(`reopen read ${String(after)}, expected ${minted}`);
        const again = ensureDeviceUuid(library.db.sqlite);
        if (again !== minted) throw new Error(`asking again changed it: ${minted} -> ${again}`);
        return minted;
      });
    });

    check('a converged library refuses writes until step ⑨ runs', () =>
      withScratch((library) => {
        const sqlite = library.db.sqlite;
        // What D16's converge does (§2.2.2): the old local identity goes, and
        // step ⑨ mints a new one.
        sqlite.prepare("DELETE FROM local_metadata WHERE key='device_uuid'").run();

        let threw = '';
        try {
          createPlaylist(library.db, 'self-check');
        } catch (err) {
          threw = err instanceof Error ? err.message : String(err);
        }
        if (!threw.includes('device_uuid is missing')) {
          throw new Error(`expected the missing-identity refusal, got: ${threw || '(no throw)'}`);
        }

        const minted = ensureDeviceUuid(sqlite);
        createPlaylist(library.db, 'self-check');
        return `refused, then wrote with a new uuid ${minted}`;
      }),
    );

    check('a library from a newer build is refused', () => {
      withScratch((library) => {
        library.db.sqlite.pragma(`user_version = ${LATEST_KNOWN_VERSION + 1}`);
      });
      try {
        withScratch(() => undefined);
      } catch (err) {
        const name = err instanceof Error ? err.name : '(not an Error)';
        if (name !== 'IncompatibleDbError') throw new Error(`threw ${name}: ${String(err)}`);
        return 'IncompatibleDbError, handle closed';
      }
      throw new Error('it opened a database from the future');
    });
  } finally {
    discardScratch();
  }

  return rows;
}
