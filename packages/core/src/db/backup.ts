// Online backup of a live SQLite database to a separate file (owl verbatim).
//
// Wraps better-sqlite3's Database.backup() which takes a consistent snapshot
// while the source remains open. Standalone because the pattern is reusable
// beyond the one-shot Go migration (future `lark export`, scheduled backups).

import type BetterSqlite3 from 'better-sqlite3';

/**
 * Copy the contents of `sqlite` into a new database file at `targetPath`.
 *
 * - `sqlite` must be an open connection; its own file and the target must be
 *   distinct paths.
 * - `targetPath` is overwritten if it exists.
 * - The source stays usable after this resolves.
 * - The product is a self-contained single file with no WAL sidecar.
 */
export async function backupDatabase(
  sqlite: BetterSqlite3.Database,
  targetPath: string,
): Promise<void> {
  await sqlite.backup(targetPath);
}
