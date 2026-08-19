// One place for the colours, so a screen cannot invent its own grey.
//
// The palette is the desktop's (`packages/gui`'s dark theme), and the one
// thing it does NOT have is an accent: lark's `--primary` is the body colour
// on purpose, and a mobile skin that introduced a brand blue would be a
// different product wearing the same name.

export const C = {
  /** App background. */
  bg: '#09090b',
  /** Cards, rows, the tab bar. */
  surface: '#18181b',
  /** Pressed / selected surface. */
  surfaceOn: '#27272a',
  border: '#27272a',
  text: '#fafafa',
  /** Secondary text: artists, counts, captions. */
  muted: '#a1a1aa',
  /** Tertiary: the things you read only when you go looking. */
  faint: '#71717a',
  /** Destructive only. Nothing else in the app is red. */
  danger: '#ef4444',
  ok: '#22c55e',
  /** A song whose file is not here — the desktop's amber channel. */
  missing: '#f59e0b',
} as const;

export const S = {
  gap: 8,
  pad: 16,
  radius: 10,
} as const;
