// This install's LOCAL identity, as portable code (N2b, decision j).
//
// It used to live in `db/index.ts` taking a `BetterSqlite3.Database`, which
// made it desktop-only by signature alone — and every business write that
// emits a `sync_changes` row goes through `readLocalDeviceUuid`
// (`sync/changes.ts`), which THROWS when the row is missing on the grounds
// that "createDatabase guarantees this row". A mobile bootstrap without this
// call therefore does not fail at open; it fails on the first song rename,
// with an error about a database that "was not opened by us". Hence the move:
// the desktop keeps calling it in the same place and re-exports it, and the
// mobile boot sequence gets to make the same guarantee.
//
// `device_uuid` is NOT the skybridge registration id that entity rows carry as
// `device_id` — two identity domains that must never mix (R18). D16's converge
// deliberately deletes this value so step ⑨ mints a new one: leaving it would
// have two installs claiming one local identity, and the tombstone / echo
// rules of sync are decided by exactly that value.

import { isUuidV4 } from '@lark/shared';
import type { StructuredLogger } from './logger.js';
import { uuid } from './runtime/random.js';
import type { SqliteLike } from './sqlite.js';

/**
 * Ensure `local_metadata.device_uuid` holds a valid lowercase UUID v4.
 *
 * Single code path, no SQL seeding: every value ever stored here came from the
 * Random port, so a host that has not installed one is refused loudly rather
 * than handed a `Math.random()` id that collides across devices.
 *
 * An existing value that fails isUuidV4 counts as corruption: regenerate +
 * warn.
 */
export function ensureDeviceUuid(sqlite: SqliteLike, logger?: StructuredLogger): string {
  const read = () =>
    sqlite.prepare("SELECT value FROM local_metadata WHERE key='device_uuid'").get() as
      | { value: string }
      | undefined;

  const existing = read();
  if (existing && isUuidV4(existing.value)) return existing.value;

  const fresh = uuid();
  if (existing) {
    logger?.warn(
      { stored: existing.value },
      'local_metadata.device_uuid was invalid — regenerated',
    );
    sqlite.prepare("UPDATE local_metadata SET value=? WHERE key='device_uuid'").run(fresh);
  } else {
    sqlite
      .prepare(
        "INSERT INTO local_metadata (key, value) VALUES ('device_uuid', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run(fresh);
  }

  const persisted = read();
  if (!persisted || !isUuidV4(persisted.value)) {
    throw new Error('ensureDeviceUuid failed to persist a valid device_uuid');
  }
  return persisted.value;
}
