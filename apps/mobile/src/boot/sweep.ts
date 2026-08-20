// Step ⑪b of the frozen boot sequence: reconcile `songs/` with the library.
//
// The desktop's `recoverSongsStore` has seven forms because it carries a
// `.pending` manifest and has to tell "the old file, untouched" from "a new
// file that never committed" — two states that look identical on disk and are
// handled oppositely. This device carries no manifest (decision c), so the
// sweep has three rules and no ambiguity to resolve:
//
//   ① a song id the file-op journal still owns   → do not touch it, at all
//   ② `.…tmp` in a song directory                → residue; delete it
//   ③ a directory with no row                    → audio: park it in trash/
//                                                   nothing: delete it
//
// WHY ① IS FIRST AND NOT AN OPTIMISATION. Boot drains the journal (⑪) before
// this runs, so what is left in `sync_file_ops` is an op that FAILED or is
// backing off — and its row is a decision the database has already committed.
// A song whose remote delete is waiting to retry looks exactly like rule ③'s
// orphan: files, no row. Sweeping it first would move the directory out from
// under an op that is going to run again, and the retry would fail or, worse,
// dead-letter. `RecoveryOptions` on the desktop says the same thing.
//
// WHY ③ PARKS RATHER THAN DELETES. "Delete the thing we cannot explain" is not
// something this project does. The file is unreferenced, but a row may be
// recoverable and the audio in it certainly is not, so it goes somewhere a
// person can look. The destination is `trash/`, NOT `recovered-songs/` (§1.6③):
// that one is sync's quarantine and `/sync/status` counts what is in it, so an
// orphan filed there would show up as a sync problem in N5.
//
// The empty case is the ordinary one and is the reason ③ has two halves: a
// crash during the download leaves `songs/<id>/` holding one `.tmp` file and
// nothing else. Rule ② takes the tmp, and what is left is a directory that
// stands for nothing.

import {
  CANONICAL_AUDIO_FILE,
  type PortableDb,
  type StructuredLogger,
  uuid,
} from '@lark/core/portable';
import { isUuidV4 } from '@lark/shared';
import { Directory, File } from 'expo-file-system';
import { sweepWriteResidue } from '../ports/fs';
import { songsRoot, trashRecoveryDirectory } from '../ports/paths';

export interface SweepReport {
  /** Rule ②: `.download.<task>.tmp` and `.<name>.<uuid>.tmp` alike. */
  tempFilesRemoved: number;
  /** Rule ③, the empty half: no row, nothing to keep. */
  emptyDirsRemoved: number;
  /** Rule ③, the other half: no row but audio, moved to `trash/recovery-*`. */
  orphansQuarantined: number;
  /** Rule ①. */
  skippedForFileOps: number;
  notes: string[];
}

export interface SweepOptions {
  /**
   * Song directories the file-effect journal still owns.
   *
   * The caller passes `pendingFileOpSongIds(db.sqlite)` AFTER the drain. It is
   * an argument rather than a lookup so that a test can leave it out and watch
   * the directory get moved — which is what makes rule ① a claim and not a
   * comment.
   */
  skipSongIds?: ReadonlySet<string>;
  logger?: StructuredLogger;
  /**
   * The `recovery-<stamp>` suffix. Defaults to the clock plus randomness, so
   * everything one boot parks lands together and no later boot collides.
   */
  stamp?: string;
}

/**
 * Runs at boot, between the journal drain and the moment the library is handed
 * out — so nothing else in the process is looking at a song directory yet.
 */
export async function sweepSongsStore(
  db: PortableDb,
  options: SweepOptions = {},
): Promise<SweepReport> {
  const report: SweepReport = {
    tempFilesRemoved: 0,
    emptyDirsRemoved: 0,
    orphansQuarantined: 0,
    skippedForFileOps: 0,
    notes: [],
  };
  const root = songsRoot();
  // A fresh install has no songs directory, and nothing below would be true of
  // it either.
  if (!root.exists) return report;

  const skip = options.skipSongIds ?? new Set<string>();
  const rows = new Set(
    (db.sqlite.prepare('SELECT id FROM songs').all() as { id: string }[]).map((row) => row.id),
  );
  const trash = lazyTrash(options.stamp);

  for (const entry of root.list()) {
    // A file at the songs root, or a directory whose name is not an id, is not
    // something this sweep put there and not something it will judge.
    if (!(entry instanceof Directory) || !isUuidV4(entry.name)) continue;
    const songId = entry.name;

    if (skip.has(songId)) {
      report.skippedForFileOps += 1;
      continue;
    }

    report.tempFilesRemoved += sweepWriteResidue(entry);
    if (rows.has(songId)) continue;

    const parked = await retire(entry, trash);
    if (parked === null) {
      report.emptyDirsRemoved += 1;
    } else {
      report.orphansQuarantined += 1;
      report.notes.push(`parked orphan song directory ${songId} in ${parked}`);
    }
  }

  const touched =
    report.tempFilesRemoved +
    report.emptyDirsRemoved +
    report.orphansQuarantined +
    report.skippedForFileOps;
  if (touched > 0) options.logger?.info({ ...report, notes: undefined }, 'songs store swept');
  for (const note of report.notes) options.logger?.warn({ note }, 'sweep note');

  return report;
}

/**
 * Rule ③ for one unreferenced directory: park it, or remove it.
 *
 * Returns where it was parked, or `null` for the ordinary case — a download
 * that died before it committed anything, whose directory rule ② has just
 * emptied.
 */
async function retire(entry: Directory, trash: () => Directory): Promise<string | null> {
  // Audio is the whole question. Lyrics are re-fetchable and a `.tmp` is gone
  // by now, so a directory holding neither audio nor a row stands for nothing.
  if (!new File(entry, CANONICAL_AUDIO_FILE).exists) {
    entry.delete();
    return null;
  }
  const destination = trash();
  // Directory → Directory with a destination that does not exist: the source
  // BECOMES it (`song-files.ts` reads this out of Expo's `CopyMoveStrategy`),
  // which is why the parent is created and the song's own directory is not.
  await entry.move(new Directory(destination, entry.name));
  return destination.name;
}

/**
 * `trash/recovery-<stamp>/`, built on first use.
 *
 * A boot that finds nothing to park should not leave an empty directory behind
 * every time it runs.
 */
function lazyTrash(stamp: string | undefined): () => Directory {
  let directory: Directory | null = null;
  return () => {
    if (directory === null) {
      directory = trashRecoveryDirectory(stamp ?? defaultStamp());
      directory.create({ intermediates: true, idempotent: true });
    }
    return directory;
  };
}

/** The desktop's shape: when it happened, plus enough to never collide. */
function defaultStamp(): string {
  return `${Date.now()}-${uuid().slice(0, 8)}`;
}
