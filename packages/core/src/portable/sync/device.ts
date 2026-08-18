import type { SqliteLike } from '../sqlite.js';
// The skybridge device identity, as core sees it (v0.2 T1, §3.10 / R18).
//
// Two identities exist and they must never be confused:
//
//   local_metadata.device_uuid          this install, always present, minted
//                                       at database creation. Forensics on
//                                       outbox rows.
//   local_metadata.skybridge_device_id  the id the SERVER gave this device at
//                                       registration. Absent until first
//                                       login, and what every LWW key carries.
//
// Entity rows keep the skybridge id because that is what a peer compares
// against; using the local uuid would make the third element of the LWW key
// meaningless to everyone else. Before registration it is simply NULL, which
// the comparison reads as `''` and which loses every tie — correct, because a
// library that never registered has no standing in someone else's ordering.
//
// The key lives under the `skybridge_` prefix that `unbind` wipes wholesale.

const KEY_DEVICE_ID = 'skybridge_device_id';

/** The registered device id, or null when this library has never bound. */
export function readSkybridgeDeviceId(sqlite: SqliteLike): string | null {
  const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(KEY_DEVICE_ID) as
    | { value: string | null }
    | undefined;
  const value = row?.value ?? null;
  return value === null || value === '' ? null : value;
}

export function setSkybridgeDeviceId(sqlite: SqliteLike, deviceId: string): void {
  sqlite
    .prepare(
      `INSERT INTO local_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(KEY_DEVICE_ID, deviceId);
}

/** Forget the registration. Only `unbind` and a revoked device do this. */
export function clearSkybridgeDeviceId(sqlite: SqliteLike): void {
  sqlite.prepare('DELETE FROM local_metadata WHERE key = ?').run(KEY_DEVICE_ID);
}

/** Tables whose rows carry the LWW key's third element. */
const LWW_TABLES = ['songs', 'playlists', 'playlist_songs', 'sync_tombstones'] as const;

export interface DeviceStampResult {
  /** Rows that took the new id, per table. */
  updated: Record<string, number>;
  mode: 'first-registration' | 'device-changed' | 'unchanged';
}

/**
 * Stamp local rows with the registered device id (§3.7, §3.10).
 *
 * Runs inside the login installer's transaction, and the two cases it handles
 * are genuinely different:
 *
 *   FIRST REGISTRATION — everything this library ever wrote carries NULL (or,
 *     on a v0.1-era row, the local uuid) where the registered id belongs. None
 *     of it has ever left the machine, so all of it is honestly ours: stamp
 *     the lot. Leaving NULLs would make every one of those rows lose every tie
 *     forever, because a NULL device id normalizes to `''` in the comparison.
 *
 *   DEVICE CHANGED — the previous registration was revoked and a new id was
 *     issued. Only rows with an UNPUSHED change may be restamped: their key has
 *     not reached the workspace yet, so rewriting it changes nothing anyone
 *     else has seen. A row that was already published belongs to the device
 *     that published it, and rewriting its id here would make this library
 *     disagree with the rest of the workspace about who wrote what.
 *
 * The pending changes themselves need no rewrite: `device_id` travels on the
 * change ENVELOPE, not in the payload (§3.10), and the envelope is built from
 * this value at push time.
 */
export function stampDeviceIdInTx(
  sqlite: SqliteLike,
  options: { deviceId: string; previousId: string | null; localUuid: string },
): DeviceStampResult {
  const { deviceId, previousId, localUuid } = options;
  const updated: Record<string, number> = {};

  if (previousId === deviceId) return { updated, mode: 'unchanged' };

  const mode = previousId === null ? 'first-registration' : 'device-changed';

  for (const table of LWW_TABLES) {
    const sql =
      mode === 'first-registration'
        ? // Three spellings of "nobody registered": NULL on an entity row, `''`
          // on a tombstone (the LWW triple normalizes a missing device to the
          // empty string on the way in), and the local uuid on a v0.1-era row.
          `UPDATE ${table} SET device_id = ? WHERE device_id IS NULL OR device_id = '' OR device_id = ?`
        : `UPDATE ${table} SET device_id = ? WHERE device_id IS NOT ? AND ${pendingClause(table)}`;
    const args = mode === 'first-registration' ? [deviceId, localUuid] : [deviceId, deviceId];
    updated[table] = sqlite.prepare(sql).run(...args).changes;
  }

  return { updated, mode };
}

/**
 * "This row still has an unpushed LWW change of its own."
 *
 * Only put and tombstone ops carry a key — `set_rank` / `reorder` / the lyrics
 * ops are ordered by the server and have no device to attribute.
 */
function pendingClause(table: (typeof LWW_TABLES)[number]): string {
  const entity =
    table === 'songs'
      ? "'song'"
      : table === 'playlists'
        ? "'playlist'"
        : table === 'playlist_songs'
          ? "'playlist_song'"
          : null;
  // Every column reference is qualified. `sync_changes` has no `id` column
  // today, so a bare `id` would happen to resolve outward to the row being
  // updated — a correlated subquery that works by luck is one column away from
  // silently matching every row instead.
  const idExpr =
    table === 'playlist_songs'
      ? "playlist_songs.playlist_id || ':' || playlist_songs.song_id"
      : table === 'sync_tombstones'
        ? 'sync_tombstones.entity_id'
        : `${table}.id`;
  const entityMatch =
    entity === null ? 'c.entity_type = sync_tombstones.entity_type' : `c.entity_type = ${entity}`;
  return `EXISTS (
    SELECT 1 FROM sync_changes c
    WHERE ${entityMatch}
      AND c.entity_id = ${idExpr}
      AND c.synced_at IS NULL
      AND c.op IN ('create','update','delete')
  )`;
}
