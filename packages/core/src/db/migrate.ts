// Schema migration runner (T3). Dispatch on PRAGMA user_version happens in
// db/index.ts; this module owns the forward chain over the explicit registry
// and the version predicates.
//
// NOTE: every `.exec(...)` in this file is better-sqlite3's synchronous
// Database#exec (SQL text), NOT child_process.exec — no shell is involved.

import type BetterSqlite3 from 'better-sqlite3';
import { DestructiveForwardMigrationError, ForwardMigrationError } from '../errors.js';
import { MIGRATIONS, type Migration } from './migrations/index.js';

export const LATEST_KNOWN_VERSION = 3;

/**
 * Inspect the first ~40 lines of a migration's SQL for the destructive
 * marker `-- requires_confirmation: true` (comment-anchored, header only).
 * Non-destructive migrations apply silently; destructive ones must be
 * confirmed by the caller.
 */
export function assertNotDestructive(migration: Migration): void {
  const header = migration.sql.split('\n', 40).join('\n');
  if (/^\s*--\s*requires_confirmation:\s*true\s*$/im.test(header)) {
    throw new DestructiveForwardMigrationError(migration.version);
  }
}

function resolveMigration(version: number, migrations: readonly Migration[]): Migration {
  const matches = migrations.filter((m) => m.version === version);
  if (matches.length !== 1) {
    throw new Error(
      `Migration registry broken for v${version}: ${matches.length} entries (expected exactly 1)`,
    );
  }
  return matches[0];
}

/**
 * Walk registered migrations strictly greater than fromV up to and including
 * toV. Each migration runs in its own transaction, and the
 * `PRAGMA user_version = N` stamp commits IN THAT SAME transaction — a disk
 * full / bad DDL mid-file can never leave a half schema at the old version
 * number. A mid-chain failure leaves the db at the last successful version.
 *
 * Fresh databases take this exact path from 0 (no initial-schema special
 * case): new installs and upgraded installs run identical code, so a bug in
 * 0002+ can't hide behind "works for new users".
 *
 * Caller contract: fromV must equal the current PRAGMA user_version.
 * `migrations` is injectable for runner tests only.
 */
export function applyForwardMigrations(
  sqlite: BetterSqlite3.Database,
  fromV: number,
  toV: number,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  for (let v = fromV + 1; v <= toV; v++) {
    const migration = resolveMigration(v, migrations);
    assertNotDestructive(migration);

    sqlite.exec('BEGIN');
    try {
      sqlite.exec(migration.sql);
      sqlite.pragma(`user_version = ${v}`);
      sqlite.exec('COMMIT');
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {
        /* rollback best-effort — the primary error is more informative */
      }
      throw new ForwardMigrationError(v, err);
    }
  }
}

/** A database with no user tables (sqlite_* shadow tables ignored). */
export function isSchemaEmpty(sqlite: BetterSqlite3.Database): boolean {
  const row = sqlite
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .get() as { n: number };
  return row.n === 0;
}

/**
 * The Go-era library fingerprint (M1-7): user_version=0 (the Go app never set
 * it), schema non-empty, and `playlists.is_system` present — the column the
 * TS schema dropped (all went virtual, R3). Caller has already established
 * user_version=0 and non-emptiness; this checks the distinguishing column.
 */
export function isGoLegacyDb(sqlite: BetterSqlite3.Database): boolean {
  const cols = sqlite.pragma('table_info(playlists)') as { name: string }[];
  return cols.some((c) => c.name === 'is_system');
}
