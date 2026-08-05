// Auto light/dark (M4-12): follow the OS, no manual toggle (Go parity). The
// `.dark` class on <html> is what the shadcn variable set keys off.

export function applySystemTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
}

/** Wire matchMedia → `.dark`; returns the unlisten. Called once from main.tsx. */
export function watchSystemTheme(): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  applySystemTheme(query.matches);
  const onChange = (e: MediaQueryListEvent): void => applySystemTheme(e.matches);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Font-size variables (M4-12, Go-parity scopes): the global size is applied
 * to <body> via `--lark-global-font-size`; the lyrics size only ever reaches
 * the lyrics current line (T4) via `--lark-lyrics-font-size`.
 */
export function applyFontSizes(globalPx: number, lyricsPx: number): void {
  const root = document.documentElement;
  root.style.setProperty('--lark-global-font-size', `${globalPx}px`);
  root.style.setProperty('--lark-lyrics-font-size', `${lyricsPx}px`);
}
