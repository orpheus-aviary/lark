// What the floating window draws, and the only controls it has (⑤).
//
// It is told everything and asks for nothing: no store, no fetch, no timer.
// One IPC subscription in, one line (or two) out — and one channel back for
// the things its own control bar changes, because this window has no daemon.
//
// THE OUTLINE IS A SECOND COPY OF THE TEXT, positioned underneath.
// `-webkit-text-stroke` alone paints the stroke centred ON the glyph, which
// eats into the letterforms and turns thin at the size this window uses; a
// stroked copy behind an unstroked one gives the whole stroke width outside
// the glyph, which is what makes white text survive a white background.
//
// 🔴 THE WINDOW IS MOVED BY THE POINTER, NOT BY A `-webkit-app-region` REGION.
// It was a drag region until 判据 19 caught what that costs: a drag region
// swallows every mouse event over it, so `onMouseEnter` never fired and the
// control bar below — which is drawn ONLY while the pointer is on the window
// — could not exist. `no-drag` cannot rescue it either: it punches holes in
// elements that are already drawn, and the bar is not drawn yet. So a press
// starts a gesture and main does the moving (`main/desktop-lyrics-gesture.ts`).

import { DESKTOP_LYRICS_BOUNDS, DESKTOP_LYRICS_PRESETS } from '@lark/shared';
import { useEffect, useRef, useState } from 'react';
import {
  type DesktopLyricsGestureKind,
  type DesktopLyricsMessage,
  desktopLyricsInteraction,
} from '../../../shared/desktop-lyrics.js';
import { getPlatform } from '../platform/index.js';
import { DESKTOP_LYRICS_PALETTES } from './palette.js';

/** The stroke, relative to the font size. Thin enough to read, thick enough to see. */
const STROKE_RATIO = 0.1;
const FONT_STEP = 4;

export function DesktopLyrics(): React.JSX.Element {
  const [state, setState] = useState<DesktopLyricsMessage | null>(null);
  const [hovering, setHovering] = useState(false);
  /** The lock is two taps: the first one explains what it costs. */
  const [confirmingLock, setConfirmingLock] = useState(false);
  /** Which gesture the pointer is in the middle of — a ref, because no pixel
      of this window depends on it and a re-render per mouse move would. */
  const gestureKind = useRef<DesktopLyricsGestureKind | null>(null);

  useEffect(() => getPlatform().onDesktopLyrics(setState), []);

  // Nothing until the first message. A window that painted defaults would
  // flash the wrong font size and colour on the way in.
  if (state === null) return <div className="lyrics-window" />;

  const config = state.config;
  const interaction = desktopLyricsInteraction(config.locked);
  const palette = DESKTOP_LYRICS_PALETTES[config.preset];
  const size = config.font_size;
  const change = getPlatform().requestDesktopLyricsChange;
  const gesture = getPlatform().sendDesktopLyricsGesture;

  const beginGesture = (event: React.PointerEvent, kind: DesktopLyricsGestureKind): void => {
    // Left button only, and never while another gesture is live: a second
    // press mid-drag would re-anchor the window under a cursor that is already
    // somewhere else, and the window would jump.
    if (!interaction.draggable || event.button !== 0 || gestureKind.current !== null) return;
    // Captured so the gesture survives the pointer leaving the window — which
    // it does constantly while resizing, and at the end of any quick drag.
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureKind.current = kind;
    gesture({ kind, phase: 'begin' });
  };
  const updateGesture = (): void => {
    const kind = gestureKind.current;
    if (kind === null) return;
    gesture({ kind, phase: 'update' });
  };
  const endGesture = (): void => {
    const kind = gestureKind.current;
    if (kind === null) return;
    gestureKind.current = null;
    gesture({ kind, phase: 'end' });
  };

  return (
    <div
      className={interaction.draggable ? 'lyrics-window lyrics-draggable' : 'lyrics-window'}
      style={{
        fontSize: `${size}px`,
        // Consumed by `lyrics.css`, so the palette reaches the markup below
        // without a class per scheme.
        ['--lyrics-outline' as string]: palette.outline,
        ['--lyrics-fill' as string]: palette.fill,
        ['--lyrics-active' as string]: palette.active,
        ['--lyrics-stroke' as string]: `${Math.max(1, Math.round(size * STROKE_RATIO))}px`,
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => {
        setHovering(false);
        setConfirmingLock(false);
      }}
      onPointerDown={(event) => beginGesture(event, 'move')}
      onPointerMove={updateGesture}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      {/* Where the window actually is. Everything else on it is transparent,
          so without this nobody can tell what they are about to grab — or that
          there is anything to grab at all. It goes on hover, with the controls,
          for the same reason they do: a permanent panel over somebody's screen
          is furniture. */}
      {interaction.controls && hovering && <span className="lyrics-hint" aria-hidden="true" />}

      {rows(state).map((row) => (
        <Line key={row.key} text={row.text} active={row.active} />
      ))}

      {/* Only while it is unlocked, and only while the pointer is on it: a
          control bar parked permanently over somebody's screen is furniture,
          not a control. */}
      {interaction.controls && hovering && (
        // A press on a button is not a press on the window — without this,
        // pressing 「A+」 and twitching would drag the window along with it.
        <div className="lyrics-bar" onPointerDown={(event) => event.stopPropagation()}>
          {confirmingLock ? (
            <>
              {/* The sentence the user asked to be told, at the moment it
                  starts being true. The settings page says it too (P9d). */}
              <span className="lyrics-bar-note">锁定后点不到它了，解锁要回设置页</span>
              <button type="button" onClick={() => change({ locked: true })}>
                锁定
              </button>
              <button type="button" onClick={() => setConfirmingLock(false)}>
                取消
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                title="小一点"
                disabled={size <= DESKTOP_LYRICS_BOUNDS.fontSize.min}
                onClick={() =>
                  change({
                    font_size: Math.max(DESKTOP_LYRICS_BOUNDS.fontSize.min, size - FONT_STEP),
                  })
                }
              >
                A-
              </button>
              <button
                type="button"
                title="大一点"
                disabled={size >= DESKTOP_LYRICS_BOUNDS.fontSize.max}
                onClick={() =>
                  change({
                    font_size: Math.min(DESKTOP_LYRICS_BOUNDS.fontSize.max, size + FONT_STEP),
                  })
                }
              >
                A+
              </button>
              <button
                type="button"
                title="换个配色"
                onClick={() => change({ preset: nextPreset(config.preset) })}
              >
                配色
              </button>
              <button type="button" title="锁定" onClick={() => setConfirmingLock(true)}>
                锁定
              </button>
              <button type="button" title="关掉桌面歌词" onClick={() => change({ enabled: false })}>
                关闭
              </button>
            </>
          )}
        </div>
      )}

      {/* 🔴 THE GRIP RESIZES THE WINDOW ITSELF. It used to be a sign pointing
          at the platform's edges, and Electron's own docs say the platform
          will not oblige: a transparent window is not resizable. So the corner
          does the work, on the same pointer machinery as the drag. */}
      {interaction.controls && hovering && (
        <span
          className="lyrics-grip"
          aria-hidden="true"
          onPointerDown={(event) => {
            event.stopPropagation();
            beginGesture(event, 'resize');
          }}
        />
      )}
    </div>
  );
}

/** Round-robin, because there are four and a picker would need a window. */
function nextPreset(
  current: DesktopLyricsMessage['config']['preset'],
): (typeof DESKTOP_LYRICS_PRESETS)[number] {
  const at = DESKTOP_LYRICS_PRESETS.indexOf(current);
  return DESKTOP_LYRICS_PRESETS[(at + 1) % DESKTOP_LYRICS_PRESETS.length] ?? 'classic';
}

interface Row {
  key: string;
  text: string;
  active: boolean;
}

/**
 * What to put on the window, in order.
 *
 * Nothing loaded draws NOTHING — an empty transparent strip is the honest
 * answer, and a placeholder would be a permanent label sitting over somebody's
 * screen. A song with no lyrics, or one still in its intro, is named instead:
 * that is the difference between "no words for this" and "the window is
 * broken".
 */
function rows(state: DesktopLyricsMessage): Row[] {
  if (state.song === null) return [];
  const current = state.lyrics[state.index];
  if (current === undefined) {
    return [{ key: 'song', text: state.song.name, active: false }];
  }
  const out: Row[] = [{ key: `line-${state.index}`, text: current.text, active: true }];
  if (state.config.lines === 2) {
    const next = state.lyrics[state.index + 1];
    // A blank second row rather than none: two lines that collapse to one at
    // the end of a song would move the first line every time.
    out.push({ key: `line-${state.index + 1}`, text: next?.text ?? '', active: false });
  }
  return out;
}

function Line({ text, active }: { text: string; active: boolean }): React.JSX.Element {
  return (
    <p className={active ? 'lyrics-line lyrics-line-active' : 'lyrics-line'}>
      <span aria-hidden="true" className="lyrics-stroke">
        {text}
      </span>
      <span className="lyrics-fill">{text}</span>
    </p>
  );
}
