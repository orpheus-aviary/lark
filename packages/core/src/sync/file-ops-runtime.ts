// The half of the file-effect journal that touches the disk (v0.2 T1b, §3.6;
// split out in N1b).
//
// Everything here is a consequence already committed to the database: the row
// that describes it was written inside the transaction that decided it, and
// this side's whole job is to make the filesystem agree, idempotently, however
// many times it is asked. Which is why every step tolerates having already
// happened — a rerun after a crash must find nothing to do, not a half-state.
//
// It stays host-specific on purpose. The decisions in `file-ops.ts` are the
// same on any device; `rm -rf` and `rename` into `recovered-songs/` are not.

import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SYNC_FILE_OP_MAX_ATTEMPTS } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { ClaimRegistry } from '../download/claims.js';
import { FileOpBusyError, FileOpNotFoundError, SongBusyError } from '../errors.js';
import {
  CANONICAL_AUDIO_FILE,
  LEGACY_AUDIO_FILE,
  songAudioPath,
  songDirPath,
  songLyricsPath,
  writeLyricsFile,
} from '../library/lyrics.js';
import type { StructuredLogger } from '../logger/index.js';
import { recoveredSongsDir } from '../paths.js';
import { uuid } from '../portable/runtime/random.js';
import { recordDeadLetter } from './changes.js';
import {
  type DeleteRemoteArg,
  type DrainResult,
  type FileOpRow,
  inlineDigest,
  parseArg,
} from './file-ops.js';

export interface FileEffectRuntimeOptions {
  sqlite: BetterSqlite3.Database;
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

export class FileEffectRuntime {
  readonly #sqlite: BetterSqlite3.Database;
  readonly #claims: ClaimRegistry;
  readonly #owner: string;
  readonly #logger?: StructuredLogger;
  readonly #now: () => number;
  readonly #onQuarantine?: (songId: string) => void;
  #running: Promise<DrainResult> | null = null;

  constructor(options: FileEffectRuntimeOptions) {
    this.#sqlite = options.sqlite;
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
        const outcome = await executeFileOp(row);
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
interface FileOpOutcome {
  /** Files were moved into `recovered-songs/` rather than removed. */
  quarantined: boolean;
}

async function executeFileOp(row: FileOpRow): Promise<FileOpOutcome> {
  const arg = parseArg(row.arg);
  if (arg === null) throw new Error(`file op ${row.id} has an unreadable arg`);

  switch (row.kind) {
    case 'delete_song_files': {
      if (arg.policy !== 'remote') {
        await rm(songDirPath(row.song_id), { recursive: true, force: true });
        return { quarantined: false };
      }
      return deleteRemote(row.song_id, arg as unknown as DeleteRemoteArg);
    }
    case 'quarantine_song_files':
      return quarantineDir(row.song_id, String(arg.quarantine_target));
    case 'write_lyrics':
      await landLyrics(row.song_id, typeof arg.inline === 'string' ? arg.inline : '');
      return { quarantined: false };
    case 'delete_lyrics':
      await unlink(songLyricsPath(row.song_id)).catch(ignoreMissing);
      return { quarantined: false };
    default:
      throw new Error(`file op ${row.id} has kind '${row.kind}', which this build cannot execute`);
  }
}

function ignoreMissing(err: NodeJS.ErrnoException): void {
  if (err.code !== 'ENOENT') throw err;
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
async function deleteRemote(songId: string, arg: DeleteRemoteArg): Promise<FileOpOutcome> {
  const dir = songDirPath(songId);
  if (!existsSync(dir)) return { quarantined: false };

  const keepAudio = arg.audio_origin !== 'downloaded';
  const keepLyrics = arg.lyrics_disposition === 'quarantine';
  let quarantined = false;

  // The snapshot names the file, and an op with no name is a 0.2.x one whose
  // file is an mp3. The other name is still checked as a fallback because the
  // step after this one removes the whole directory: locating the asset is
  // worth two `existsSync` calls, and looking away from it is unrecoverable.
  const audio = locateAudio(dir, arg.audio_file ?? LEGACY_AUDIO_FILE);
  if (keepAudio && audio !== null) {
    await moveInto(join(dir, audio), arg.quarantine_target, audio);
    quarantined = true;
  } else {
    await unlink(songAudioPath(songId)).catch(ignoreMissing);
  }

  if (keepLyrics && existsSync(songLyricsPath(songId))) {
    await moveInto(songLyricsPath(songId), arg.quarantine_target, 'lyrics.lrc');
    quarantined = true;
  } else {
    await unlink(songLyricsPath(songId)).catch(ignoreMissing);
  }

  // Anything else in there (a stray temp file) is ours and unreferenced.
  await rm(dir, { recursive: true, force: true });
  return { quarantined };
}

/**
 * Which of the two audio names this song directory actually holds, preferring
 * the one the op snapshotted. Null when it holds neither.
 */
function locateAudio(dir: string, preferred: string): string | null {
  const candidates =
    preferred === CANONICAL_AUDIO_FILE
      ? [CANONICAL_AUDIO_FILE, LEGACY_AUDIO_FILE]
      : [LEGACY_AUDIO_FILE, CANONICAL_AUDIO_FILE];
  return candidates.find((name) => existsSync(join(dir, name))) ?? null;
}

async function moveInto(from: string, targetName: string, fileName: string): Promise<void> {
  const target = join(recoveredSongsDir(), targetName);
  await mkdir(target, { recursive: true });
  await rename(from, join(target, fileName));
}

/** Move the whole directory aside. A target that already exists means a rerun. */
async function quarantineDir(songId: string, targetName: string): Promise<FileOpOutcome> {
  const dir = songDirPath(songId);
  const target = join(recoveredSongsDir(), targetName);
  if (!existsSync(dir)) return { quarantined: false };
  if (existsSync(target)) {
    // The move already happened and the crash was after it; drop whatever is
    // left behind rather than merging two directories.
    await rm(dir, { recursive: true, force: true });
    return { quarantined: false };
  }
  await mkdir(recoveredSongsDir(), { recursive: true });
  await rename(dir, target);
  return { quarantined: true };
}

/**
 * Write lyrics a peer sent. An empty document is the absence of lyrics, not a
 * zero-byte file — `readLyrics` reports "no lyrics" by the file not being
 * there, so writing one would be a lie that also fails the writer's own check.
 */
async function landLyrics(songId: string, lrc: string): Promise<void> {
  if (lrc.trim() === '') {
    await unlink(songLyricsPath(songId)).catch(ignoreMissing);
    return;
  }
  await writeLyricsFile(songId, lrc);
}

/**
 * Drop `recovered-songs/` entries that are empty, e.g. a quarantine that
 * created its target and then crashed before the move. Boot calls this; it
 * never touches a directory with files in it.
 */
export async function pruneEmptyQuarantines(): Promise<number> {
  const root = recoveredSongsDir();
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if ((await readdir(dir)).length === 0) {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

/** Song directories parked in `recovered-songs/`. Survives restarts by construction. */
export function countQuarantined(): number {
  const dir = recoveredSongsDir();
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}
