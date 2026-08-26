// "How did this install name the last song it downloaded?" (N4d, decisions k
// and f)
//
// A DEVICE setting (N7a): a per-install preference, never a fact about any
// library, so it stays out of `sync_changes` and — since N7, where one phone
// holds several libraries — out of the libraries themselves. The desktop keeps
// the same choice in localStorage (`gui/lib/naming-mode.ts`), which is device
// state by construction; this is the phone's half of the same split. What must
// not differ is the MEANING of the two values, and that lives in
// `@lark/shared`.
//
// The read path never writes. A value we cannot parse belongs to another build
// of this install, not to us.
//
// WHAT IS DIFFERENT FROM ITS SIBLINGS: reading and defaulting are two
// functions here, not one. `clean` asks a model for the song and the artist
// inside a bilibili title, so on an install with no model configured it is not
// a preference — it is a submission that will be refused before any network
// happens (`preflightSingle`). A default therefore cannot be a constant; it is
// a question about the install, which is why `resolveNamingMode` takes
// `hasLlm` and this module exports no DEFAULT_ of its own.

import { DOWNLOAD_NAMING_MODES, type DownloadNamingMode } from '@lark/shared';
import type { StructuredLogger } from './logger.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

export const NAMING_MODE_KEY = 'naming_mode';

/**
 * The value set is `@lark/shared`'s; only the guard is local.
 *
 * `types.ts` is types and constants with no functions in it, and one predicate
 * is not a reason to change that — what matters is that nobody writes the two
 * strings out a second time.
 */
const isNamingMode = (value: unknown): value is DownloadNamingMode =>
  DOWNLOAD_NAMING_MODES.some((mode) => mode === value);

/**
 * What this install chose last time, or `null` when it has never been asked.
 *
 * `null` is a real answer and not a default in disguise: "never chosen" and
 * "chose `original`" want different things from `resolveNamingMode`, because
 * only the first of them may change its mind when a model appears.
 */
export function readNamingMode(
  settings: DeviceSettingsPort,
  logger?: StructuredLogger,
): DownloadNamingMode | null {
  const stored = settings.get(NAMING_MODE_KEY);

  if (stored === undefined) return null;
  if (isNamingMode(stored)) return stored;

  logger?.warn(
    { key: NAMING_MODE_KEY, stored },
    `${NAMING_MODE_KEY} is not a mode this build knows — falling back to the default`,
  );
  return null;
}

/** Remember the choice. */
export function writeNamingMode(
  settings: DeviceSettingsPort,
  mode: DownloadNamingMode,
): Promise<void> {
  return settings.set({ [NAMING_MODE_KEY]: mode });
}

/**
 * Which mode a submission form opens on (decision f).
 *
 * Remembered wins, always — including a remembered `clean` on an install that
 * has since lost its model, because the form disables that chip and says why,
 * and silently moving somebody's choice would be a worse answer than a
 * disabled chip with a reason on it.
 *
 * With nothing remembered the answer depends on the install. The desktop
 * defaults to `clean` because a bilibili title is usually not a song name; on
 * a phone with no model that same default makes the very first submission hit
 * an LLM gate, which is a wall rather than a preference. So: `clean` where
 * there is a model to run it, `original` where there is not — a rule that
 * needs no migration once N4e gives the phone a settings page.
 */
export function resolveNamingMode(input: {
  remembered: DownloadNamingMode | null;
  hasLlm: boolean;
}): DownloadNamingMode {
  if (input.remembered !== null) return input.remembered;
  return input.hasLlm ? 'clean' : 'original';
}
