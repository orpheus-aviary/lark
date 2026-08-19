// The half of the file-effect journal that DECIDES what executing a row means
// (v0.2 T1b, §3.6; host-split in N1b, made portable in N2d by decision k).
//
// Everything here is a consequence already committed to the database: the row
// that describes it was written inside the transaction that decided it, and
// this side's whole job is to make the filesystem agree, idempotently, however
// many times it is asked. Which is why every step tolerates having already
// happened — a rerun after a crash must find nothing to do, not a half-state.
//
// WHY THIS IS NOT PER-HOST (decision k). The desktop ran all of it: the drain
// loop, the claims, the backoff, dead-lettering, and the four op kinds. Only
// the last inch — `rm -rf`, `rename` into `recovered-songs/` — is actually
// about a particular filesystem. Writing the rest a second time for Android
// would have produced two schedulers that agree for a while, and the way that
// drift shows up is "the same op backed off a different number of times on the
// phone": a symptom nobody traces back to a scheduler. So the host supplies
// verbs (`SongFilesPort`, `FileContext`) and this file supplies the decisions.
//
// The arg is a SNAPSHOT (see `file-ops.ts`). By the time a row executes, the
// library row it would have consulted is deleted — so nothing here re-derives,
// infers, or guesses. It does what the arg says.

import { SYNC_FILE_OP_MAX_ATTEMPTS } from '@lark/shared';
import { ClaimRegistry } from '../download/claims.js';
import { FileOpBusyError, FileOpNotFoundError, SongBusyError } from '../errors.js';
import { writeLyricsFile } from '../library/lyrics.js';
import type { StructuredLogger } from '../logger.js';
import type { FileContext } from '../ports/fs.js';
import { CANONICAL_AUDIO_FILE, LEGACY_AUDIO_FILE, LYRICS_FILE } from '../ports/paths.js';
import type { SongFilesPort } from '../ports/song-files.js';
import { uuid } from '../runtime/random.js';
import type { SqliteLike } from '../sqlite.js';
import { recordDeadLetter } from './changes.js';
import {
  type DeleteRemoteArg,
  type DrainResult,
  type FileEffectLike,
  type FileOpRow,
  inlineDigest,
  parseArg,
} from './file-ops.js';

export interface FileEffectRuntimeOptions {
  sqlite: SqliteLike;
  /** Reading and writing individual library files (lyrics, the audio unlink). */
  files: FileContext;
  /** The directory-level verbs `FileContext` deliberately does not carry. */
  songFiles: SongFilesPort;
  /**
   * The claim registry this process arbitrates song files with. The daemon
   * passes ITS registry so a drain cannot run while a download is replacing
   * the same song's audio; `--direct` and boot own the library alone and pass
   * a fresh one.
   */
  claims?: ClaimRegistry;
  /**
   * Claim owner. A caller that ALREADY holds a claim for the song it just
   * decided about passes its own owner, so the drain it triggers reuses that
   * claim instead of blocking on itself (a registry owner never blocks itself).
   */
  owner?: string;
  logger?: StructuredLogger;
  nowMs?: () => number;
  /**
   * Called after an op that MOVED files into `recovered-songs/` instead of
   * deleting them. The daemon turns it into an SSE event: nothing was lost,
   * but a directory nobody is told about is a directory nobody looks in.
   */
  onQuarantine?: (songId: string) => void;
}

/** Backoff per attempt, in ms. Past the last entry the op stops retrying itself. */
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];

export class FileEffectRuntime implements FileEffectLike {
  readonly #sqlite: SqliteLike;
  readonly #files: FileContext;
  readonly #songFiles: SongFilesPort;
  readonly #claims: ClaimRegistry;
  readonly #owner: string;
  readonly #logger?: StructuredLogger;
  readonly #now: () => number;
  readonly #onQuarantine?: (songId: string) => void;
  #running: Promise<DrainResult> | null = null;

  constructor(options: FileEffectRuntimeOptions) {
    this.#sqlite = options.sqlite;
    this.#files = options.files;
    this.#songFiles = options.songFiles;
    this.#claims = options.claims ?? new ClaimRegistry();
    this.#owner = options.owner ?? `file-ops:${uuid()}`;
    this.#logger = options.logger;
    this.#now = options.nowMs ?? Date.now;
    this.#onQuarantine = options.onQuarantine;
  }

  /** True while a drain is in flight — retry and discard refuse during one. */
  get busy(): boolean {
    return this.#running !== null;
  }

  /**
   * Execute everything that is eligible right now.
   *
   * Concurrent callers share one pass rather than racing: a write route, the
   * apply loop and the periodic sweep all trigger this, and two passes over
   * the same rows would fight over the same claims.
   */
  drain(): Promise<DrainResult> {
    if (this.#running !== null) return this.#running;
    const run = this.#drainOnce().finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  /**
   * Put failed rows back in play. Without an id: every permanently failed row.
   *
   * Resets the attempt count rather than nudging the backoff — the user is
   * saying "I fixed the thing that was wrong", and starting over is what that
   * means.
   */
  async retry(id?: number): Promise<DrainResult> {
    this.#assertIdle('retry');
    const now = this.#now();
    if (id === undefined) {
      this.#sqlite
        .prepare(
          'UPDATE sync_file_ops SET attempts = 0, next_retry_at = NULL, last_error = NULL WHERE attempts >= ?',
        )
        .run(SYNC_FILE_OP_MAX_ATTEMPTS);
    } else {
      const row = this.#readRow(id);
      if (row === null) throw new FileOpNotFoundError(id);
      this.#sqlite
        .prepare(
          'UPDATE sync_file_ops SET attempts = 0, next_retry_at = NULL, last_error = NULL WHERE id = ?',
        )
        .run(id);
    }
    this.#logger?.info({ id, at: now }, 'sync file ops requeued');
    return this.drain();
  }

  /**
   * Abandon one permanently failed op.
   *
   * Dangerous by nature — the file effect it describes will never happen — so
   * it is per-row, it only accepts a row that has already given up, and the
   * arg summary goes into the dead-letter archive before the row disappears.
   * A discard nobody can audit later is just a deletion.
   */
  discard(id: number): void {
    this.#assertIdle('discard');
    const row = this.#readRow(id);
    if (row === null) throw new FileOpNotFoundError(id);
    if (row.attempts < SYNC_FILE_OP_MAX_ATTEMPTS) {
      throw new FileOpBusyError(
        `file op ${id} has not failed permanently yet (${row.attempts}/${SYNC_FILE_OP_MAX_ATTEMPTS} attempts) — retry it or wait`,
      );
    }

    this.#sqlite.transaction(() => {
      recordDeadLetter(this.#sqlite, {
        direction: 'out',
        reason: 'file_op_discarded',
        entityType: 'song',
        entityId: row.song_id,
        op: row.kind,
        payload: JSON.stringify({
          kind: row.kind,
          song_id: row.song_id,
          attempts: row.attempts,
          last_error: row.last_error,
          created_at: row.created_at,
          inline: inlineDigest(row.arg),
        }),
        nowMs: this.#now(),
      });
      this.#sqlite.prepare('DELETE FROM sync_file_ops WHERE id = ?').run(id);
    })();
  }

  #assertIdle(action: string): void {
    if (this.#running !== null) {
      throw new FileOpBusyError(`cannot ${action} while file ops are executing — try again`);
    }
  }

  #readRow(id: number): FileOpRow | null {
    return (
      (this.#sqlite.prepare('SELECT * FROM sync_file_ops WHERE id = ?').get(id) as
        | FileOpRow
        | undefined) ?? null
    );
  }

  async #drainOnce(): Promise<DrainResult> {
    const result: DrainResult = { executed: 0, failed: 0, skipped: 0 };
    const rows = this.#sqlite
      .prepare('SELECT * FROM sync_file_ops ORDER BY id')
      .all() as FileOpRow[];
    if (rows.length === 0) return result;

    const now = this.#now();
    /** Songs whose queue is blocked this round: a failure, a backoff, or a busy claim. */
    const stalled = new Set<string>();

    for (const row of rows) {
      if (stalled.has(row.song_id)) {
        result.skipped += 1;
        continue;
      }
      if (row.attempts >= SYNC_FILE_OP_MAX_ATTEMPTS) {
        // Waiting for a human. Everything behind it for this song waits too —
        // the ops are ordered because they depend on each other.
        stalled.add(row.song_id);
        result.skipped += 1;
        continue;
      }
      if (row.next_retry_at !== null && row.next_retry_at > now) {
        stalled.add(row.song_id);
        result.skipped += 1;
        continue;
      }

      const claim = this.#tryClaim(row.song_id);
      if (claim === null) {
        stalled.add(row.song_id);
        result.skipped += 1;
        continue;
      }

      try {
        const outcome = await executeFileOp(this.#files, this.#songFiles, row);
        this.#sqlite.prepare('DELETE FROM sync_file_ops WHERE id = ?').run(row.id);
        result.executed += 1;
        if (outcome.quarantined) this.#onQuarantine?.(row.song_id);
      } catch (err) {
        this.#recordFailure(row, err);
        stalled.add(row.song_id);
        result.failed += 1;
      } finally {
        claim.release();
      }
    }

    return result;
  }

  #tryClaim(songId: string): { release: () => void } | null {
    try {
      const token = this.#claims.acquire(songId, 'exclusive', this.#owner);
      return { release: () => this.#claims.release(token) };
    } catch (err) {
      if (err instanceof SongBusyError) return null;
      throw err;
    }
  }

  #recordFailure(row: FileOpRow, err: unknown): void {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];
    const nextRetryAt = attempts >= SYNC_FILE_OP_MAX_ATTEMPTS ? null : this.#now() + backoff;
    this.#sqlite
      .prepare(
        'UPDATE sync_file_ops SET attempts = ?, last_error = ?, next_retry_at = ? WHERE id = ?',
      )
      .run(attempts, message.slice(0, 500), nextRetryAt, row.id);
    this.#logger?.warn(
      { op_id: row.id, kind: row.kind, song_id: row.song_id, attempts, err: message },
      attempts >= SYNC_FILE_OP_MAX_ATTEMPTS
        ? 'sync file op failed permanently — waiting for retry or discard'
        : 'sync file op failed, will retry',
    );
  }
}

// ─── Execution (idempotent by construction) ────────────

/** What the executor did that a caller might want to know about. */
export interface FileOpOutcome {
  /** Files were moved into `recovered-songs/` rather than removed. */
  quarantined: boolean;
}

/**
 * One row, executed. Exported for the acceptance builds that exercise the four
 * kinds directly; the runtime above is what production drives.
 */
export async function executeFileOp(
  files: FileContext,
  songFiles: SongFilesPort,
  row: FileOpRow,
): Promise<FileOpOutcome> {
  const arg = parseArg(row.arg);
  if (arg === null) throw new Error(`file op ${row.id} has an unreadable arg`);

  switch (row.kind) {
    case 'delete_song_files': {
      if (arg.policy !== 'remote') {
        await songFiles.removeSongDir(row.song_id);
        return { quarantined: false };
      }
      return deleteRemote(files, songFiles, row.song_id, arg as unknown as DeleteRemoteArg);
    }
    case 'quarantine_song_files':
      return quarantineSong(songFiles, row.song_id, String(arg.quarantine_target));
    case 'write_lyrics':
      await landLyrics(files, row.song_id, typeof arg.inline === 'string' ? arg.inline : '');
      return { quarantined: false };
    case 'delete_lyrics':
      await files.fs.unlink(files.paths.songLyrics(row.song_id));
      return { quarantined: false };
    default:
      throw new Error(`file op ${row.id} has kind '${row.kind}', which this build cannot execute`);
  }
}

/**
 * Apply a peer's delete to this device's files.
 *
 * Replaceable audio goes; irreplaceable audio and unpublished lyrics move to
 * `recovered-songs/`. The song directory itself is removed only once whatever
 * had to survive is out of it — and a rerun after a crash finds nothing left
 * to do rather than a half-state, because every step tolerates having already
 * happened.
 */
async function deleteRemote(
  files: FileContext,
  songFiles: SongFilesPort,
  songId: string,
  arg: DeleteRemoteArg,
): Promise<FileOpOutcome> {
  if (!(await songFiles.songDirExists(songId))) return { quarantined: false };

  const keepAudio = arg.audio_origin !== 'downloaded';
  const keepLyrics = arg.lyrics_disposition === 'quarantine';
  let quarantined = false;

  // The snapshot names the file, and an op with no name is a 0.2.x one whose
  // file is an mp3. The other name is still checked as a fallback because the
  // step after this one removes the whole directory: locating the asset is
  // worth two `statSync` calls, and looking away from it is unrecoverable.
  const audio = locateAudio(files, songId, arg.audio_file ?? LEGACY_AUDIO_FILE);
  if (keepAudio && audio !== null) {
    await songFiles.quarantineSongFile(songId, audio, arg.quarantine_target);
    quarantined = true;
  } else {
    await files.fs.unlink(files.paths.songAudio(songId));
  }

  if (keepLyrics && files.fs.statSync(files.paths.songLyrics(songId)) !== null) {
    await songFiles.quarantineSongFile(songId, LYRICS_FILE, arg.quarantine_target);
    quarantined = true;
  } else {
    await files.fs.unlink(files.paths.songLyrics(songId));
  }

  // Anything else in there (a stray temp file) is ours and unreferenced.
  await songFiles.removeSongDir(songId);
  return { quarantined };
}

/**
 * Which of the two audio names this song directory actually holds, preferring
 * the one the op snapshotted. Null when it holds neither.
 */
function locateAudio(files: FileContext, songId: string, preferred: string): string | null {
  const canonical = { name: CANONICAL_AUDIO_FILE, path: files.paths.songAudio(songId) };
  const legacy = { name: LEGACY_AUDIO_FILE, path: files.paths.songLegacyAudio(songId) };
  const candidates = preferred === CANONICAL_AUDIO_FILE ? [canonical, legacy] : [legacy, canonical];
  return candidates.find((c) => files.fs.statSync(c.path) !== null)?.name ?? null;
}

/** Move the whole directory aside. A target that already exists means a rerun. */
async function quarantineSong(
  songFiles: SongFilesPort,
  songId: string,
  target: string,
): Promise<FileOpOutcome> {
  if (!(await songFiles.songDirExists(songId))) return { quarantined: false };
  if (await songFiles.quarantineExists(target)) {
    // The move already happened and the crash was after it; drop whatever is
    // left behind rather than merging two directories.
    await songFiles.removeSongDir(songId);
    return { quarantined: false };
  }
  await songFiles.quarantineSongDir(songId, target);
  return { quarantined: true };
}

/**
 * Write lyrics a peer sent. An empty document is the absence of lyrics, not a
 * zero-byte file — `readLyrics` reports "no lyrics" by the file not being
 * there, so writing one would be a lie that also fails the writer's own check.
 */
async function landLyrics(files: FileContext, songId: string, lrc: string): Promise<void> {
  if (lrc.trim() === '') {
    await files.fs.unlink(files.paths.songLyrics(songId));
    return;
  }
  await writeLyricsFile(files, songId, lrc);
}
