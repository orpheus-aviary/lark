// The file-effect journal and the runtime that drains it (v0.2 T1b, §3.6).
//
// A sync decision that implies a file change has a window a database cannot
// close on its own: the row is committed, the process dies, and the file is
// still there — or worse, already half gone. So every file consequence is
// WRITTEN DOWN in the same transaction as the decision, and executed after.
// Boot drains the journal before anything else looks at the song directories.
//
// Two rules shape the arg column:
//
//   The arg is a SNAPSHOT, taken while the deciding transaction still had the
//   truth in front of it. By the time the executor runs, the row it would have
//   consulted is deleted — so the executor never re-derives, never infers, and
//   never guesses. It does what the arg says.
//
//   Ops for one song run in strict id order; different songs overtake freely.
//   A song whose first op is failing must not hold up an unrelated song, and
//   an op that lands out of order for the SAME song would undo its neighbour.
//
// This file is the DECIDING half (N1b): what an op is, how one is written down
// inside the transaction that decided it, and how the journal reads back. It
// touches no filesystem — the executor lives in `file-ops-runtime.ts`, because
// removing a directory is the one part of this that a phone does differently.
// Everything that only needs to ENQUEUE an effect (song deletes, apply,
// unbind) anchors on `FileEffectLike` here and never names the runtime class.

import {
  SYNC_FILE_OP_INLINE_MAX,
  SYNC_FILE_OP_MAX_ATTEMPTS,
  type SyncFileOpSummary,
} from '@lark/shared';
import { CANONICAL_AUDIO_FILE } from '../library/lyrics.js';
import { sha256Hex } from '../portable/runtime/digest.js';
import { uuid } from '../portable/runtime/random.js';
import { utf8ByteLength } from '../portable/runtime/text.js';
import type { SqliteLike } from '../portable/sqlite.js';

export const FILE_OP_KINDS = [
  'delete_song_files',
  'quarantine_song_files',
  'write_lyrics',
  'delete_lyrics',
] as const;
export type FileOpKind = (typeof FILE_OP_KINDS)[number];

/** Audio this device recorded as re-downloadable, or not, or no longer knew. */
export type AudioOrigin = 'downloaded' | 'imported' | null;

/**
 * A local delete: this machine's own user asked for it, the files are already
 * confirmed gone from the library, and the whole directory goes.
 */
export interface DeleteLocalArg {
  op_uuid: string;
  policy: 'local';
}

/**
 * A delete that arrived from another device.
 *
 * `audio_origin` decides the audio: `downloaded` can be fetched again from
 * `source_key`, so it is deleted; `imported` only ever existed here, so it is
 * quarantined; `null` (a Go-migrated song with no source at all) is treated as
 * irreplaceable — the conservative reading is the only safe one.
 *
 * `lyrics_disposition` is decided in the ENQUEUE transaction, not here (R4-3):
 * lyrics this device has edited but not yet pushed exist in exactly one place,
 * and the executor cannot tell that from a file's size or age.
 */
export interface DeleteRemoteArg {
  op_uuid: string;
  policy: 'remote';
  audio_origin: AudioOrigin;
  lyrics_disposition: 'delete' | 'quarantine';
  /** Directory NAME under `recovered-songs/`, never an absolute path — a nest that moved must still resolve it. */
  quarantine_target: string;
  /**
   * The audio file name as it was when this op was decided (0.3.0).
   *
   * Absent means the op was written by 0.2.x, when that name was `song.mp3` —
   * and such an op is executed by the boot drain that runs BEFORE the audio
   * migration, so the mp3 is still exactly what is on disk. Getting this wrong
   * is not cosmetic: the executor quarantines irreplaceable audio by name and
   * then removes the directory, so a name that matches nothing deletes an
   * imported song instead of saving it.
   */
  audio_file?: string;
}

export interface QuarantineArg {
  op_uuid: string;
  quarantine_target: string;
}

export interface WriteLyricsArg {
  op_uuid: string;
  /**
   * The LRC itself. Always inline in v0.2: the emit guard (240KB for a whole
   * change) sits below the payload validator's 256KB cap on `lrc`, so no
   * conforming peer can send lyrics that do not fit in a journal row.
   */
  inline: string;
}

export interface DeleteLyricsArg {
  op_uuid: string;
}

export type FileOpArg =
  | DeleteLocalArg
  | DeleteRemoteArg
  | QuarantineArg
  | WriteLyricsArg
  | DeleteLyricsArg;

/** A journal row as stored. Exported for the executor half (N1b). */
export interface FileOpRow {
  id: number;
  kind: string;
  song_id: string;
  arg: string | null;
  created_at: number;
  attempts: number;
  last_error: string | null;
  next_retry_at: number | null;
}

// ─── Enqueue (runs inside the deciding transaction) ─────

function insertOp(
  sqlite: SqliteLike,
  kind: FileOpKind,
  songId: string,
  arg: FileOpArg,
  nowMs: number,
): number {
  const info = sqlite
    .prepare(
      `INSERT INTO sync_file_ops (kind, song_id, arg, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(kind, songId, JSON.stringify(arg), nowMs);
  return Number(info.lastInsertRowid);
}

/** `quarantine_target` for a song: stable per op, so a replay lands in the same place. */
function quarantineName(songId: string, opUuid: string): string {
  return `${songId}-${opUuid}`;
}

/** This device deleted the song. Everything under `songs/<id>/` goes. */
export function enqueueLocalDelete(
  sqlite: SqliteLike,
  songId: string,
  nowMs: number = Date.now(),
): number {
  return insertOp(sqlite, 'delete_song_files', songId, { op_uuid: uuid(), policy: 'local' }, nowMs);
}

/**
 * A peer deleted the song. Snapshot everything the executor will need, INCLUDING
 * whether the lyrics are still only here.
 */
export function enqueueRemoteDelete(
  sqlite: SqliteLike,
  songId: string,
  audioOrigin: AudioOrigin,
  nowMs: number = Date.now(),
): number {
  const opUuid = uuid();
  const arg: DeleteRemoteArg = {
    op_uuid: opUuid,
    policy: 'remote',
    audio_origin: audioOrigin,
    lyrics_disposition: lyricsAreOnlyHere(sqlite, songId) ? 'quarantine' : 'delete',
    quarantine_target: quarantineName(songId, opUuid),
    audio_file: CANONICAL_AUDIO_FILE,
  };
  return insertOp(sqlite, 'delete_song_files', songId, arg, nowMs);
}

/**
 * Are this song's lyrics unpublished work?
 *
 * True when a lyrics change for it is still in the outbox, or when one was
 * archived as an outbound dead letter (too large to ever push). Either way the
 * file on disk is the only copy in the world, and a remote delete must not be
 * what destroys it — the pull-first window makes this a real sequence, not a
 * theoretical one.
 */
function lyricsAreOnlyHere(sqlite: SqliteLike, songId: string): boolean {
  const pending = sqlite
    .prepare(
      `SELECT 1 FROM sync_changes
       WHERE entity_type='song' AND entity_id=? AND op IN ('set_lyrics','clear_lyrics')
         AND synced_at IS NULL
       LIMIT 1`,
    )
    .get(songId);
  if (pending !== undefined) return true;

  const deadLettered = sqlite
    .prepare(
      `SELECT 1 FROM sync_dead_letters
       WHERE direction='out' AND entity_type='song' AND entity_id=?
         AND op IN ('set_lyrics','clear_lyrics')
       LIMIT 1`,
    )
    .get(songId);
  return deadLettered !== undefined;
}

/** Move the whole song directory aside without deleting anything. */
export function enqueueQuarantine(
  sqlite: SqliteLike,
  songId: string,
  nowMs: number = Date.now(),
): number {
  const opUuid = uuid();
  return insertOp(
    sqlite,
    'quarantine_song_files',
    songId,
    { op_uuid: opUuid, quarantine_target: quarantineName(songId, opUuid) },
    nowMs,
  );
}

/** Land lyrics that arrived from a peer. Blank content means "no lyrics". */
export function enqueueWriteLyrics(
  sqlite: SqliteLike,
  songId: string,
  lrc: string,
  nowMs: number = Date.now(),
): number {
  if (lrc.length > SYNC_FILE_OP_INLINE_MAX) {
    throw new Error(
      `lyrics for ${songId} are ${lrc.length} chars, over the ${SYNC_FILE_OP_INLINE_MAX} inline limit`,
    );
  }
  return insertOp(sqlite, 'write_lyrics', songId, { op_uuid: uuid(), inline: lrc }, nowMs);
}

export function enqueueDeleteLyrics(
  sqlite: SqliteLike,
  songId: string,
  nowMs: number = Date.now(),
): number {
  return insertOp(sqlite, 'delete_lyrics', songId, { op_uuid: uuid() }, nowMs);
}

// ─── Reading the journal ───────────────────────────────

export interface FileOpCounts {
  /** Rows still eligible to run on their own. */
  pending: number;
  /** Rows that gave up and are waiting for the user (attempts >= the cap). */
  failed: number;
  lastError: string | null;
}

export function countFileOps(sqlite: SqliteLike): FileOpCounts {
  const row = sqlite
    .prepare(
      `SELECT
         sum(CASE WHEN attempts < ? THEN 1 ELSE 0 END) AS pending,
         sum(CASE WHEN attempts >= ? THEN 1 ELSE 0 END) AS failed
       FROM sync_file_ops`,
    )
    .get(SYNC_FILE_OP_MAX_ATTEMPTS, SYNC_FILE_OP_MAX_ATTEMPTS) as {
    pending: number | null;
    failed: number | null;
  };
  const last = sqlite
    .prepare(
      'SELECT last_error FROM sync_file_ops WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get() as { last_error: string } | undefined;
  return {
    pending: row.pending ?? 0,
    failed: row.failed ?? 0,
    lastError: last?.last_error ?? null,
  };
}

/**
 * The redacted list behind `GET /sync/file-ops`.
 *
 * Inline lyrics become a size and a digest: the list exists so a caller can
 * name an id for retry or discard, and shipping a song's whole lyric sheet
 * through a status endpoint is not part of that.
 */
export function listFileOps(sqlite: SqliteLike, state?: 'pending' | 'failed'): SyncFileOpSummary[] {
  const where =
    state === 'pending' ? 'WHERE attempts < ?' : state === 'failed' ? 'WHERE attempts >= ?' : '';
  const stmt = sqlite.prepare(
    `SELECT id, kind, song_id, arg, created_at, attempts, last_error, next_retry_at
     FROM sync_file_ops ${where} ORDER BY id`,
  );
  const rows = (
    state === undefined ? stmt.all() : stmt.all(SYNC_FILE_OP_MAX_ATTEMPTS)
  ) as FileOpRow[];

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    song_id: row.song_id,
    attempts: row.attempts,
    last_error: row.last_error,
    next_retry_at: row.next_retry_at,
    created_at: row.created_at,
    inline: inlineDigest(row.arg),
  }));
}

export function inlineDigest(argJson: string | null): { size: number; sha256: string } | null {
  const arg = parseArg(argJson);
  if (arg === null || !('inline' in arg) || typeof arg.inline !== 'string') return null;
  return {
    size: utf8ByteLength(arg.inline),
    sha256: sha256Hex(arg.inline),
  };
}

export function parseArg(argJson: string | null): Record<string, unknown> | null {
  if (argJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(argJson);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ─── The runtime, as its callers see it ────────────────

export interface DrainResult {
  executed: number;
  failed: number;
  /** Ops left alone this round: busy song, backing off, or permanently failed. */
  skipped: number;
}

/**
 * What a caller that just enqueued an effect needs from the executor: a way to
 * say "now, please".
 *
 * Everything else about the runtime — claims, backoff, the retry/discard
 * surface — belongs to whoever constructed it. Anchoring on this rather than
 * on the class is what lets `deleteSong`, `applyChanges` and `unbind` stay
 * host-free while the thing that actually moves files does not.
 */
export interface FileEffectLike {
  drain(): Promise<DrainResult>;
}

/** Song directories a pending op still refers to — boot recovery must not touch them. */
export function pendingFileOpSongIds(sqlite: SqliteLike): Set<string> {
  const rows = sqlite.prepare('SELECT DISTINCT song_id FROM sync_file_ops').all() as {
    song_id: string;
  }[];
  return new Set(rows.map((r) => r.song_id));
}
