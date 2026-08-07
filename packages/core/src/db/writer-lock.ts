// The cross-process WRITER lock (M6-18).
//
// Four processes can legitimately write this library — the daemon, a
// `lark --direct` write, `just migrate-go` and `just backup-nest` — and before
// M6 nothing but the daemon's pid file stood between them. That file is a
// STARTUP mutex, not a write mutex: it says "no second daemon", never "no
// second writer", so a direct CLI write during a backup copy, or a migration
// starting while a daemon booted, were both wide open.
//
// Mechanism is M1's migration lock verbatim, and for the same reasons:
// `${dbPath}.writer.lock` is a dedicated SQLite database, holding the lock =
// an open connection sitting in `BEGIN EXCLUSIVE`, which is a kernel fcntl
// advisory lock. Process death — kill -9 included — releases it, so stale-lock
// handling (pid files, nonces, compare-and-delete races) does not exist here.
// The lock FILE is permanent and never unlinked: its presence carries no
// meaning, only the fcntl state does.
//
// LOCK ORDER IS FROZEN: writer → migrate → the real database's EXCLUSIVE.
// Every holder takes them in that order or not at all — two of them in the
// other order is a deadlock nobody would reproduce on demand.
//
// (`.exec` below is better-sqlite3's Database#exec — SQL, not child_process.)

import BetterSqlite3 from 'better-sqlite3';
import { WriterLockBusyError } from '../errors.js';

export interface WriterLock {
  /** Release the lock (rollback + close). Idempotent. */
  release(): void;
}

export interface WriterLockOptions {
  /** The library being guarded — the lock file is derived from it. */
  dbPath: string;
  /**
   * How long to wait for a competitor to let go. 0 (the default) fails
   * immediately, which is what an interactive command wants; the daemon waits
   * a few seconds so a boot racing a short-lived CLI write does not have to be
   * retried by hand.
   */
  busyTimeoutMs?: number;
}

export function writerLockPath(dbPath: string): string {
  return `${dbPath}.writer.lock`;
}

/**
 * Acquire the writer lock for `dbPath`, or throw {@link WriterLockBusyError}.
 *
 * Callers must hold it across the whole write — including any file work that
 * accompanies it (a migration's rename dance, a backup's copy of `songs/`) —
 * and release it in a `finally`. Read-only paths do NOT take it: they open the
 * database read-only and write nothing, so a writer cannot corrupt what they
 * see beyond ordinary SQLite isolation.
 */
export function acquireWriterLock(options: WriterLockOptions): WriterLock {
  const { dbPath, busyTimeoutMs = 0 } = options;
  const lockDb = new BetterSqlite3(writerLockPath(dbPath));
  try {
    lockDb.pragma(`busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
    // Rollback-journal mode: BEGIN EXCLUSIVE takes the exclusive fcntl lock
    // right here, with no write involved. A competitor gets SQLITE_BUSY —
    // after `busy_timeout` of retries, if one was asked for.
    lockDb.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    lockDb.close();
    if ((err as { code?: string }).code === 'SQLITE_BUSY') {
      throw new WriterLockBusyError(dbPath, busyTimeoutMs);
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
