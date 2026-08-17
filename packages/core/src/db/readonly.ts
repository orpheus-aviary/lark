// The zero-write read path (M6-20).
//
// `lark songs list --direct` must be able to read a library it is not allowed
// to change: no daemon lock, no writer lock, and — the part that takes care —
// NO WRITES AT ALL. `createDatabase` cannot serve this: it runs crash
// recovery, sets `journal_mode=WAL`, applies forward migrations and seeds
// `device_uuid`, every one of which is a write, and several of which would
// silently alter a library the user only asked to look at.
//
// So this is a separate, deliberately narrow door:
//
//   * `readonly` + `fileMustExist`, so the open cannot MATERIALISE a database;
//   * `query_only`, so a stray statement fails instead of writing;
//   * the same five-way version dispatch as `createDatabase`, but every branch
//     that would have repaired something reports what it found instead.
//
// The one exemption is SQLite's own: opening a WAL database read-only creates
// `-wal` / `-shm` sidecars and does not remove them on close. That is the
// engine's doing, it touches no library content, and M4 already measured it.

import { statSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  DatabaseNotInitializedError,
  GoMigrationRequiredError,
  IncompatibleDbError,
  MigrationPendingError,
} from '../errors.js';
import { LATEST_KNOWN_VERSION, isGoLegacyDb, isSchemaEmpty } from '../portable/migrate.js';
import { assertCurrentSchema } from '../portable/schema-signature.js';
import * as schema from '../portable/schema.js';
import type { LarkDatabase } from './index.js';

export interface ReadonlyDatabaseOptions {
  dbPath: string;
}

/**
 * Same shape `createDatabase` returns, so a caller can hand either one to the
 * same query function — the read path differs in what it REFUSES, not in how
 * it is used.
 */
export interface ReadonlyDatabaseHandles {
  db: LarkDatabase;
  sqlite: BetterSqlite3.Database;
}

/**
 * Open a lark library read-only, or explain why it cannot be read.
 *
 *   file missing                              -> DatabaseNotInitializedError
 *   v > LATEST_KNOWN_VERSION                  -> IncompatibleDbError
 *   v == 0 && schema empty                    -> DatabaseNotInitializedError
 *   v == 0 && Go legacy fingerprint           -> GoMigrationRequiredError
 *   v == 0 && anything else non-empty         -> IncompatibleDbError
 *   0 < v < LATEST                            -> MigrationPendingError
 *   v == LATEST                               -> assertCurrentSchema, open
 *
 * The caller owns the handle and must close it.
 */
export function openDatabaseReadonly(options: ReadonlyDatabaseOptions): ReadonlyDatabaseHandles {
  const { dbPath } = options;

  // `existsSync` cannot serve here: it answers false for EACCES too, which
  // would report "no library yet" for a library the user simply cannot read
  // (fifth review ②). Only ENOENT means missing; everything else propagates.
  statMissingOnly(dbPath);

  const sqlite = openOrExplain(dbPath);
  try {
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('query_only = ON');

    const v = sqlite.pragma('user_version', { simple: true }) as number;

    if (v > LATEST_KNOWN_VERSION) {
      throw new IncompatibleDbError(dbPath, v, LATEST_KNOWN_VERSION);
    }
    if (v === 0) {
      if (isSchemaEmpty(sqlite)) throw new DatabaseNotInitializedError(dbPath);
      if (isGoLegacyDb(sqlite)) throw new GoMigrationRequiredError(dbPath);
      throw new IncompatibleDbError(dbPath, 0, LATEST_KNOWN_VERSION);
    }
    if (v < LATEST_KNOWN_VERSION) {
      // A write path would migrate it here. This one cannot, and must not
      // pretend the numbers agree.
      throw new MigrationPendingError(dbPath, v, LATEST_KNOWN_VERSION);
    }

    // v == LATEST: the number alone is not proof (T3 — single definition of v1).
    assertCurrentSchema(sqlite, dbPath);
    return { db: drizzle(sqlite, { schema }), sqlite };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

/** Throw `DatabaseNotInitializedError` for ENOENT; propagate anything else. */
function statMissingOnly(dbPath: string): void {
  try {
    statSync(dbPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DatabaseNotInitializedError(dbPath);
    }
    throw err;
  }
}

/**
 * Open the handle, re-checking existence if that fails.
 *
 * `fileMustExist` guarantees the open never creates anything, but it turns a
 * file that vanished since the stat into a bare `SQLITE_CANTOPEN`. That race
 * is real, not theoretical: a read path takes no writer lock, and the crash
 * recovery renames this exact file during a swap (sixth review ⑧). A second
 * stat separates the two: gone now means "not initialised", still there means
 * the open failed for its own reasons and the error belongs to the caller.
 */
function openOrExplain(dbPath: string): BetterSqlite3.Database {
  try {
    return new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    statMissingOnly(dbPath);
    throw err;
  }
}
