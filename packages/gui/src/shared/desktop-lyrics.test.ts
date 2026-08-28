// ⑤ 的续 — what the settings page is allowed to show you before you save it.

import type { DesktopLyricsConfig } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { type DesktopLyricsPreview, previewedDesktopLyrics } from './desktop-lyrics.js';

const SAVED: DesktopLyricsConfig = {
  enabled: true,
  lines: 1,
  font_size: 32,
  preset: 'classic',
  locked: false,
  x: 100,
  y: 200,
  width: 900,
  height: 120,
};

describe('previewing the lyric window', () => {
  it('shows the draft over the saved config', () => {
    expect(previewedDesktopLyrics(SAVED, { lines: 2, font_size: 48, preset: 'night' })).toEqual({
      ...SAVED,
      lines: 2,
      font_size: 48,
      preset: 'night',
    });
  });

  it('leaves alone what the draft says nothing about', () => {
    expect(previewedDesktopLyrics(SAVED, { preset: 'warm' }).font_size).toBe(32);
    expect(previewedDesktopLyrics(SAVED, {})).toEqual(SAVED);
    expect(previewedDesktopLyrics(SAVED, null)).toBe(SAVED);
  });

  // 🔴 A preview is "I have not decided yet", and a locked window cannot be
  // clicked — including the page that is the only way to unlock it. Locking
  // waits for 保存, and so does the geometry, which the window writes itself.
  it('cannot lock the window or move it, whatever it is handed', () => {
    const overreach = {
      locked: true,
      x: -4000,
      y: -2000,
      width: 10,
      height: 10,
    } as unknown as DesktopLyricsPreview;

    expect(previewedDesktopLyrics(SAVED, overreach)).toEqual(SAVED);
  });
});
