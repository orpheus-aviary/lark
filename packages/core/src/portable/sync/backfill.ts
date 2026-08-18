// The full backfill (v0.2 T1d, §3.7 / R4-1).
//
// A library that existed before it ever synced has no history: v0.1 wrote no
// change rows at all, an imported Go-era library arrived as raw SQL, and
// `unbind` deliberately throws the outbox away. In every one of those cases the first
// login has to manufacture a `create` for each surviving row, or the peers
// would only ever hear about what changes AFTER the login and a fresh device
// would see a nearly empty library.
//
// Three decisions shape this file:
//
//   It runs at LOGIN, not in a migration (R4-1). A migration cannot read the
//   filesystem, so it could never back-fill lyrics; and owl's own rule — a
//   migration must not consult sync_changes history — makes the "have I done
//   this already" question unanswerable there. Two generation counters carry
//   the debt instead: `done < target` means "this library owes the server a
//   full set of creates", and unbind bumps `target` to say it again.
//
//   Lyrics are read from disk BEFORE the transaction and emitted inside it,
//   with a re-check in between (R5-2). Between the read and the emit a lyrics
//   task can rewrite the file; emitting the stale snapshot would push the OLD
//   document over the new one with a higher local_seq, and the newer text
//   would lose everywhere.
//
//   Memberships emit the same PAIR ordinary adds do (R4-2): a create with no
//   rank, then a set_rank. A backfill that folded rank into the put would
//   reintroduce the second channel the whole rank design exists to avoid.

import type { SongSyncPayload } from '@lark/shared';
import { membershipEntityId } from '@lark/shared';
import { SyncChangeTooLargeError } from '../errors.js';
import type { FileContext } from '../ports/fs.js';
import { utf8ByteLength } from '../runtime/text.js';
import type { SqliteLike } from '../sqlite.js';
import { emitSyncChange, recordDeadLetter } from './changes.js';

const KEY_DONE = 'sync_backfill_done_generation';
const KEY_TARGET = 'sync_backfill_target_generation';

export interface BackfillGenerations {
  done: number;
  target: number;
}

function readInt(sqlite: SqliteLike, key: string, fallback: number): number {
  const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  const n = row === undefined ? Number.NaN : Number(row.value);
  return Number.isSafeInteger(n) ? n : fallback;
}

function writeInt(sqlite: SqliteLike, key: string, value: number): void {
  sqlite
    .prepare(
      `INSERT INTO local_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, String(value));
}

export function readBackfillGenerations(sqlite: SqliteLike): BackfillGenerations {
  return { done: readInt(sqlite, KEY_DONE, 0), target: readInt(sqlite, KEY_TARGET, 1) };
}

/** True when this library still owes the workspace a full set of creates. */
export function backfillOwed(sqlite: SqliteLike): boolean {
  const { done, target } = readBackfillGenerations(sqlite);
  return done < target;
}

/** `unbind` says "everything has to be republished if we ever bind again". */
export function bumpBackfillTarget(sqlite: SqliteLike): void {
  writeInt(sqlite, KEY_TARGET, readBackfillGenerations(sqlite).target + 1);
}

export interface BackfillResult {
  songs: number;
  playlists: number;
  memberships: number;
  lyrics: number;
  /** Songs whose lyrics a pending change already covers (R5-2). */
  lyricsSkipped: number;
  /** Songs whose lyrics are too large to ever push (D3). */
  lyricsOversize: number;
}

/** A song's lyrics as they were on disk when the backfill started. */
export type LyricsSnapshot = Map<string, string>;

/**
 * Read every song's lyrics file. Runs OUTSIDE the transaction — the filesystem
 * is async and a transaction cannot await — and its result is re-validated
 * inside.
 */
export async function preReadLyrics(
  sqlite: SqliteLike,
  files: FileContext,
): Promise<LyricsSnapshot> {
  const rows = sqlite.prepare('SELECT id FROM songs ORDER BY id').all() as { id: string }[];
  const snapshot: LyricsSnapshot = new Map();
  for (const { id } of rows) {
    const lrc = await files.fs.readText(files.paths.songLyrics(id));
    if (lrc !== null && lrc.trim() !== '') snapshot.set(id, lrc);
  }
  return snapshot;
}

/**
 * Emit a create for everything that has none, then the lyrics.
 *
 * Assumes the caller's transaction — the login installer runs this, the
 * rebase, and the binding write as ONE commit, so a failure anywhere leaves a
 * library that still owes its backfill rather than one that half published.
 */
export function runFullBackfillInTx(sqlite: SqliteLike, lyrics: LyricsSnapshot): BackfillResult {
  const result: BackfillResult = {
    songs: 0,
    playlists: 0,
    memberships: 0,
    lyrics: 0,
    lyricsSkipped: 0,
    lyricsOversize: 0,
  };

  const hasCreate = sqlite.prepare(
    "SELECT 1 FROM sync_changes WHERE entity_type = ? AND entity_id = ? AND op = 'create' LIMIT 1",
  );
  const alreadyPublished = (entityType: string, entityId: string): boolean =>
    hasCreate.get(entityType, entityId) !== undefined;

  // Songs first, then playlists, then memberships: a device replaying this
  // stream meets every parent before the children that reference it.
  const songs = sqlite
    .prepare(
      `SELECT id, name, artist, source_url, source_provider, source_key,
              lyrics_offset, duration, created_at, updated_at, lww_counter
       FROM songs ORDER BY created_at, id`,
    )
    .all() as (SongSyncPayload & { id: string; created_at: number; updated_at: number })[];
  for (const row of songs) {
    if (alreadyPublished('song', row.id)) continue;
    emitSyncChange(sqlite, {
      entityType: 'song',
      entityId: row.id,
      op: 'create',
      payload: {
        name: row.name,
        artist: row.artist,
        source_url: row.source_url,
        source_provider: row.source_provider,
        source_key: row.source_key,
        lyrics_offset: row.lyrics_offset,
        duration: row.duration,
        created_at_ms: row.created_at,
        updated_at_ms: row.updated_at,
        lww_counter: row.lww_counter,
      },
    });
    result.songs += 1;
  }

  const playlists = sqlite
    .prepare(
      'SELECT id, name, created_at, updated_at, lww_counter FROM playlists ORDER BY created_at, id',
    )
    .all() as {
    id: string;
    name: string;
    created_at: number;
    updated_at: number;
    lww_counter: number;
  }[];
  for (const row of playlists) {
    if (alreadyPublished('playlist', row.id)) continue;
    emitSyncChange(sqlite, {
      entityType: 'playlist',
      entityId: row.id,
      op: 'create',
      payload: {
        name: row.name,
        created_at_ms: row.created_at,
        updated_at_ms: row.updated_at,
        lww_counter: row.lww_counter,
      },
    });
    result.playlists += 1;
  }

  const memberships = sqlite
    .prepare(
      `SELECT playlist_id, song_id, rank, added_at, updated_at, lww_counter
       FROM playlist_songs ORDER BY playlist_id, rank, song_id`,
    )
    .all() as {
    playlist_id: string;
    song_id: string;
    rank: number;
    added_at: number;
    updated_at: number;
    lww_counter: number;
  }[];
  for (const row of memberships) {
    const entityId = membershipEntityId(row.playlist_id, row.song_id);
    if (alreadyPublished('playlist_song', entityId)) continue;
    emitSyncChange(sqlite, {
      entityType: 'playlist_song',
      entityId,
      op: 'create',
      payload: {
        playlist_id: row.playlist_id,
        song_id: row.song_id,
        added_at_ms: row.added_at,
        updated_at_ms: row.updated_at,
        lww_counter: row.lww_counter,
      },
    });
    emitSyncChange(sqlite, {
      entityType: 'playlist_song',
      entityId,
      op: 'set_rank',
      payload: { rank: row.rank },
    });
    result.memberships += 1;
  }

  backfillLyrics(sqlite, lyrics, result);
  markBackfillDone(sqlite);
  return result;
}

function backfillLyrics(sqlite: SqliteLike, lyrics: LyricsSnapshot, result: BackfillResult): void {
  const pendingLyricsOp = sqlite.prepare(
    `SELECT 1 FROM sync_changes
     WHERE entity_type='song' AND entity_id=? AND op IN ('set_lyrics','clear_lyrics')
       AND synced_at IS NULL
     LIMIT 1`,
  );
  const archivedLyricsOp = sqlite.prepare(
    `SELECT 1 FROM sync_dead_letters
     WHERE direction='out' AND entity_type='song' AND entity_id=?
       AND op IN ('set_lyrics','clear_lyrics')
     LIMIT 1`,
  );

  for (const [songId, lrc] of lyrics) {
    // R5-2: the snapshot was taken before this transaction opened. If a lyrics
    // change for this song is already waiting to be pushed — or was archived
    // as unpushable — that change speaks for the current file, and emitting
    // the snapshot would overwrite the newer document everywhere with a higher
    // local_seq. The check and the emit are in the same transaction, so
    // SQLite's write lock leaves no gap between them.
    if (pendingLyricsOp.get(songId) !== undefined || archivedLyricsOp.get(songId) !== undefined) {
      result.lyricsSkipped += 1;
      continue;
    }
    try {
      emitSyncChange(sqlite, {
        entityType: 'song',
        entityId: songId,
        op: 'set_lyrics',
        payload: { lrc },
      });
      result.lyrics += 1;
    } catch (err) {
      if (!(err instanceof SyncChangeTooLargeError)) throw err;
      recordDeadLetter(sqlite, {
        direction: 'out',
        reason: 'change_too_large',
        entityType: 'song',
        entityId: songId,
        op: 'set_lyrics',
        payload: JSON.stringify({ size: utf8ByteLength(lrc), limit: err.limit }),
      });
      result.lyricsOversize += 1;
    }
  }
}

/** Level `done` up to `target` — the backfill for this generation is published. */
export function markBackfillDone(sqlite: SqliteLike): void {
  writeInt(sqlite, KEY_DONE, readBackfillGenerations(sqlite).target);
}

/**
 * The whole job: read the lyrics off disk, then run the transaction.
 *
 * The login installer uses the two halves directly so the backfill, the
 * rebase and the binding share one transaction; this is for callers that only
 * want the backfill.
 */
export async function runFullBackfill(
  sqlite: SqliteLike,
  files: FileContext,
): Promise<BackfillResult> {
  const lyrics = await preReadLyrics(sqlite, files);
  return sqlite.transaction(() => runFullBackfillInTx(sqlite, lyrics)).immediate();
}
