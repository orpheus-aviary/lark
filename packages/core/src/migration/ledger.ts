// The ledger's vocabulary and its reads/writes (0.3.0 T2, master plan §3.2-8).
//
// One table, `audio_migration`, one row per OBJECT — a directory under
// `songs/` that holds an mp3. Not one row per song: the scanner walks the
// directory tree, and what it finds there includes directories whose song was
// deleted while a file op still named it, and directories a crash left behind
// that are not songs at all.
//
// Everything here is synchronous raw SQL on the shared handle, like the sync
// tables: the migration runs during boot, before anything else can write, and
// a drizzle model for a table that exists for one release would be a mapping
// layer nobody reads.

import type { AudioMigrationClass, AudioMigrationStatus } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import type { MigrationErrorClass } from './error-class.js';

/**
 * What the pass will do with this object.
 *
 * `R` can be rebuilt from its source, so its mp3 may be deleted once the
 * conversion holds the content — or, if the conversion cannot read it, once a
 * live probe says the source still answers. `A` is a user asset: an import, a
 * song whose source is gone, anything that fails R's conditions. Its mp3 is
 * never deleted, only moved into `migration-backup/`. `orphan` is a directory
 * with no library row at all.
 *
 * The words themselves live in `@lark/shared`, with the report that carries
 * them: the table's CHECK constraint, the wire and the GUI have to agree on
 * this set, and three copies of it would eventually not.
 */
export type MigrationClass = AudioMigrationClass;

/**
 * Where an object stands.
 *
 * `pending` not started · `converting` ffmpeg is running (or was when the
 * process died) · `discarding` R only, the source was probed and the mp3 is
 * being deleted · `backing_up` A only, the mp3 is moving into
 * `migration-backup/`. Terminal: `done` · `lost` (R, unreadable mp3, source
 * confirmed live) · `kept_unconverted` (A, unreadable mp3, kept as-is) ·
 * `asset_missing` (the mp3 vanished and no backup holds it — never reported as
 * done). Needing a person: `blocked` (a file action failed) and
 * `blocked_file_op` (a sync file op owns the directory).
 */
export type MigrationStatus = AudioMigrationStatus;

/** States that will never change again without a new event. */
export const TERMINAL_STATUSES: readonly MigrationStatus[] = [
  'done',
  'lost',
  'kept_unconverted',
  'asset_missing',
];

export interface LedgerRow {
  object_key: string;
  song_id: string | null;
  class: MigrationClass;
  file_origin: string | null;
  source_key_present: number;
  status: MigrationStatus;
  blocked_action: string | null;
  resume_state: string | null;
  error_class: MigrationErrorClass | null;
  last_error: string | null;
  /** Relative to the lark nest root — never absolute (a nest can be moved). */
  backup_path: string | null;
  reconcile_action: string | null;
  at: number;
}

export function getLedgerRow(
  sqlite: BetterSqlite3.Database,
  objectKey: string,
): LedgerRow | undefined {
  return sqlite.prepare('SELECT * FROM audio_migration WHERE object_key = ?').get(objectKey) as
    | LedgerRow
    | undefined;
}

export function listLedger(sqlite: BetterSqlite3.Database): LedgerRow[] {
  return sqlite.prepare('SELECT * FROM audio_migration ORDER BY object_key').all() as LedgerRow[];
}

/**
 * The mark a row carries once its backup was deleted on purpose (§4-m).
 *
 * It goes in `reconcile_action` — the column that already means "something
 * happened to this object's files outside the state machine" — and is appended
 * rather than assigned, so a row that was also reconciled keeps both facts.
 */
export const BACKUP_CLEARED_MARK = 'backup_cleared';

/**
 * Forget every backup this ledger points at.
 *
 * Called before the files go, so the ledger never claims an original is safe in
 * a backup that has been deleted.
 */
export function clearLedgerBackups(
  sqlite: BetterSqlite3.Database,
  nowMs: number = Date.now(),
): number {
  const result = sqlite
    .prepare(
      `UPDATE audio_migration
          SET backup_path = NULL,
              reconcile_action = CASE
                WHEN reconcile_action IS NULL THEN ?
                ELSE reconcile_action || '；' || ?
              END,
              at = ?
        WHERE backup_path IS NOT NULL`,
    )
    .run(BACKUP_CLEARED_MARK, BACKUP_CLEARED_MARK, nowMs);
  return result.changes;
}

/** How many objects sit in each status. Absent statuses count zero. */
export function countLedgerByStatus(
  sqlite: BetterSqlite3.Database,
): Partial<Record<MigrationStatus, number>> {
  const rows = sqlite
    .prepare('SELECT status, count(*) AS n FROM audio_migration GROUP BY status')
    .all() as { status: MigrationStatus; n: number }[];
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

/**
 * Objects a pass may act on.
 *
 * `blocked` is in the list: a blocked row is re-judged from the disk once per
 * pass (附表 A.4b), which is how a permission fixed between two boots resumes
 * on its own. `blocked_file_op` is not: a sync file op owns that directory, and
 * nothing here may touch it until the op is retried or discarded.
 */
export function listActionableLedgerRows(sqlite: BetterSqlite3.Database): LedgerRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM audio_migration
        WHERE status IN ('pending', 'converting', 'discarding', 'backing_up', 'blocked')
        ORDER BY object_key`,
    )
    .all() as LedgerRow[];
}

/**
 * Terminal rows whose mp3 came back (§3.2-9, last row of the table).
 *
 * They are re-stepped once per pass so the reconciliation can move the stray
 * file somewhere safe — otherwise "no mp3 under songs/" could never become
 * true again and the migration would never finish.
 */
export function listTerminalLedgerRows(sqlite: BetterSqlite3.Database): LedgerRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM audio_migration
        WHERE status IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})
        ORDER BY object_key`,
    )
    .all(...TERMINAL_STATUSES) as LedgerRow[];
}

export interface LedgerUpdate {
  status?: MigrationStatus;
  blocked_action?: string | null;
  resume_state?: string | null;
  error_class?: MigrationErrorClass | null;
  last_error?: string | null;
  backup_path?: string | null;
  reconcile_action?: string | null;
}

/**
 * Write a row's new state, stamping `at`.
 *
 * Only the named columns move: a status change that meant to clear an error
 * says so, and one that did not leaves the previous error visible in the
 * report — which is where a user looks to find out why something is `blocked`.
 */
export function updateLedgerRow(
  sqlite: BetterSqlite3.Database,
  objectKey: string,
  update: LedgerUpdate,
  nowMs: number = Date.now(),
): void {
  const entries = Object.entries(update).filter(([, value]) => value !== undefined);
  const sets = [...entries.map(([column]) => `${column} = ?`), 'at = ?'].join(', ');
  sqlite
    .prepare(`UPDATE audio_migration SET ${sets} WHERE object_key = ?`)
    .run(...entries.map(([, value]) => value), nowMs, objectKey);
}
