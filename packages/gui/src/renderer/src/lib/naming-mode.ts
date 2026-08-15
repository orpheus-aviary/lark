// The naming choice, remembered between submissions (§4-e).
//
// Remembered, never decided: the dialog still opens every time, with last
// time's answer pre-selected. Someone who always keeps original titles gets
// one keystroke instead of two; someone who alternates is never surprised by
// a choice made on their behalf.
//
// localStorage rather than the config file, on the M4-12 line: this is view
// state — which button is highlighted — and the config channel is for things
// the daemon acts on.

import type { DownloadNamingMode } from '@lark/shared';

const KEY = 'lark.naming-mode';

/**
 * Cleaning by default.
 *
 * The Go version's checkbox was "keep the original title", off by default, and
 * a bilibili title is usually not a song name — so this preserves the
 * behaviour people had, which the broken checkbox never actually delivered
 * (§3.6-1).
 */
export const DEFAULT_NAMING_MODE: DownloadNamingMode = 'clean';

export function loadNamingMode(): DownloadNamingMode {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'original' || stored === 'clean' ? stored : DEFAULT_NAMING_MODE;
  } catch {
    // Private mode, a disabled storage, a renderer without one: the default
    // is a fine answer and this is not worth a broken download button.
    return DEFAULT_NAMING_MODE;
  }
}

export function rememberNamingMode(mode: DownloadNamingMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Same: forgetting the preference is the whole cost.
  }
}
