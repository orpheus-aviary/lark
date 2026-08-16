// Light/dark from `[theme] mode` in the config (M5-2): `'system'` follows the
// OS, `'light'`/`'dark'` override it. The `.dark` class on <html> is what the
// shadcn variable set keys off.

import type { ThemeMode } from '@lark/shared';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function applyDark(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
}

/** Resolve a mode against the OS preference and apply it. */
export function applyThemeMode(mode: ThemeMode): void {
  applyDark(mode === 'dark' || (mode === 'system' && window.matchMedia(DARK_QUERY).matches));
}

/**
 * Apply `mode` and keep it applied; returns the unlisten. Only `'system'`
 * subscribes to matchMedia — a forced light/dark must not flip when the OS
 * does. Driven from an effect keyed on the config's mode, so a `PATCH /config`
 * re-runs it and the previous listener is torn down (M5-2).
 */
export function watchTheme(mode: ThemeMode): () => void {
  applyThemeMode(mode);
  if (mode !== 'system') return () => {};

  const query = window.matchMedia(DARK_QUERY);
  const onChange = (e: MediaQueryListEvent): void => applyDark(e.matches);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Font-size variables (M4-12, Go-parity scopes). Both are set on <html> — the
 * same element the dark class lives on — and it is the STYLESHEET that decides
 * how far each one reaches: `--lark-global-font-size` is read by the body
 * rule, `--lark-lyrics-font-size` only by the lyrics current line (§7 F16: the
 * comment used to say these were applied to <body>, which is not where any of
 * it happens).
 */
export function applyFontSizes(globalPx: number, lyricsPx: number): void {
  const root = document.documentElement;
  root.style.setProperty('--lark-global-font-size', `${globalPx}px`);
  root.style.setProperty('--lark-lyrics-font-size', `${lyricsPx}px`);
}
