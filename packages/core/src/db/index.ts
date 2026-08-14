// createDatabase (T3): crash recovery → open → zero-write version dispatch →
// WAL → forward migrations / schema assert → device_uuid. The five-way
// user_version dispatch follows owl, with one hardening pass: every refusal
// path (`>LATEST`, Go legacy, unknown v0) closes the handle and never writes —
// `journal_mode=WAL` is a FILE-level property, so setting it before the
// verdict would flip the still-in-daily-use Go library from DELETE to WAL, or
// pollute a future-version db before refusing it.

import { randomUUID } from 'node:crypto';
import { isUuidV4 } from '@lark/shared';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { GoMigrationRequiredError, IncompatibleDbError } from '../errors.js';
import type { Logger } from '../logger/index.js';
import { clearAudioMigrationPending } from '../migration/pending.js';
import {
  LATEST_KNOWN_VERSION,
  applyForwardMigrations,
  isGoLegacyDb,
  isSchemaEmpty,
} from './migrate.js';
import { recoverFromMigrationResidue } from './recovery.js';
import { assertCurrentSchema } from './schema-signature.js';
import * as schema from './schema.js';

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

  const sqlite = new BetterSqlite3(dbPath);
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

    return { db: drizzle(sqlite, { schema }), sqlite };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

/**
 * Ensure `local_metadata.device_uuid` holds a valid lowercase UUID v4 — the
 * install's LOCAL identity (distinct from the skybridge registration id that
 * lives on entity rows as device_id, R18). Single code path, no SQL seeding:
 * every value ever stored here came from `randomUUID()`.
 *
 * An existing value that fails isUuidV4 counts as corruption: regenerate +
 * warn. (v0.1 — nothing downstream depends on it yet; once v0.2 registers it
 * into the sync domain this becomes fail-closed.)
 */
export function ensureDeviceUuid(sqlite: BetterSqlite3.Database, logger?: Logger): string {
  const read = () =>
    sqlite.prepare("SELECT value FROM local_metadata WHERE key='device_uuid'").get() as
      | { value: string }
      | undefined;

  const existing = read();
  if (existing && isUuidV4(existing.value)) return existing.value;

  const fresh = randomUUID();
  if (existing) {
    logger?.warn(
      { stored: existing.value },
      'local_metadata.device_uuid was invalid — regenerated',
    );
    sqlite.prepare("UPDATE local_metadata SET value=? WHERE key='device_uuid'").run(fresh);
  } else {
    sqlite
      .prepare(
        "INSERT INTO local_metadata (key, value) VALUES ('device_uuid', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run(fresh);
  }

  const persisted = read();
  if (!persisted || !isUuidV4(persisted.value)) {
    throw new Error('ensureDeviceUuid failed to persist a valid device_uuid');
  }
  return persisted.value;
}

/**
 * The raw handle drizzle is holding.
 *
 * v0.2 needs it inside the `…InTx` helpers: appending to the outbox is raw SQL
 * and MUST land in the same transaction as the business write it describes.
 * Taking it off the drizzle object rather than threading a second parameter
 * through fifteen signatures is what guarantees that — there is only one
 * connection here, so there is no way to pass the wrong one.
 */
export function sqliteOf(db: LarkDatabase): BetterSqlite3.Database {
  return db.$client;
}

export { schema };
