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
  /**
   * State, and only state — the desktop's own two tokens, converted from the
   * `oklch` its dark theme uses (`style.css`: `--state-pinned` blue,
   * `--state-active` amber). Neither is an accent: lark has none, `--primary`
   * is the body colour, so nothing decorative may reach for these.
   *
   * `active` is the row that is playing (N3c). It was defined here before
   * there was a player, so that the row would be the SAME amber the desktop
   * paints rather than a second amber somebody picked later.
   */
  pinned: '#59a6ff',
  active: '#efb146',
} as const;

export const S = {
  gap: 8,
  pad: 16,
  radius: 10,
} as const;
