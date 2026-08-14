// What is there to convert? (0.3.0 T2, master plan §3.2-1 / §3.2-10)
//
// The scan walks `songs/` rather than the songs table, and that is a decision
// with a reason: a 0.2.x library can hold directories whose row is gone (a
// sync file op named the song, the row was deleted, the op has not run or
// could not) and directories a crash left behind that were never songs. Both
// hold mp3 files. Iterating the table would leave them on disk forever, and
// "no mp3 anywhere under songs/" is half of what says the migration finished.
//
// One row per object that HOLDS an mp3, so `total` is the work and not the
// library size. A directory with only `song.m4a` has nothing to do with this
// pass and gets no row.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { LEGACY_AUDIO_FILE } from '../library/lyrics.js';
import { songsDir } from '../paths.js';
import { pendingFileOpSongIds } from '../sync/file-ops.js';
import { type LedgerRow, type MigrationClass, getLedgerRow } from './ledger.js';

export interface ScanReport {
  /** Objects in the ledger after this scan. */
  total: number;
  /** Rows created by this scan. */
  inserted: number;
  /** `blocked_file_op` rows whose op is gone, now back in the queue. */
  unblocked: number;
  /** `blocked_file_op` rows whose object the resolved op took away. */
  vanished: number;
}

interface SongFacts {
  file_origin: string;
  source_provider: string | null;
  source_key: string | null;
}

/**
 * Providers a stored key can actually be re-downloaded from.
 *
 * The same condition the cache eviction uses (R26): a key for a provider this
 * build cannot fetch from is not a way back to the file, whatever it says.
 */
const REBUILDABLE_PROVIDERS: ReadonlySet<string> = new Set(['bilibili']);

/**
 * Reconcile the ledger with what is on disk. Safe to run again at any time —
 * the runner calls it after a file op is retried or discarded.
 *
 * What it will NOT touch: terminal rows (they are the report), and rows the
 * converter is mid-flight on. A `converting` row whose mp3 is gone is not this
 * function's to interpret — that is the reconciliation table's job, and it has
 * the m4a and the backup to look at as well.
 */
export function scanAudioMigration(
  sqlite: BetterSqlite3.Database,
  nowMs: number = Date.now(),
): ScanReport {
  const owned = pendingFileOpSongIds(sqlite);
  const objectKeys = mp3ObjectKeys();
  const report: ScanReport = { total: 0, inserted: 0, unblocked: 0, vanished: 0 };

  const readSong = sqlite.prepare(
    'SELECT file_origin, source_provider, source_key FROM songs WHERE id = ?',
  );
  const insert = sqlite.prepare(
    `INSERT INTO audio_migration
       (object_key, song_id, class, file_origin, source_key_present, status, at)
     VALUES (@object_key, @song_id, @class, @file_origin, @source_key_present, @status, @at)`,
  );

  const update = sqlite.prepare(
    `UPDATE audio_migration
        SET song_id = @song_id, class = @class, file_origin = @file_origin,
            source_key_present = @source_key_present, status = 'pending', at = @at
      WHERE object_key = @object_key`,
  );

  sqlite
    .transaction(() => {
      const seen = new Set<string>(objectKeys);

      for (const objectKey of objectKeys) {
        const decision = decide(readSong.get(objectKey) as SongFacts | undefined, objectKey);
        const existing = getLedgerRow(sqlite, objectKey);

        if (existing === undefined) {
          const status = owned.has(objectKey) ? 'blocked_file_op' : 'pending';
          insert.run({ ...decision, status, at: nowMs });
          report.inserted++;
          continue;
        }
        if (!isReDecidable(existing.status, objectKey, owned)) continue;

        if (existing.status === 'blocked_file_op') report.unblocked++;
        // A `pending` row is re-decided on purpose: between boots the user may
        // have fixed a source link, and the class is what says whether this
        // song's mp3 may be deleted. Fresher is safer in both directions.
        update.run({ ...decision, at: nowMs });
      }

      report.vanished = forgetVanished(sqlite, seen, owned);
      report.total = (
        sqlite.prepare('SELECT count(*) AS n FROM audio_migration').get() as { n: number }
      ).n;
    })
    .immediate();

  return report;
}

/**
 * Directory names under `songs/` that still hold a `song.mp3`.
 *
 * Also the completion test (§3.2-13): "no mp3 anywhere under the served tree"
 * is half of what says the migration is over, and asking the disk is the only
 * honest way to know it — the ledger can only say what it was told.
 */
export function mp3ObjectKeys(): string[] {
  const root = songsDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(root, name, LEGACY_AUDIO_FILE)));
}

/** Everything about an object that comes from the library, as bind values. */
interface Decision {
  object_key: string;
  song_id: string | null;
  class: MigrationClass;
  file_origin: string | null;
  source_key_present: number;
}

function decide(song: SongFacts | undefined, objectKey: string): Decision {
  const rebuildable = song !== undefined && isRebuildable(song);
  return {
    object_key: objectKey,
    // A directory with no row is not "a song we lost track of" — it is an
    // object, and the ledger says so by leaving this null.
    song_id: song === undefined ? null : objectKey,
    class: song === undefined ? 'orphan' : rebuildable ? 'R' : 'A',
    file_origin: song?.file_origin ?? null,
    source_key_present: rebuildable ? 1 : 0,
  };
}

/**
 * May this scan overwrite the row's decision?
 *
 * Only `pending`, and `blocked_file_op` once its op is gone. Terminal rows are
 * the report; mid-flight and `blocked` rows carry state the converter resumes
 * from, and re-deciding those would let a half-committed conversion wake up as
 * something else.
 */
function isReDecidable(
  status: LedgerRow['status'],
  objectKey: string,
  owned: ReadonlySet<string>,
): boolean {
  if (status === 'pending') return true;
  return status === 'blocked_file_op' && !owned.has(objectKey);
}

/**
 * Drop rows whose object a resolved file op took away — a sync delete, a
 * quarantine. That is not a migration outcome, and recording it as one would
 * warn the user about a delete they asked for, in a row that can never settle.
 */
function forgetVanished(
  sqlite: BetterSqlite3.Database,
  seen: ReadonlySet<string>,
  owned: ReadonlySet<string>,
): number {
  const rows = sqlite
    .prepare("SELECT object_key FROM audio_migration WHERE status = 'blocked_file_op'")
    .all() as { object_key: string }[];
  let vanished = 0;
  for (const row of rows) {
    if (seen.has(row.object_key) || owned.has(row.object_key)) continue;
    sqlite.prepare('DELETE FROM audio_migration WHERE object_key = ?').run(row.object_key);
    vanished++;
  }
  return vanished;
}

/** R's static condition: downloaded, from a provider we can fetch, with a key. */
function isRebuildable(song: SongFacts): boolean {
  return (
    song.file_origin === 'downloaded' &&
    song.source_provider !== null &&
    REBUILDABLE_PROVIDERS.has(song.source_provider) &&
    song.source_key !== null &&
    song.source_key !== ''
  );
}
