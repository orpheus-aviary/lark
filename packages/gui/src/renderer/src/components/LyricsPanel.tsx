// Three-slot lyrics view (D15): previous / current / next, the current line
// centred and bold at the configurable lyrics font size. The ± buttons write
// the offset straight to the song — `lyrics_offset` in the database is the
// one source of truth, which is also why the parser ignores any `[offset:]`
// tag inside the file (M4-13④).

import { currentLrcIndex } from '@lark/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { usePlayer } from '../stores/player.js';
import { Button } from './ui/button.js';

const OFFSET_STEP_SECONDS = 0.5;
const OFFSET_BADGE_MS = 1500;

/**
 * FIXED height, not a minimum. The panel sits below the song list, which is
 * the flex child that absorbs everything left over — so any height change
 * here moves the controls and resizes the list. Two things used to change it:
 * the "not playing" branch is one line where playing is three, and the
 * current line's size follows `--lark-lyrics-font-size`. The height is
 * therefore pinned, and the current line is capped so a large configured
 * font cannot push past it.
 */
const PANEL_HEIGHT = 'h-20 shrink-0';
const CURRENT_LINE_MAX = '1.75rem';

function formatOffset(offset: number): string {
  return `${offset > 0 ? '+' : ''}${offset.toFixed(1)}s`;
}

export function LyricsPanel(): React.JSX.Element {
  const currentSong = usePlayer((s) => s.currentSong);
  const currentTime = usePlayer((s) => s.currentTime);
  const lyrics = usePlayer((s) => s.lyrics);
  const adjustLyricsOffset = usePlayer((s) => s.adjustLyricsOffset);

  const offset = currentSong?.lyrics_offset ?? 0;
  const [showOffset, setShowOffset] = useState(false);

  // The badge is a transient acknowledgement of the last adjustment, so it
  // keys off the offset value rather than the click.
  useEffect(() => {
    // Zero is a value, not an absence (§7 F8): stepping the offset back to 0
    // used to return early and leave the badge showing the number before it,
    // which then stayed on screen until the next adjustment.
    if (offset === 0) {
      setShowOffset(false);
      return;
    }
    setShowOffset(true);
    const timer = setTimeout(() => setShowOffset(false), OFFSET_BADGE_MS);
    return () => clearTimeout(timer);
  }, [offset]);

  if (!currentSong) {
    return (
      <div className={`${PANEL_HEIGHT} flex items-center justify-center px-3`}>
        <p className="text-muted-foreground text-xs">未播放</p>
      </div>
    );
  }

  const index = currentLrcIndex(lyrics, currentTime, offset);
  const line = (at: number): string => lyrics[at]?.text ?? '';
  const current = index >= 0 ? line(index) : '';

  return (
    <div className={`${PANEL_HEIGHT} flex items-center px-3`}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="歌词后移 0.5 秒"
        title={`歌词后移 0.5 秒（当前 ${formatOffset(offset)}）`}
        onClick={() => void adjustLyricsOffset(-OFFSET_STEP_SECONDS)}
      >
        <ChevronLeft />
      </Button>
      <div className="relative flex-1 space-y-1 overflow-hidden text-center">
        {showOffset && (
          <span className="absolute top-0 right-2 text-[10px] text-muted-foreground">
            {formatOffset(offset)}
          </span>
        )}
        <p className="truncate text-muted-foreground text-xs leading-tight">
          {index > 0 ? line(index - 1) : ' '}
        </p>
        <p
          className="truncate font-bold leading-tight"
          style={{ fontSize: `min(var(--lark-lyrics-font-size, 14px), ${CURRENT_LINE_MAX})` }}
        >
          {current || (lyrics.length === 0 ? '暂无歌词' : ' ')}
        </p>
        <p className="truncate text-muted-foreground text-xs leading-tight">
          {index >= 0 && index < lyrics.length - 1 ? line(index + 1) : ' '}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="歌词前移 0.5 秒"
        title={`歌词前移 0.5 秒（当前 ${formatOffset(offset)}）`}
        onClick={() => void adjustLyricsOffset(OFFSET_STEP_SECONDS)}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}
