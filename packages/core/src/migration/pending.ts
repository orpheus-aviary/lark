// "Does this library still owe the mp3 → m4a conversion?" (0.3.0 T2)
//
// One flag, in `local_metadata`, written by migration 0003 inside the same
// transaction as `PRAGMA user_version = 3` and cleared only by the two places
// entitled to: `createDatabase`, for a library it just created from nothing,
// and the migration runner, once a scan proves `songs/` holds no mp3.
//
// It is deliberately NOT a column on some state row. Every reader is a boot
// path that has a raw sqlite handle and no business knowing about the runner,
// and the daemon reads it exactly once — the request gate reads an in-memory
// state machine, not this (master plan §3.2-3).

import type BetterSqlite3 from 'better-sqlite3';

export const AUDIO_MIGRATION_PENDING_KEY = 'audio_migration_pending';

/**
 * True when the audio migration has not finished for this library.
 *
 * Absent counts as NOT pending: only 0003 sets it, so a library without the
 * key is one that never reached v3 — and such a library is refused long before
 * anybody asks this.
 */
export function isAudioMigrationPending(sqlite: BetterSqlite3.Database): boolean {
  const row = sqlite
    .prepare('SELECT value FROM local_metadata WHERE key = ?')
    .get(AUDIO_MIGRATION_PENDING_KEY) as { value: string } | undefined;
  return row?.value === '1';
}

/**
 * Mark the conversion as no longer owed.
 *
 * The row is kept (set to '0') rather than deleted: `local_metadata` is a
 * key/value log of what has happened to this library, and "we cleared this"
 * and "this was never set" are different facts.
 */
export function clearAudioMigrationPending(sqlite: BetterSqlite3.Database): void {
  sqlite
    .prepare('UPDATE local_metadata SET value = ? WHERE key = ?')
    .run('0', AUDIO_MIGRATION_PENDING_KEY);
}
