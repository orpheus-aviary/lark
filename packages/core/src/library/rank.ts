// Sparse rank arithmetic (R7). Ranks are REALs spaced RANK_STEP apart;
// inserts take the neighbor midpoint until the float gap is exhausted, then
// the whole playlist renormalizes to (i+1)*RANK_STEP in the same transaction.
//
// Since v0.2 rank has exactly ONE sync channel (§3.5, D7): the metadata ops
// `set_rank` and `reorder`, ordered by server_seq and replayed even on their
// own echo. Rank therefore does NOT touch the LWW triple any more — a value
// living in both channels would be decided by whichever arrived last on one
// device and by server order on another, which is a divergence by design.

import { REORDER_SYNC_MAX, membershipEntityId } from '@lark/shared';
import { and, eq } from 'drizzle-orm';
import { type LarkDatabase, sqliteOf } from '../db/index.js';
import { playlist_songs } from '../portable/schema.js';
import { emitSyncChange } from '../sync/changes.js';

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
 * (rank, song_id) order, and tell the workspace what the order now is.
 *
 * The local write is rank-only — no LWW stamp — and the sync side is a single
 * `reorder` carrying the resulting id list, not one change per row: the
 * playlist's ORDER is what changed, and N per-row changes would let a peer
 * apply half of a renormalization.
 *
 * Past REORDER_SYNC_MAX members the id list stops fitting a change, so the
 * emit degrades to per-row `set_rank` (§3.5). It never degrades to nothing:
 * a local-only renormalization would silently give this device an order no
 * peer will ever hear about.
 */
export function normalizeRanksInTx(db: LarkDatabase, playlistId: string): void {
  const sqlite = sqliteOf(db);
  const rows = db
    .select()
    .from(playlist_songs)
    .where(eq(playlist_songs.playlist_id, playlistId))
    .orderBy(playlist_songs.rank, playlist_songs.song_id)
    .all();

  const changed: { songId: string; rank: number }[] = [];
  rows.forEach((row, i) => {
    const target = (i + 1) * RANK_STEP;
    if (row.rank === target) return;
    db.update(playlist_songs)
      .set({ rank: target })
      .where(
        and(eq(playlist_songs.playlist_id, playlistId), eq(playlist_songs.song_id, row.song_id)),
      )
      .run();
    changed.push({ songId: row.song_id, rank: target });
  });
  if (changed.length === 0) return;

  if (rows.length <= REORDER_SYNC_MAX) {
    emitSyncChange(sqlite, {
      entityType: 'playlist',
      entityId: playlistId,
      op: 'reorder',
      payload: { song_ids: rows.map((r) => r.song_id) },
    });
    return;
  }
  for (const { songId, rank } of changed) {
    emitSyncChange(sqlite, {
      entityType: 'playlist_song',
      entityId: membershipEntityId(playlistId, songId),
      op: 'set_rank',
      payload: { rank },
    });
  }
}

/**
 * Write one membership's rank and publish it. Rank-only: the LWW triple stays
 * where it was, because `set_rank` is not compared against it.
 */
export function setRankInTx(
  db: LarkDatabase,
  playlistId: string,
  songId: string,
  rank: number,
): void {
  db.update(playlist_songs)
    .set({ rank })
    .where(and(eq(playlist_songs.playlist_id, playlistId), eq(playlist_songs.song_id, songId)))
    .run();
  emitSyncChange(sqliteOf(db), {
    entityType: 'playlist_song',
    entityId: membershipEntityId(playlistId, songId),
    op: 'set_rank',
    payload: { rank },
  });
}
