// The four colour schemes (⑤).
//
// THREE COLOURS EACH, and that is the contract `DesktopLyricsPalette` froze in
// P9a: the window floats over a white document as often as over a dark
// editor, so a fill alone is unreadable half the time. The outline is what
// makes it legible on both; the highlight is the line that is sounding.
//
// The values are the renderer's, not the config's — a scheme is a NAME on
// disk, so recolouring one is a change to this file and not a migration.

import type { DesktopLyricsPalette, DesktopLyricsPreset } from '@lark/shared';

export const DESKTOP_LYRICS_PALETTES: Record<DesktopLyricsPreset, DesktopLyricsPalette> = {
  /** 经典 — white on near-black, the shape every player on this desktop uses. */
  classic: { outline: '#0a0a0aee', fill: '#fafafa', active: '#efb146' },
  /** 夜色 — for a dark screen: cooler, and the highlight is the cyan end. */
  night: { outline: '#0b1220ee', fill: '#dbe7ff', active: '#59d0ff' },
  /** 暖阳 — warm greys, for a light desktop where white loses contrast. */
  warm: { outline: '#3b2a1aee', fill: '#fdf4e3', active: '#f0a02a' },
  /** 素白 — the quiet one: no colour at all, just legible. */
  plain: { outline: '#000000cc', fill: '#ffffffcc', active: '#ffffff' },
};
