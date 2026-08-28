// What the floating lyric window is told (0.5.0 ⑤).
//
// 🔴 IT COMES OVER IPC, NOT FROM THE DAEMON, and that is the design rather
// than a shortcut. Playback happens on the main window's `<audio>` element,
// which already has the time and the parsed lyrics; a second window that
// asked the daemon would need its own token, its own CSP and its own
// connection — and `POST /player/report` is a two-second heartbeat, so a line
// driven by it would visibly lag and stutter. The one process that knows
// where the needle is tells the one window that draws it.
//
// PUBLISHED PER LINE, NOT PER TICK. The window renders lines, not a
// stopwatch, so the only moments it needs to hear about are the ones where
// what it draws changes: a new line, a new song, or a pause. That is roughly
// once every few seconds instead of four times a second, and it is why the
// whole lyric array can ride along on every message — stateless, so a dropped
// message fixes itself on the next line rather than leaving the window
// showing a song that ended ten minutes ago.

import type { DesktopLyricsConfig, LrcLine } from '@lark/shared';

/**
 * ONE MESSAGE, carrying both halves.
 *
 * 🔴 THE MAIN WINDOW IS THE ONLY DRIVER, config included. Main could read
 * `lark_config.toml` itself, but then two processes would hold an opinion
 * about whether the window is open — and the one that changes it (the
 * settings page) lives in the renderer, so main's copy would be the stale
 * one. The renderer already has the config store AND the player, which is
 * exactly the two halves of this message.
 */
export interface DesktopLyricsMessage {
  /** Whether the window exists at all, where it is, and how it looks. */
  config: DesktopLyricsConfig;
  /** `null` when nothing is loaded — the window then draws nothing at all. */
  song: { name: string; artist: string } | null;
  lyrics: readonly LrcLine[];
  /** Which line is sounding, `-1` before the first one (`currentLrcIndex`). */
  index: number;
  playing: boolean;
}
