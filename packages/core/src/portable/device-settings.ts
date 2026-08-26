// Moving this device's settings out of the library that used to hold them
// (N7a, §4).
//
// Six keys were written into `local_metadata` between N2 and N5, all of them
// device state and none of them facts about a library. That was defensible
// while a phone had exactly one library: it was the only thing this host could
// write to, and `ports/device-settings.ts` records why that stopped being
// true. N7 gives one device several libraries, and leaving them where they are
// would mean the cache limit, the model endpoint and the Bluetooth-lyrics
// switch all changed value when the active account changed — settings nobody
// touched, moving on their own.
//
// This runs once per library, at boot. It is NOT a schema migration: the
// schema is untouched (there is no v4), the keys are simply not this
// library's, and a library that never held them produces no work.
//
// CRASH ORDER, and it is the same argument as step ⑤ before step ⑥: the file
// is written BEFORE the rows are deleted. Crash between the two and the next
// boot finds the rows still there and the values already in the file — so it
// keeps the file's copy, deletes the rows, and nothing is lost. The other
// order has a window in which the value exists nowhere.
//
// IT NEVER OVERWRITES what the device already holds. On the second library
// this device opens, the rows it finds belong to whoever wrote that library —
// a converged restore, or simply the other account's copy — and the settings
// on this device are the ones the person in front of it chose.

import { CACHE_LIMIT_KEY } from './cache-limit.js';
import { LLM_API_FORMAT_KEY, LLM_MODEL_KEY, LLM_URL_KEY } from './llm-config.js';
import type { StructuredLogger } from './logger.js';
import { NAMING_MODE_KEY } from './naming-mode.js';
import { NOW_PLAYING_MODE_KEY } from './now-playing-mode.js';
import { PLAY_MODE_KEY } from './play-mode.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';
import type { SqliteLike } from './sqlite.js';
import { SYNC_ALLOW_INSECURE_KEY } from './sync-insecure.js';

/**
 * Every `local_metadata` key that turned out to belong to the device.
 *
 * The list is closed and stays closed: a key added to it after a build has
 * shipped would delete rows a later downgrade still reads. Everything else in
 * `local_metadata` — `device_uuid`, `skybridge_*`, the backfill counters,
 * `audio_migration_pending`, `last_playback` — is genuinely per-library and
 * must not appear here (§4).
 */
export const DEVICE_SETTING_KEYS = [
  CACHE_LIMIT_KEY,
  LLM_URL_KEY,
  LLM_MODEL_KEY,
  LLM_API_FORMAT_KEY,
  NOW_PLAYING_MODE_KEY,
  PLAY_MODE_KEY,
  NAMING_MODE_KEY,
  SYNC_ALLOW_INSECURE_KEY,
] as const;

export interface AdoptDeviceSettingsResult {
  /** Keys this device took from the library because it had none of its own. */
  adopted: readonly string[];
  /** Rows removed from `local_metadata`, adopted or not. */
  cleared: number;
}

const PLACEHOLDERS = DEVICE_SETTING_KEYS.map(() => '?').join(', ');

/**
 * Take what this library still holds of the device's settings, then stop
 * holding it.
 *
 * Idempotent: a library with none of these keys does no work and touches
 * neither store, which is what every boot after the first one looks like.
 */
export async function adoptDeviceSettings(
  sqlite: SqliteLike,
  settings: DeviceSettingsPort,
  logger?: StructuredLogger,
): Promise<AdoptDeviceSettingsResult> {
  const rows = sqlite
    .prepare(`SELECT key, value FROM local_metadata WHERE key IN (${PLACEHOLDERS})`)
    .all(...DEVICE_SETTING_KEYS) as { key: string; value: string }[];

  if (rows.length === 0) return { adopted: [], cleared: 0 };

  const entries: Record<string, string> = {};
  for (const row of rows) {
    if (settings.get(row.key) === undefined) entries[row.key] = row.value;
  }

  const adopted = Object.keys(entries);
  if (adopted.length > 0) await settings.set(entries);

  const cleared = sqlite
    .prepare(`DELETE FROM local_metadata WHERE key IN (${PLACEHOLDERS})`)
    .run(...DEVICE_SETTING_KEYS).changes;

  logger?.info({ adopted, cleared }, 'device settings moved out of the library');
  return { adopted, cleared };
}

/**
 * A `DeviceSettingsPort` that remembers and nothing else.
 *
 * For tests: the readers beside this file are all about what a stored string
 * means, and none of them care where it was stored. A host backs the port with
 * a file (`apps/mobile/src/ports/device-settings.ts`).
 */
export function createMemoryDeviceSettings(
  initial: Readonly<Record<string, string>> = {},
): DeviceSettingsPort {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: async (entries) => {
      for (const [key, value] of Object.entries(entries)) values.set(key, value);
    },
  };
}
