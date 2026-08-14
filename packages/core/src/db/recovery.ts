// Crash-recovery state machine over {main, .migrating, .old-swap} (M1-10).
// Runs at the top of createDatabase, BEFORE any connection is opened — opening
// a missing main path would create an empty file and corrupt the state table.
//
// State table (main / migrating / old-swap):
//   - · ·   nothing to do (fresh create proceeds)
//   ✓ · ·   normal open
//   ✓ ✓ ·   crash before swap: source untouched → delete .migrating
//   ✓ · ✓   crash between "migrating renamed in" and "old-swap deleted":
//           validate main READ-ONLY (user_version + schema signature +
//           integrity + FK). Pass → archive old-swap as a recovery backup
//           (never immediate delete). Fail → fail-closed, keep both files.
//   · · ✓   crash between the two swap renames: restore old-swap → main
//   · ✓ ✓   same, and drop the orphan .migrating
//   · ✓ ·   fail-closed: .migrating is the only possibly-complete data file
//           on site — never delete it and never create an empty main over it
//   ✓ ✓ ✓   unreachable by the protocol → fail-closed
//
// Everything runs under the migration lock: an in-flight migration in another
// process must never see its work files "recovered" from under it.
//
// Protocol boundary: this covers process crashes, NOT power loss — the swap
// renames are not followed by a directory fsync, so power cut may roll back
// to the legal pre-rename state (backup + idempotent retry are the net).

import { existsSync, renameSync, unlinkSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { MigrationResidueError } from '../errors.js';
import { acquireMigrateLock } from './migrate-lock.js';
import { LATEST_KNOWN_VERSION } from './migrate.js';
import { assertCurrentSchema } from './schema-signature.js';

export function migratingPath(dbPath: string): string {
  return `${dbPath}.migrating`;
}

export function oldSwapPath(dbPath: string): string {
  return `${dbPath}.old-swap`;
}

/** Filesystem-safe ISO timestamp to millisecond precision. */
export function fsIsoTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function removeDbFiles(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      unlinkSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/**
 * Full read-only validation of a swapped-in main db: correct user_version,
 * schema signature (definition fingerprints included), integrity_check and
 * foreign_key_check. Returns the failure reason, or null when valid.
 */
function validateMainReadOnly(dbPath: string): string | null {
  let sqlite: BetterSqlite3.Database;
  try {
    sqlite = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return `cannot open main db read-only: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    const v = sqlite.pragma('user_version', { simple: true }) as number;
    if (v !== LATEST_KNOWN_VERSION) {
      return `main db user_version=${v}, expected ${LATEST_KNOWN_VERSION}`;
    }
    assertCurrentSchema(sqlite, dbPath);
    const integrity = sqlite.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      return `integrity_check failed: ${JSON.stringify(integrity)}`;
    }
    const fkViolations = sqlite.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      return `${fkViolations.length} foreign_key_check violation(s)`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    sqlite.close();
  }
}

/**
 * Resolve migration crash residue around `dbPath` per the state table above.
 * No-op (without even touching the lock) when no residue exists. Throws
 * MigrationBusyError when a live migration holds the lock, and
 * MigrationResidueError for the fail-closed states.
 */
export function recoverFromMigrationResidue(dbPath: string): void {
  const migrating = migratingPath(dbPath);
  const oldSwap = oldSwapPath(dbPath);
  if (!existsSync(migrating) && !existsSync(oldSwap)) return;

  const lock = acquireMigrateLock(dbPath);
  try {
    // Re-read state under the lock — it may have moved while we acquired it.
    const hasMain = existsSync(dbPath);
    const hasMigrating = existsSync(migrating);
    const hasOldSwap = existsSync(oldSwap);

    if (!hasMigrating && !hasOldSwap) return; // resolved meanwhile

    if (hasMain && hasMigrating && hasOldSwap) {
      throw new MigrationResidueError(
        dbPath,
        `all three of the db, ${migrating} and ${oldSwap} exist — this state is unreachable by the migration protocol; refusing to guess. Inspect and remove the stale files manually.`,
      );
    }

    if (hasMain && hasOldSwap) {
      // Crash after the second rename but before old-swap deletion — OR a
      // half-restored disaster. Only a fully valid main may claim the site.
      const failure = validateMainReadOnly(dbPath);
      if (failure !== null) {
        throw new MigrationResidueError(
          dbPath,
          `both the db and ${oldSwap} exist, and the db failed validation (${failure}). Neither file was touched — determine which one is the real library before removing the other.`,
        );
      }
      const archivePath = `${oldSwap}.bak-${fsIsoTimestamp()}`;
      if (existsSync(archivePath)) {
        throw new MigrationResidueError(dbPath, `archive target ${archivePath} already exists`);
      }
      renameSync(oldSwap, archivePath);
      return;
    }

    if (hasMain && hasMigrating) {
      // Crash before the swap: the source was never touched.
      removeDbFiles(migrating);
      return;
    }

    if (!hasMain && hasOldSwap) {
      // Crash between the two swap renames: restore the original.
      renameSync(oldSwap, dbPath);
      if (hasMigrating) {
        removeDbFiles(migrating);
      }
      return;
    }

    // !hasMain && !hasOldSwap && hasMigrating — the .migrating file is the
    // only possibly-complete data file on site. Never delete it, never create
    // an empty main next to it.
    throw new MigrationResidueError(
      dbPath,
      `only ${migrating} exists (no main db, no ${oldSwap}). It may hold the only copy of the library — restore it manually (inspect it, then rename it to ${dbPath}) or recover from a backup.`,
    );
  } finally {
    lock.release();
  }
}
