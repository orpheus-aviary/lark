// "Does this install accept a sync server that is not HTTPS?" (N5b, decision a)
//
// One key in `local_metadata`, beside `device_uuid`, `now_playing_mode`,
// `play_mode`, `naming_mode` and `cache_limit_mb`, and for the same reason: a
// PER-INSTALL preference, never a fact about the library, so it stays out of
// `sync_changes`. A phone on somebody's home LAN and a laptop on a café
// network want different answers, and skybridge has no business reconciling
// them.
//
// WHY THIS EXISTS WHEN `allow_insecure_http` ALREADY DOES. They are different
// things at different moments. `SkybridgeServerSection.allow_insecure_http` is
// a RECORD: it lands in the credential store as a consequence of a login that
// was already allowed, so a later reader can see why a plaintext URL was
// accepted. This is the DECISION, and it has to exist BEFORE there are any
// credentials to record it in — the desktop can get away without it because
// its decision is a checkbox on the login form itself, and lark's rule is that
// the phone's is a persistent switch in settings (master plan §4.3, Stage-4).
//
// FAIL CLOSED, and note that the storage format does it for us: the value is
// `'1'` or `'0'` (same convention as `audio_migration_pending`), and anything
// this build does not recognise — a missing row, an empty string, a `'true'`
// written by some future build — is not `'1'` and therefore refuses plaintext.
// The direction matters more here than anywhere else in this directory: being
// wrong toward `false` costs a login attempt and an error message, and being
// wrong toward `true` sends somebody's password over the network in the clear.
//
// The read path never writes. A value we cannot parse belongs to another build
// of this install, not to us.

import type { StructuredLogger } from './logger.js';
import type { SqliteLike } from './sqlite.js';

export const SYNC_ALLOW_INSECURE_KEY = 'sync_allow_insecure';

/** Refuse plaintext until somebody says otherwise. */
export const DEFAULT_SYNC_ALLOW_INSECURE = false;

/**
 * Whether this install has opted in to a plaintext sync server.
 *
 * Missing row and unrecognised value both read as "no", and neither touches
 * the library. An unrecognised value is logged rather than swallowed: the
 * failure it produces otherwise — a switch that looks on but a login that
 * still refuses http — has no other clue attached to it.
 */
export function readSyncAllowInsecure(sqlite: SqliteLike, logger?: StructuredLogger): boolean {
  const row = sqlite
    .prepare('SELECT value FROM local_metadata WHERE key = ?')
    .get(SYNC_ALLOW_INSECURE_KEY) as { value: string } | undefined;

  if (row === undefined) return DEFAULT_SYNC_ALLOW_INSECURE;
  if (row.value === '1') return true;
  if (row.value === '0') return false;

  logger?.warn(
    { key: SYNC_ALLOW_INSECURE_KEY, stored: row.value },
    `local_metadata.${SYNC_ALLOW_INSECURE_KEY} is not a value this build wrote — reading it as ${DEFAULT_SYNC_ALLOW_INSECURE} (plaintext refused)`,
  );
  return DEFAULT_SYNC_ALLOW_INSECURE;
}

/**
 * Set the switch. Upsert, because the row only exists once someone has chosen.
 *
 * Turning it back OFF keeps the row at `'0'` rather than deleting it, matching
 * `audio_migration_pending`: `local_metadata` is a log of what this library
 * has been told, and "somebody turned this off" is worth more than the absence
 * of a row that never distinguishes "off" from "never asked".
 */
export function writeSyncAllowInsecure(sqlite: SqliteLike, allow: boolean): void {
  sqlite
    .prepare(
      'INSERT INTO local_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(SYNC_ALLOW_INSECURE_KEY, allow ? '1' : '0');
}
