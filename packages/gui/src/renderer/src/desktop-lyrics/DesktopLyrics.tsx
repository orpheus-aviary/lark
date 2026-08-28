// What the floating window draws (⑤).
//
// It is told everything and asks for nothing: no store, no fetch, no timer.
// One IPC subscription in, one line (or two) out.
//
// THE OUTLINE IS A SECOND COPY OF THE TEXT, positioned underneath.
// `-webkit-text-stroke` alone paints the stroke centred ON the glyph, which
// eats into the letterforms and turns thin at the size this window uses; a
// stroked copy behind an unstroked one gives the whole stroke width outside
// the glyph, which is what makes white text survive a white background.

import { useEffect, useState } from 'react';
import type { DesktopLyricsMessage } from '../../../shared/desktop-lyrics.js';
import { getPlatform } from '../platform/index.js';
import { DESKTOP_LYRICS_PALETTES } from './palette.js';

/** The stroke, relative to the font size. Thin enough to read, thick enough to see. */
const STROKE_RATIO = 0.1;

export function DesktopLyrics(): React.JSX.Element {
  const [state, setState] = useState<DesktopLyricsMessage | null>(null);

  useEffect(() => getPlatform().onDesktopLyrics(setState), []);

  // Nothing until the first message. A window that painted defaults would
  // flash the wrong font size and colour on the way in.
  if (state === null) return <div className="lyrics-window" />;

  const palette = DESKTOP_LYRICS_PALETTES[state.config.preset];
  const size = state.config.font_size;

  return (
    <div
      className="lyrics-window"
      style={{
        fontSize: `${size}px`,
        // Consumed by `lyrics.css`, so the palette reaches the pseudo-free
        // markup below without a class per scheme.
        ['--lyrics-outline' as string]: palette.outline,
        ['--lyrics-fill' as string]: palette.fill,
        ['--lyrics-active' as string]: palette.active,
        ['--lyrics-stroke' as string]: `${Math.max(1, Math.round(size * STROKE_RATIO))}px`,
      }}
    >
      {rows(state).map((row) => (
        <Line key={row.key} text={row.text} active={row.active} />
      ))}
    </div>
  );
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
