// Persistent tombstones (v0.2 T1, §3.2).
//
// A delete has to outlive the outbox row that carried it. Retention trims
// `sync_changes`, and once that row is gone the only thing separating "this
// song was deleted" from "this device has never heard of it" is a row here —
// without which a peer's older `create` would resurrect it on every pull.
//
// Two policies, one table:
//
//   song / playlist   — delete is FINAL. Nothing resurrects them; a later
//                       create for the same id is a stale echo, not a wish.
//   playlist_song     — delete is an LWW state like any other, and a newer
//                       `create` legitimately revives the membership (a user
//                       re-adding a song to a playlist is not an anomaly).
//
// Everything else about deletion — cascades, file effects — happens in the
// callers; this module only owns the record.

import type { SyncEntityType } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { type LwwTriple, cmpLww, makeLwwTriple } from './lww.js';

export interface Tombstone {
  entityType: SyncEntityType;
  entityId: string;
  key: LwwTriple;
  deletedAt: number;
}

interface TombstoneRow {
  updated_at: number;
  lww_counter: number;
  device_id: string | null;
  deleted_at: number;
}

export function readTombstone(
  sqlite: BetterSqlite3.Database,
  entityType: SyncEntityType,
  entityId: string,
): Tombstone | null {
  const row = sqlite
    .prepare(
      `SELECT updated_at, lww_counter, device_id, deleted_at FROM sync_tombstones
       WHERE entity_type = ? AND entity_id = ?`,
    )
    .get(entityType, entityId) as TombstoneRow | undefined;
  if (!row) return null;
  return {
    entityType,
    entityId,
    key: makeLwwTriple(row.updated_at, row.lww_counter, row.device_id),
    deletedAt: row.deleted_at,
  };
}

/**
 * Record a deletion, keeping the LATER key when one is already there.
 *
 * Keeping the max rather than overwriting is what makes the write order-
 * independent: two devices deleting the same song, in either arrival order,
 * converge on the same tombstone.
 */
export function writeTombstone(
  sqlite: BetterSqlite3.Database,
  entityType: SyncEntityType,
  entityId: string,
  key: LwwTriple,
  nowMs: number = Date.now(),
): void {
  const existing = readTombstone(sqlite, entityType, entityId);
  if (existing !== null && cmpLww(key, existing.key) <= 0) return;

  sqlite
    .prepare(
      `INSERT INTO sync_tombstones
         (entity_type, entity_id, updated_at, lww_counter, device_id, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         lww_counter = excluded.lww_counter,
         device_id = excluded.device_id,
         deleted_at = excluded.deleted_at`,
    )
    .run(
      entityType,
      entityId,
      key.ms,
      key.counter,
      key.deviceId === '' ? null : key.deviceId,
      nowMs,
    );
}

/** Drop a tombstone — only a membership revival may do this (§3.2). */
export function clearTombstone(
  sqlite: BetterSqlite3.Database,
  entityType: SyncEntityType,
  entityId: string,
): void {
  sqlite
    .prepare('DELETE FROM sync_tombstones WHERE entity_type = ? AND entity_id = ?')
    .run(entityType, entityId);
}

/**
 * The key an incoming change has to beat: the later of the live row's key and
 * the tombstone's, or `null` when the entity is unknown here.
 *
 * One comparison for both "is this newer than what I have" and "is this newer
 * than the delete I already recorded" — asking them separately is how an
 * update-on-missing quietly resurrects a deleted row.
 */
export function effectiveKey(
  rowKey: LwwTriple | null,
  tombstoneKey: LwwTriple | null,
): LwwTriple | null {
  if (rowKey === null) return tombstoneKey;
  if (tombstoneKey === null) return rowKey;
  return cmpLww(tombstoneKey, rowKey) > 0 ? tombstoneKey : rowKey;
}

/**
 * Does the parent gate let a child op through (§3.2)?
 *
 * `set_lyrics` / `clear_lyrics` need a live song; `reorder` needs a live
 * playlist; a membership op needs both. Deleted OR simply absent both mean
 * "no" — an op about an entity this device has never seen has nothing to
 * apply to, and inventing the parent would resurrect it by the back door.
 *
 * This gate sits ABOVE the echo check on purpose: a device's own metadata op,
 * replayed after the parent was deleted elsewhere, must be dropped too.
 */
export function parentGateOpen(
  sqlite: BetterSqlite3.Database,
  entityType: 'song' | 'playlist',
  entityId: string,
): boolean {
  if (readTombstone(sqlite, entityType, entityId) !== null) return false;
  const table = entityType === 'song' ? 'songs' : 'playlists';
  return sqlite.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(entityId) !== undefined;
}
