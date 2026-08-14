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
import { type MigrationClass, TERMINAL_STATUSES, getLedgerRow } from './ledger.js';

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
  const root = songsDir();
  const owned = pendingFileOpSongIds(sqlite);
  const entries = existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [];
  const report: ScanReport = { total: 0, inserted: 0, unblocked: 0, vanished: 0 };

  const readSong = sqlite.prepare(
    'SELECT file_origin, source_provider, source_key FROM songs WHERE id = ?',
  );
  const insert = sqlite.prepare(
    `INSERT INTO audio_migration
       (object_key, song_id, class, file_origin, source_key_present, status, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  sqlite
    .transaction(() => {
      const seen = new Set<string>();

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const objectKey = entry.name;
        if (!existsSync(join(root, objectKey, LEGACY_AUDIO_FILE))) continue;
        seen.add(objectKey);

        const song = readSong.get(objectKey) as SongFacts | undefined;
        const rebuildable = song !== undefined && isRebuildable(song);
        const klass: MigrationClass = song === undefined ? 'orphan' : rebuildable ? 'R' : 'A';
        const status = owned.has(objectKey) ? 'blocked_file_op' : 'pending';

        const existing = getLedgerRow(sqlite, objectKey);
        if (existing === undefined) {
          insert.run(
            objectKey,
            song === undefined ? null : objectKey,
            klass,
            song?.file_origin ?? null,
            rebuildable ? 1 : 0,
            status,
            nowMs,
          );
          report.inserted++;
          continue;
        }

        if (TERMINAL_STATUSES.includes(existing.status)) continue;
        // Mid-flight and `blocked` rows carry state the converter is going to
        // resume from, including the class it decided under. Re-deciding it
        // here would let a `backing_up(done)` row wake up as something else.
        if (existing.status !== 'pending' && existing.status !== 'blocked_file_op') continue;
        if (existing.status === 'blocked_file_op' && owned.has(objectKey)) continue;

        if (existing.status === 'blocked_file_op') report.unblocked++;
        // A `pending` row is re-decided on purpose: between boots the user may
        // have fixed a source link, and the class is what says whether this
        // song's mp3 may be deleted. Fresher is safer in both directions.
        sqlite
          .prepare(
            `UPDATE audio_migration
                SET song_id = ?, class = ?, file_origin = ?, source_key_present = ?,
                    status = 'pending', at = ?
              WHERE object_key = ?`,
          )
          .run(
            song === undefined ? null : objectKey,
            klass,
            song?.file_origin ?? null,
            rebuildable ? 1 : 0,
            nowMs,
            objectKey,
          );
      }

      // An object that was waiting on a file op and is no longer on disk was
      // taken away by that op finishing — a sync delete, a quarantine. That is
      // not a migration outcome, and recording it as one would put a warning
      // in the report for a song the user themselves removed.
      for (const row of sqlite
        .prepare("SELECT object_key FROM audio_migration WHERE status = 'blocked_file_op'")
        .all() as { object_key: string }[]) {
        if (seen.has(row.object_key) || owned.has(row.object_key)) continue;
        sqlite.prepare('DELETE FROM audio_migration WHERE object_key = ?').run(row.object_key);
        report.vanished++;
      }

      report.total = (
        sqlite.prepare('SELECT count(*) AS n FROM audio_migration').get() as { n: number }
      ).n;
    })
    .immediate();

  return report;
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
