// Sparse rank arithmetic (R7). Ranks are REALs spaced RANK_STEP apart;
// inserts take the neighbor midpoint until the float gap is exhausted, then
// the whole playlist renormalizes to (i+1)*RANK_STEP in the same transaction.

import { and, eq } from 'drizzle-orm';
import type { LarkDatabase } from '../db/index.js';
import { nextLwwStamp } from '../db/lww.js';
import { playlist_songs } from '../db/schema.js';

export const RANK_STEP = 1024;

/**
 * Midpoint between two neighboring ranks, or null when the float gap is
 * exhausted (the midpoint collides with either side) — the caller must
 * renormalize and retry.
 */
export function midpointRank(lower: number, upper: number): number | null {
  const mid = (lower + upper) / 2;
  if (mid === lower || mid === upper) return null;
  return mid;
}

/**
 * Rewrite every rank in the playlist to (i+1)*RANK_STEP following the current
 * (rank, song_id) order. Rows whose rank actually changes get their LWW stamp
 * bumped — their synced field really changed (M1-5); untouched rows keep
 * their stamp. Assumes the caller's transaction.
 */
export function normalizeRanksInTx(db: LarkDatabase, playlistId: string, now = Date.now()): void {
  const rows = db
    .select()
    .from(playlist_songs)
    .where(eq(playlist_songs.playlist_id, playlistId))
    .orderBy(playlist_songs.rank, playlist_songs.song_id)
    .all();

  rows.forEach((row, i) => {
    const target = (i + 1) * RANK_STEP;
    if (row.rank === target) return;
    const stamp = nextLwwStamp(row, now);
    db.update(playlist_songs)
      .set({ rank: target, updated_at: stamp.updated_at, lww_counter: stamp.lww_counter })
      .where(
        and(eq(playlist_songs.playlist_id, playlistId), eq(playlist_songs.song_id, row.song_id)),
      )
      .run();
  });
}
