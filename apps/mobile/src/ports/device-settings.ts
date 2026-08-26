// `DeviceSettingsPort` over `<nest>/device.json` (N7a).
//
// The phone's half of a split the desktop has always had: `lark_config.toml`
// holds what is true about the INSTALL, and the library holds what is true
// about the LIBRARY. Until N7 this phone had one library, so the six settings
// in §4's table went into `local_metadata` — the only thing this host could
// write to. N7 gives it several, and the accident becomes a bug: the cache
// limit, the model endpoint and the Bluetooth-lyrics switch would each change
// value when the active account changed.
//
// THE FILE ITSELF IS THE CALLER'S, not this module's, and that is the same
// split `sync/triggers.ts` and `ports/events.ts` are under: naming
// `deviceSettingsFile()` here would pull in expo-file-system, this file would
// stop loading under Node, and criterion 105 — what a missing, empty or
// corrupt file reads as — would have nowhere to be checked but a phone. The
// four lines that reach the disk live in the boot sequence, next to everything
// else that is wiring.
//
// LOADED ONCE, SYNCHRONOUSLY, and that is what makes the port's sync `get`
// possible at all: a settings form reads at render time and the download
// engine reads once per task (`() => LlmConfig`, no Promise). One read at
// construction, then memory.
//
// MEMORY IS UPDATED ONLY AFTER THE FILE IS. A form that reads its value back
// after a save — and `settings-tab.tsx` does — must not be shown a value that
// is not on disk. The reverse order would make a failed write look successful
// until the next launch.
//
// SOMETHING THIS BUILD CANNOT READ IS NOT SOMETHING IT MAY DELETE. Missing,
// empty, truncated, or JSON of the wrong shape all read as "no settings" and
// are warned about; the bytes stay where they are, and the first `set` after
// one of those replaces the file with what this build does understand. Same
// rule as every reader in `@lark/core/portable`, and for the same reason: it
// may have been written by a build that is not this one.

import type { DeviceSettingsPort, StructuredLogger } from '@lark/core/portable';

/** Only strings, because the port is a string KV and so was `local_metadata`. */
function coerce(parsed: unknown, logger?: StructuredLogger): Record<string, string> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger?.warn({}, 'device.json is not an object — reading it as no settings at all');
    return {};
  }

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') values[key] = value;
    else logger?.warn({ key }, 'device.json holds a value that is not a string — ignoring it');
  }
  return values;
}

export interface DeviceSettingsDeps {
  /** The file's text, or `null` when there is no file. May throw. */
  load: () => string | null;
  /** Replace the file, atomically. Rejects if it could not. */
  save: (text: string) => Promise<void>;
  logger?: StructuredLogger;
}

export function createDeviceSettings(deps: DeviceSettingsDeps): DeviceSettingsPort {
  let values: Record<string, string>;
  try {
    const text = deps.load();
    // `JSON.parse` refuses the empty file, which is what a write killed
    // between create and rename used to look like.
    values = text === null ? {} : coerce(JSON.parse(text), deps.logger);
  } catch (err) {
    deps.logger?.warn(
      { err: String(err) },
      'device.json could not be read — this device falls back to its defaults',
    );
    values = {};
  }

  // Writes take turns. Two settings saved in the same breath would otherwise
  // race to replace the same file, and the winner would be whichever finished
  // last — with the other one's key missing from it.
  let queue = Promise.resolve();

  return {
    get: (key) => values[key],

    set(entries) {
      queue = queue
        .catch(() => {})
        .then(async () => {
          const next = { ...values, ...entries };
          await deps.save(JSON.stringify(next, null, 2));
          values = next;
        });
      return queue;
    },
  };
}
