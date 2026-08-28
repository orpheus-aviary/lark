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

/**
 * What the window lets a mouse do (0.5.0 ⑤).
 *
 * ONE ANSWER, READ BY BOTH ENDS. Main turns `clickThrough` into
 * `setIgnoreMouseEvents`, the renderer turns the other two into a drag region
 * and a control bar — and the failure mode of two answers is the one worth
 * preventing: a window that LOOKS locked and still swallows every click over
 * whatever is behind it.
 *
 * 🔴 LOCKING IS THE WHOLE WINDOW, not a region. macOS has no finer grain
 * (electron#23042), and that is also the shape asked for — with the
 * consequence that once it is locked, nothing on this window can unlock it.
 * The only way back is the settings page, and both the button that locks it
 * and that page have to say so.
 */
export interface DesktopLyricsInteraction {
  clickThrough: boolean;
  draggable: boolean;
  controls: boolean;
}

export function desktopLyricsInteraction(locked: boolean): DesktopLyricsInteraction {
  return locked
    ? { clickThrough: true, draggable: false, controls: false }
    : { clickThrough: false, draggable: true, controls: true };
}

/**
 * What the lyric window asks the main window to change about it.
 *
 * It cannot write the config itself — it has no daemon URL and no token (see
 * `main/window.ts`) — so every control on it, and the window's own position,
 * comes back through here as a patch the main window applies.
 */
export type DesktopLyricsChange = Partial<DesktopLyricsConfig>;

/** Moving the window, or resizing it from the corner. */
export type DesktopLyricsGestureKind = 'move' | 'resize';

/**
 * A pointer gesture on the lyric window (0.5.0 §2.5 判据 19 的修订).
 *
 * 🔴 THE WINDOW IS MOVED BY THE POINTER, NOT BY A DRAG REGION. `-webkit-app-
 * region: drag` is the obvious way to make a frameless window draggable and it
 * cost this window its control bar: a drag region eats every mouse event over
 * it, so `mouseenter` never fired and the bar — which only exists while the
 * pointer is on the window — was never drawn. See `main/desktop-lyrics-
 * gesture.ts` for the arithmetic; the renderer only says when.
 *
 * `end` is not optional bookkeeping: it is what stops the window following the
 * cursor around the screen after the button comes up.
 */
export interface DesktopLyricsGesture {
  kind: DesktopLyricsGestureKind;
  phase: 'begin' | 'update' | 'end';
}

/**
 * What the settings page may show you before you have saved it (0.5.0 ⑤ 的续)。
 *
 * 🔴 ONLY WHAT YOU CAN SEE, and the list is closed on purpose:
 *
 * - `locked` is NOT here. Previewing a lock would make the window unclickable
 *   while the person is still deciding — and this page is the only way back.
 * - The geometry is NOT here. The window writes its own (it is dragged), and
 *   a page that previewed a position would fight the window for it.
 *
 * Everything else in the section is a thing you cannot choose without looking
 * at it, which is the whole reason this exists.
 */
export type DesktopLyricsPreview = Partial<
  Pick<DesktopLyricsConfig, 'enabled' | 'lines' | 'font_size' | 'preset'>
>;

/**
 * The config the floating window should draw right now.
 *
 * 🔴 NOTHING IS WRITTEN TO PREVIEW. The window is drawn from a message the
 * main window publishes, so showing a draft is a matter of publishing the
 * draft — and "close without saving" needs no undo, because the next message
 * is built from the saved config again. A preview that wrote to the config
 * would need a snapshot, a revert, and an answer for what happens if the app
 * dies in between.
 *
 * Field by field rather than a spread: a spread would carry whatever the
 * caller put in the object, and the two fields left out of {@link
 * DesktopLyricsPreview} are left out for a reason.
 */
export function previewedDesktopLyrics(
  saved: DesktopLyricsConfig,
  preview: DesktopLyricsPreview | null,
): DesktopLyricsConfig {
  if (preview === null) return saved;
  return {
    ...saved,
    enabled: preview.enabled ?? saved.enabled,
    lines: preview.lines ?? saved.lines,
    font_size: preview.font_size ?? saved.font_size,
    preset: preview.preset ?? saved.preset,
  };
}
