// Landing a file, and cleaning up after a crash that interrupted one (M3-7).
//
// The problem this solves: a song is a database row AND a file, written by
// different subsystems that cannot share a transaction. The Go version wrote
// the row first, so a crash before the file landed left a song that plays
// nothing — invisible until you clicked it.
//
// The order here is the reverse, plus a marker that makes the crash window
// readable afterwards:
//
//   1. transcode into a task-scoped temp file
//   2. write `.pending.<task>` — the manifest, atomically
//   3. rename any existing song.mp3 to `.replace.<task>.bak`
//   4. rename the temp file to song.mp3
//   5. ONE database transaction: the row change AND a recovery-log row
//   6. clean up: drop the bak, the manifest, the log row
//
// Step 5 is the commit point, and it is a real one because the log row shares
// its transaction with the row change: either both landed or neither did. So
// recovery never has to guess — "manifest present, log row present" means step
// 5 completed and the new file is the good one; "manifest present, no log row"
// means it did not and the old file must come back.
//
// `had_old` in the manifest closes the last window (fourth review ①). Without
// it, a crash BETWEEN steps 2 and 3 is indistinguishable from one between 4
// and 5 — in the first case song.mp3 is the intact OLD file and deleting it
// destroys working audio, in the second it is an uncommitted new file that
// must go.
//
// Scope: this protocol is proof against process death (kill -9), not against
// power loss. Same line M1 draws — no fsync discipline (fourth review ⑪).

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isUuidV4 } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { eq, like } from 'drizzle-orm';
import type { LarkDatabase } from '../db/index.js';
import { local_metadata, songs } from '../db/schema.js';
import { DownloadCommitError, InvalidIdError } from '../errors.js';
import { songDirPath } from '../library/lyrics.js';
import { songsDir, trashDir } from '../paths.js';

const AUDIO_FILE = 'song.mp3';
const LOG_KEY_PREFIX = 'download.commit.';

/** Every temp prefix the recovery routine deletes unconditionally. */
const TEMP_PREFIXES = ['.download.', '.song.', '.import.', '.pending.', '.lyrics.'] as const;

export interface StagePaths {
  dir: string;
  audio: string;
  /** Raw bytes as they arrive from the source. */
  download: string;
  /** ffmpeg's output, before it becomes song.mp3. */
  transcoded: string;
  manifest: string;
  manifestTmp: string;
  backup: string;
}

/**
 * The task-scoped file names inside a song directory. Two temp stages, not
 * one: the raw download and the transcode output must not share a path, or a
 * failed transcode would leave something that looks like a finished file.
 */
export function stagePaths(songId: string, taskId: string): StagePaths {
  // Both ids reach a path join, so both go through the UUID gate (R10).
  if (!isUuidV4(taskId)) throw new InvalidIdError(taskId);
  const dir = songDirPath(songId);
  return {
    dir,
    audio: join(dir, AUDIO_FILE),
    download: join(dir, `.download.${taskId}.tmp`),
    transcoded: join(dir, `.song.${taskId}.mp3.tmp`),
    manifest: join(dir, `.pending.${taskId}`),
    manifestTmp: join(dir, `.pending.${taskId}.tmp`),
    backup: join(dir, `.replace.${taskId}.bak`),
  };
}

interface PendingManifest {
  task_id: string;
  song_id: string;
  mode: 'new' | 'replace';
  /** Was there a song.mp3 when this landing started? Decides the rollback. */
  had_old: boolean;
}

export interface LandSongFileInput {
  taskId: string;
  songId: string;
  /** Finished mp3 at a task-scoped temp path; renamed into place by this call. */
  stagedPath: string;
  /** `new` also owns the song directory, so a failed commit removes it. */
  mode: 'new' | 'replace';
  /**
   * The row work, run INSIDE the commit transaction. Throwing rolls back the
   * whole landing — file included.
   */
  commit: () => void;
}

export interface LandSongFileResult {
  /**
   * Post-commit cleanup steps that failed. The task still succeeded: the
   * leftovers are inert and the next startup recovery collects them (fourth
   * review ④).
   */
  warnings: string[];
}

/**
 * Put `stagedPath` in place as this song's audio and commit the row change,
 * atomically enough that a crash at any point is recoverable.
 *
 * Throws `DownloadCommitError` only for failures BEFORE the commit point, and
 * only after undoing everything it did. Once the transaction commits the
 * landing has succeeded and nothing below can un-succeed it.
 */
export function landSongFile(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  input: LandSongFileInput,
): LandSongFileResult {
  const paths = stagePaths(input.songId, input.taskId);
  mkdirSync(paths.dir, { recursive: true });

  const hadOld = existsSync(paths.audio);
  writeManifest(paths, {
    task_id: input.taskId,
    song_id: input.songId,
    mode: input.mode,
    had_old: hadOld,
  });

  if (hadOld) renameSync(paths.audio, paths.backup);
  renameSync(input.stagedPath, paths.audio);

  try {
    sqlite
      .transaction(() => {
        input.commit();
        // Same transaction as the row change — that is what makes the marker
        // trustworthy. A separate write could land without it, or vice versa.
        db.insert(local_metadata)
          .values({ key: logKey(input.taskId), value: input.songId })
          .onConflictDoUpdate({ target: local_metadata.key, set: { value: input.songId } })
          .run();
      })
      .immediate();
  } catch (err) {
    rollback(paths, hadOld, input.mode);
    throw new DownloadCommitError(
      `could not commit the download of song ${input.songId}; the previous file was restored`,
      { cause: err },
    );
  }

  // ─── Past the point of no return ───
  const warnings: string[] = [];
  if (hadOld) tryStep(warnings, `remove backup ${paths.backup}`, () => unlinkSync(paths.backup));
  tryStep(warnings, `remove manifest ${paths.manifest}`, () => unlinkSync(paths.manifest));
  tryStep(warnings, 'remove recovery log row', () => {
    db.delete(local_metadata)
      .where(eq(local_metadata.key, logKey(input.taskId)))
      .run();
  });
  return { warnings };
}

/** Undo a landing that never committed. Best-effort per step, never throws. */
function rollback(paths: StagePaths, hadOld: boolean, mode: 'new' | 'replace'): void {
  quietly(() => unlinkSync(paths.audio));
  if (hadOld) quietly(() => renameSync(paths.backup, paths.audio));
  quietly(() => unlinkSync(paths.manifest));
  // A brand-new song owns nothing else in that directory, so the whole thing
  // goes — leaving it behind would look like an orphan to recovery.
  if (mode === 'new') quietly(() => rmSync(paths.dir, { recursive: true, force: true }));
}

function writeManifest(paths: StagePaths, manifest: PendingManifest): void {
  // Atomic: a torn manifest is unreadable, and an unreadable manifest is
  // exactly the state that cannot be recovered from.
  writeFileSync(paths.manifestTmp, JSON.stringify(manifest), 'utf-8');
  renameSync(paths.manifestTmp, paths.manifest);
}

const logKey = (taskId: string): string => `${LOG_KEY_PREFIX}${taskId}`;

function tryStep(warnings: string[], what: string, step: () => void): void {
  try {
    step();
  } catch (err) {
    warnings.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function quietly(step: () => void): void {
  try {
    step();
  } catch {
    /* compensation is best-effort; the original failure is what matters */
  }
}

// ─── Startup recovery ──────────────────────────────────

export interface RecoveryReport {
  /** Temp files deleted (interrupted downloads, transcodes, imports). */
  tempFilesRemoved: number;
  /** Landings that HAD committed — leftovers swept, new file kept. */
  committedSwept: number;
  /** Landings that had NOT committed — previous file restored. */
  rolledBack: number;
  /** Uncommitted landings where the rename had not happened yet. */
  oldFileKept: number;
  /** Song directories with audio but no database row, moved to trash. */
  orphansQuarantined: number;
  /** Log rows with no manifest — cleanup that did not finish. */
  danglingLogRowsRemoved: number;
  notes: string[];
}

/**
 * Reconcile the songs directory with the database. Runs at boot, BEFORE the
 * engine starts, so no task can be racing it.
 *
 * The decision table (seven forms, T6):
 *
 *   temp file                          → delete
 *   manifest + log row                 → committed: sweep bak/manifest/log
 *   manifest, no log, bak present      → rolled back: restore bak
 *   manifest, no log, no bak, had_old  → rename never happened: KEEP song.mp3
 *   manifest, no log, no bak, !had_old → uncommitted new file: delete it
 *   audio but no row, no manifest      → orphan: quarantine, never delete
 *   log row, no manifest               → cleanup was interrupted: drop the row
 */
export function recoverSongsStore(
  db: LarkDatabase,
  _sqlite: BetterSqlite3.Database,
): RecoveryReport {
  const report: RecoveryReport = {
    tempFilesRemoved: 0,
    committedSwept: 0,
    rolledBack: 0,
    oldFileKept: 0,
    orphansQuarantined: 0,
    danglingLogRowsRemoved: 0,
    notes: [],
  };

  const logRows = new Map(
    db
      .select()
      .from(local_metadata)
      .where(like(local_metadata.key, `${LOG_KEY_PREFIX}%`))
      .all()
      .map((row) => [row.key.slice(LOG_KEY_PREFIX.length), row.value]),
  );
  const seenManifestTasks = new Set<string>();

  const root = songsDir();
  // No songs directory yet is normal on a fresh install — but log rows can
  // still be there, so the sweep below runs either way.
  for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !isUuidV4(entry.name)) continue;
    const songId = entry.name;
    const dir = join(root, songId);
    const hasRow =
      db.select({ id: songs.id }).from(songs).where(eq(songs.id, songId)).get() !== undefined;

    let sawManifest = false;
    for (const file of readdirSync(dir)) {
      if (file.startsWith('.pending.') && !file.endsWith('.tmp')) {
        sawManifest = true;
        const taskId = file.slice('.pending.'.length);
        seenManifestTasks.add(taskId);
        applyManifest(report, dir, songId, taskId, logRows.has(taskId));
        continue;
      }
      if (TEMP_PREFIXES.some((prefix) => file.startsWith(prefix))) {
        quietly(() => unlinkSync(join(dir, file)));
        report.tempFilesRemoved++;
      }
    }

    // An orphan is quarantined, never deleted: the row may be recoverable and
    // the audio certainly is not (second review, third review ②).
    if (!hasRow && !sawManifest && existsSync(join(dir, AUDIO_FILE))) {
      quarantine(report, dir, songId);
    }
  }

  // Every log row goes, not just the ones with no manifest: recovery has just
  // consumed every manifest there was, so no log row can still be meaningful.
  // Leaving the swept ones behind (an easy miss — they were "handled") would
  // accumulate a row per download for the life of the library.
  for (const taskId of logRows.keys()) {
    db.delete(local_metadata)
      .where(eq(local_metadata.key, logKey(taskId)))
      .run();
    if (!seenManifestTasks.has(taskId)) report.danglingLogRowsRemoved++;
  }

  return report;
}

function applyManifest(
  report: RecoveryReport,
  dir: string,
  songId: string,
  taskId: string,
  committed: boolean,
): void {
  const manifestPath = join(dir, `.pending.${taskId}`);
  const audio = join(dir, AUDIO_FILE);
  const backup = join(dir, `.replace.${taskId}.bak`);
  const manifest = readManifest(manifestPath);

  if (committed) {
    // The transaction landed, so song.mp3 is the new file. Everything else is
    // leftover from an interrupted step 6.
    quietly(() => unlinkSync(backup));
    quietly(() => unlinkSync(manifestPath));
    report.committedSwept++;
    return;
  }

  if (existsSync(backup)) {
    // Step 4 happened: song.mp3 is the uncommitted new file, bak is the good one.
    quietly(() => unlinkSync(audio));
    quietly(() => renameSync(backup, audio));
    quietly(() => unlinkSync(manifestPath));
    report.rolledBack++;
    report.notes.push(`restored the previous file for song ${songId}`);
    return;
  }

  // No bak. `had_old` is the only thing that says which file song.mp3 is.
  if (manifest?.had_old === true) {
    // Step 3 had not run: song.mp3 is the untouched previous file. Keep it.
    quietly(() => unlinkSync(manifestPath));
    report.oldFileKept++;
    return;
  }

  // A new song whose row never committed — the file is unreferenced.
  quietly(() => unlinkSync(audio));
  quietly(() => unlinkSync(manifestPath));
  report.rolledBack++;
  if (manifest === null) {
    report.notes.push(`unreadable manifest for song ${songId}; treated as uncommitted`);
  }
}

function readManifest(path: string): PendingManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PendingManifest>;
    if (typeof parsed?.song_id !== 'string') return null;
    return {
      task_id: String(parsed.task_id ?? ''),
      song_id: parsed.song_id,
      mode: parsed.mode === 'new' ? 'new' : 'replace',
      had_old: parsed.had_old === true,
    };
  } catch {
    return null;
  }
}

function quarantine(report: RecoveryReport, dir: string, songId: string): void {
  const target = join(trashDir(), `recovery-${Date.now()}-${randomUUID().slice(0, 8)}`, songId);
  try {
    mkdirSync(join(target, '..'), { recursive: true });
    renameSync(dir, target);
    report.orphansQuarantined++;
    report.notes.push(`quarantined orphan song directory ${songId} to ${target}`);
  } catch (err) {
    report.notes.push(
      `could not quarantine orphan song directory ${songId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
