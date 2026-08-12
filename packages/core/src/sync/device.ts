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

import type BetterSqlite3 from 'better-sqlite3';

const KEY_DEVICE_ID = 'skybridge_device_id';

/** The registered device id, or null when this library has never bound. */
export function readSkybridgeDeviceId(sqlite: BetterSqlite3.Database): string | null {
  const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(KEY_DEVICE_ID) as
    | { value: string | null }
    | undefined;
  const value = row?.value ?? null;
  return value === null || value === '' ? null : value;
}

export function setSkybridgeDeviceId(sqlite: BetterSqlite3.Database, deviceId: string): void {
  sqlite
    .prepare(
      `INSERT INTO local_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(KEY_DEVICE_ID, deviceId);
}

/** Forget the registration. Only `unbind` and a revoked device do this. */
export function clearSkybridgeDeviceId(sqlite: BetterSqlite3.Database): void {
  sqlite.prepare('DELETE FROM local_metadata WHERE key = ?').run(KEY_DEVICE_ID);
}
