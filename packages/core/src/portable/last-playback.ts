// "Where was I?" — the one thing an install remembers about playing (N3f,
// decision i, §2.7).
//
// One key in `local_metadata`, beside `device_uuid`, `play_mode` and
// `now_playing_mode`, and for the same reason: a PER-INSTALL fact, never a
// fact about the library, so it never enters `sync_changes`. Two phones signed
// into the same account were listening to different things.
//
// WHAT IS PROMISED, EXACTLY. Not "the position you heard" — "the position JS
// last observed". With the screen off Android throttles JS timers to as much
// as 85 seconds apart while the playback clock keeps running, so a number
// written on the way into the background is the number at that moment and
// nothing later. The desktop-side write cadence is deliberately coarse for the
// same reason it is cheap: a feature whose whole purpose is convenience does
// not get to wake the CPU.
//
// WHAT IS STORED IS A SOURCE, NOT A LIST. `queue` says WHERE the queue came
// from so the next launch can rebuild it out of the library as it is now. A
// stored list of ids would be a snapshot arguing with a playlist that has
// since changed, and the playlist would be right.
//
// THE READ PATH NEVER WRITES, including when it rejects. Everything below
// answers "is this still true?" and the honest answer to "no" is to act as
// though nothing was remembered — not to correct a row that a newer build of
// this install may understand better than we do (`now-playing-mode.ts` set
// this rule; this module has more ways to be wrong, so it matters more).

import type { StructuredLogger } from './logger.js';
import type { SqliteLike } from './sqlite.js';

export const LAST_PLAYBACK_KEY = 'last_playback';

/** Where a queue was built from. `all` is the whole library, in sort order. */
export type QueueSource = { kind: 'all' } | { kind: 'playlist'; id: string };

export interface LastPlayback {
  songId: string;
  positionSeconds: number;
  /** Not the queue — the thing to rebuild it from. See the header. */
  queue: QueueSource;
}

export interface LastPlaybackChecks {
  /**
   * Does this song's audio exist on disk?
   *
   * Injected rather than looked up: `has_file` is a filesystem fact and this
   * module only has a database. The caller already has the port that knows.
   */
  hasFile(songId: string): boolean;
}

/**
 * What to restore, or `null` for "start with nothing".
 *
 * Every rejection below is a case where restoring would produce something
 * visibly wrong — a mini bar naming a song that is gone, a progress bar past
 * the end of its own track — and in each of them "remember nothing" is a
 * state the user already understands.
 */
export function readLastPlayback(
  sqlite: SqliteLike,
  checks: LastPlaybackChecks,
  logger?: StructuredLogger,
): LastPlayback | null {
  const row = sqlite
    .prepare('SELECT value FROM local_metadata WHERE key = ?')
    .get(LAST_PLAYBACK_KEY) as { value: string } | undefined;
  if (row === undefined) return null;

  const reject = (reason: string): null => {
    logger?.warn(
      { key: LAST_PLAYBACK_KEY, reason },
      `local_metadata.${LAST_PLAYBACK_KEY} will not be restored: ${reason}`,
    );
    return null;
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // Includes the empty string, which `JSON.parse` rejects rather than
    // treating as absence.
    return reject('it is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) return reject('it is not an object');

  const record = parsed as Record<string, unknown>;
  const songId = record.song_id;
  if (typeof songId !== 'string' || songId === '') return reject('song_id is not an id');

  const position = record.position_seconds;
  // `isFinite` covers NaN and both infinities; JSON cannot carry them, but a
  // hand-edited row or a future writer can.
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 0) {
    return reject('position_seconds is not a position');
  }

  const queue = readSource(record.queue);
  if (queue === null) return reject('queue is not a source this build knows');

  const song = sqlite.prepare('SELECT duration FROM songs WHERE id = ?').get(songId) as
    | { duration: number }
    | undefined;
  if (song === undefined) return reject('that song is not in this library any more');
  if (!checks.hasFile(songId)) return reject('that song has no audio file');

  // A library that never recorded a duration reports 0, and 0 is not an upper
  // bound — treating it as one would reject every position for every song
  // imported before durations were probed. Where there IS a duration, landing
  // exactly on it means the song finished, and "resume at the end" is a worse
  // answer than "start fresh".
  if (song.duration > 0 && position >= song.duration) {
    return reject('that position is at or past the end of the song');
  }

  if (queue.kind === 'playlist') {
    const playlist = sqlite.prepare('SELECT id FROM playlists WHERE id = ?').get(queue.id) as
      | { id: string }
      | undefined;
    const count = playlist === undefined ? 0 : countPlaylistSongs(sqlite, queue.id);
    if (count === 0) {
      // The SONG still restores. What the user asked to be remembered is where
      // they were, and a playlist that has been deleted or emptied since is a
      // reason to widen the queue, not to forget the song.
      logger?.warn(
        { key: LAST_PLAYBACK_KEY, playlist: queue.id },
        `local_metadata.${LAST_PLAYBACK_KEY} names a playlist that is gone or empty — restoring into the whole library`,
      );
      return { songId, positionSeconds: position, queue: { kind: 'all' } };
    }
  }

  return { songId, positionSeconds: position, queue };
}

function readSource(value: unknown): QueueSource | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'all') return { kind: 'all' };
  if (record.kind === 'playlist' && typeof record.id === 'string' && record.id !== '') {
    return { kind: 'playlist', id: record.id };
  }
  return null;
}

function countPlaylistSongs(sqlite: SqliteLike, playlistId: string): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS n FROM playlist_songs WHERE playlist_id = ?')
    .get(playlistId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Remember this position. Upsert: the row exists once something has played. */
export function writeLastPlayback(sqlite: SqliteLike, value: LastPlayback): void {
  const stored = JSON.stringify({
    song_id: value.songId,
    position_seconds: value.positionSeconds,
    queue: value.queue,
  });
  sqlite
    .prepare(
      'INSERT INTO local_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(LAST_PLAYBACK_KEY, stored);
}
