// createDatabase (T3): crash recovery → open → zero-write version dispatch →
// WAL → forward migrations / schema assert → device_uuid. The five-way
// user_version dispatch follows owl, with one hardening pass: every refusal
// path (`>LATEST`, Go legacy, unknown v0) closes the handle and never writes —
// `journal_mode=WAL` is a FILE-level property, so setting it before the
// verdict would flip the still-in-daily-use Go library from DELETE to WAL, or
// pollute a future-version db before refusing it.

import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { GoMigrationRequiredError, IncompatibleDbError } from '../errors.js';
import type { Logger } from '../logger/index.js';
import { ensureDeviceUuid } from '../portable/db-identity.js';
import type { PortableDb } from '../portable/db.js';
import {
  LATEST_KNOWN_VERSION,
  applyForwardMigrations,
  isGoLegacyDb,
  isSchemaEmpty,
} from '../portable/migrate.js';
import { clearAudioMigrationPending } from '../portable/pending.js';
import { assertCurrentSchema } from '../portable/schema-signature.js';
import * as schema from '../portable/schema.js';
import type { SqliteLike } from '../portable/sqlite.js';
import { recoverFromMigrationResidue } from './recovery.js';

export type LarkDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseOptions {
  /** Path to the SQLite database file, or ':memory:'. */
  dbPath: string;
  /** Optional logger for non-fatal repairs (invalid device_uuid regeneration). */
  logger?: Logger;
}

export interface DatabaseHandles {
  db: LarkDatabase;
  sqlite: BetterSqlite3.Database;
  /**
   * The same two handles, as portable code takes them (N1c).
   *
   * THE construction point on this host: everything that needs the query
   * builder and the raw connection in one transaction receives this object
   * rather than deriving one from the other, so "the same connection" is
   * established here once instead of being assumed everywhere.
   */
  portable: PortableDb;
}

/**
 * Open a lark database, dispatching on PRAGMA user_version:
 *
 *   v > LATEST_KNOWN_VERSION                  -> IncompatibleDbError (refuse)
 *   v == 0 && schema empty (brand new)        -> forward-migrate 0 -> LATEST
 *   v == 0 && Go legacy fingerprint           -> GoMigrationRequiredError
 *   v == 0 && anything else non-empty         -> IncompatibleDbError (refuse)
 *   0 < v < LATEST                            -> forward migrations
 *   v == LATEST                               -> assertCurrentSchema, open
 *
 * A database this call created from nothing also leaves with the audio
 * migration flag cleared — see the forward-migration branch.
 *
 * The `>LATEST` check must precede the v==0 handling, or a future db would be
 * misread as brand new. Any throw past the open closes the handle (no fd /
 * WAL-lock leak). File-backed paths run the M1-10 crash-recovery step FIRST —
 * before the open, which would materialize an empty file at a missing path.
 */
export function createDatabase(options: DatabaseOptions): DatabaseHandles {
  const { dbPath, logger } = options;
  const isMemory = dbPath === ':memory:';

  if (!isMemory) {
    recoverFromMigrationResidue(dbPath);
  }

  // `satisfies` and not a cast: it proves better-sqlite3 still covers the
  // portable surface WITHOUT narrowing `sqlite`, which the desktop-only calls
  // below (backup, WAL pragmas, writer locks) still need in full. If the shim
  // contract ever grows a method better-sqlite3 lacks, this line is where it
  // is noticed — not on a phone.
  const sqlite = new BetterSqlite3(dbPath) satisfies SqliteLike;
  try {
    // Connection-level pragmas only — neither persists to the file.
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('foreign_keys = ON');

    const v = sqlite.pragma('user_version', { simple: true }) as number;

    if (v > LATEST_KNOWN_VERSION) {
      throw new IncompatibleDbError(dbPath, v, LATEST_KNOWN_VERSION);
    }
    const brandNew = v === 0 && isSchemaEmpty(sqlite);
    if (v === 0 && !brandNew) {
      if (isGoLegacyDb(sqlite)) {
        throw new GoMigrationRequiredError(dbPath);
      }
      throw new IncompatibleDbError(dbPath, 0, LATEST_KNOWN_VERSION);
    }

    // Verdict reached: empty, forward-migratable, or current. Only now may a
    // file-level write happen.
    sqlite.pragma('journal_mode = WAL');

    if (v < LATEST_KNOWN_VERSION) {
      applyForwardMigrations(sqlite, v, LATEST_KNOWN_VERSION);
      // 0003 marks every library reaching v3 as owing the audio migration,
      // because it cannot know whether `songs/` holds mp3 files. This one was
      // created from nothing by the call above, so it cannot: clear the flag
      // and let a fresh daemon — or a fresh `--direct` write — work at once.
      //
      // A crash between 0003's commit and this line leaves the flag set on an
      // empty library, which costs one scan of an empty directory. The reverse
      // ordering would risk a v3 library whose mp3 files nobody ever converts,
      // so the window is deliberately on this side (master plan §3.2-2).
      if (brandNew) clearAudioMigrationPending(sqlite);
    } else {
      // v == LATEST: don't trust the number alone (T3 — one definition of the
      // current schema, raised to v2 by the sync activation migration).
      assertCurrentSchema(sqlite, dbPath);
    }

    ensureDeviceUuid(sqlite, logger);

    const db = drizzle(sqlite, { schema });
    // The one place the pair is formed on this host, and the one place a
    // desktop handle is checked against the portable shape (criterion 9).
    return { db, sqlite, portable: { drizzle: db, sqlite } satisfies PortableDb };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

/**
 * Re-exported, not redefined (N2b, decision j).
 *
 * The implementation moved to `portable/db-identity.ts` because the mobile
 * boot sequence needs the same guarantee `readLocalDeviceUuid` relies on, and
 * the old signature (`BetterSqlite3.Database`) made that impossible. Everything
 * that imported it from here — the desktop tests, the two daemon e2e suites —
 * keeps importing it from here.
 */
export { ensureDeviceUuid } from '../portable/db-identity.js';

export { schema };
