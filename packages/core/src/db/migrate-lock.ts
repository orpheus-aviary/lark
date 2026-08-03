// The migration mutex (M1-10, third-review final form): `${dbPath}.migrate.lock`
// is a dedicated SQLite database; holding the lock = keeping an open
// connection with `BEGIN EXCLUSIVE` — a kernel fcntl advisory lock. Process
// death (kill -9 included) releases it automatically, so the whole "stale
// lock" problem class — pid files, nonces, compare-and-delete races — does
// not exist here.
//
// The lock FILE itself is permanent and never unlinked: deleting it would
// reintroduce the create/delete race window, and its presence carries no
// meaning — only the fcntl lock state does.
//
// (`.exec` below is better-sqlite3's Database#exec — SQL, not child_process.)

import BetterSqlite3 from 'better-sqlite3';
import { MigrationBusyError } from '../errors.js';

export interface MigrateLock {
  /** Release the lock (rollback + close). Idempotent. */
  release(): void;
}

export function migrateLockPath(dbPath: string): string {
  return `${dbPath}.migrate.lock`;
}

/**
 * Acquire the migration lock for `dbPath` or throw
 * `MigrationBusyError('migrate_lock_busy')` immediately (no waiting) when
 * another process — a running migration, or a createDatabase recovery step —
 * holds it. All residue handling / migration / temp cleanup must happen while
 * this is held; release only after every file operation is done.
 */
export function acquireMigrateLock(dbPath: string): MigrateLock {
  const lockDb = new BetterSqlite3(migrateLockPath(dbPath));
  try {
    lockDb.pragma('busy_timeout = 0');
    // In rollback-journal mode BEGIN EXCLUSIVE takes the exclusive fcntl lock
    // right here (no write needed); a competitor gets SQLITE_BUSY at once.
    lockDb.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    lockDb.close();
    if ((err as { code?: string }).code === 'SQLITE_BUSY') {
      throw new MigrationBusyError(
        'migrate_lock_busy',
        `Another process holds the migration lock for ${dbPath} (a migration or recovery is in progress).`,
      );
    }
    throw err;
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        lockDb.exec('ROLLBACK');
      } catch {
        /* connection teardown below is what actually frees the fcntl lock */
      }
      lockDb.close();
    },
  };
}
