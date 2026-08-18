import type { SqliteLike } from '../sqlite.js';
// LWW primitives (v0.2 T1, §3.3).
//
// The comparison key is the triple `(updated_at_ms, lww_counter, device_id)`,
// compared strictly lexicographically. Two thirds of it were already on every
// row since M1; v0.2 only starts USING the third — and a NULL device_id reads
// as `''` so the order stays total. `''` losing every tie is deliberate: a row
// stamped before this library ever registered has no claim on a tie against a
// device that did.
//
// Pure leaf module: raw sqlite reads, no engine, no apply — both of those
// import from here.

/** The comparison form of an LWW key. Distinct from the wire `LwwKey`. */
export interface LwwTriple {
  ms: number;
  counter: number;
  /** NULL device ids are normalized to `''` on the way in. */
  deviceId: string;
}

/** `<0` when a is older, `0` when equal, `>0` when a is newer. */
export function cmpLww(a: LwwTriple, b: LwwTriple): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return 0;
}

/** The later of two keys; `b` only wins a strict comparison, so ties keep `a`. */
export function maxLww(a: LwwTriple, b: LwwTriple): LwwTriple {
  return cmpLww(b, a) > 0 ? b : a;
}

export function makeLwwTriple(ms: number, counter: number, deviceId: string | null): LwwTriple {
  return { ms, counter, deviceId: deviceId ?? '' };
}

interface LwwRow {
  updated_at: number;
  lww_counter: number;
  device_id: string | null;
}

function toTriple(row: LwwRow | undefined): LwwTriple | null {
  return row ? makeLwwTriple(row.updated_at, row.lww_counter, row.device_id) : null;
}

export function readSongLww(sqlite: SqliteLike, id: string): LwwTriple | null {
  return toTriple(
    sqlite.prepare('SELECT updated_at, lww_counter, device_id FROM songs WHERE id = ?').get(id) as
      | LwwRow
      | undefined,
  );
}

export function readPlaylistLww(sqlite: SqliteLike, id: string): LwwTriple | null {
  return toTriple(
    sqlite
      .prepare('SELECT updated_at, lww_counter, device_id FROM playlists WHERE id = ?')
      .get(id) as LwwRow | undefined,
  );
}

export function readMembershipLww(
  sqlite: SqliteLike,
  playlistId: string,
  songId: string,
): LwwTriple | null {
  return toTriple(
    sqlite
      .prepare(
        `SELECT updated_at, lww_counter, device_id FROM playlist_songs
         WHERE playlist_id = ? AND song_id = ?`,
      )
      .get(playlistId, songId) as LwwRow | undefined,
  );
}

/**
 * True when `cid` names a change this device pushed and the server is now
 * handing back.
 *
 * Only LWW puts and tombstones use this. The metadata ops (`set_lyrics`,
 * `reorder`, `set_rank`) deliberately REPLAY their own echo — that replay is
 * what makes them converge, because they carry no key to compare (§3.1).
 */
export function isSelfReplay(sqlite: SqliteLike, cid: string): boolean {
  return (
    sqlite
      .prepare('SELECT 1 FROM sync_changes WHERE client_change_id = ? AND synced_at IS NOT NULL')
      .get(cid) !== undefined
  );
}
