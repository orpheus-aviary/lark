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
    if (offset === 0) return;
    setShowOffset(true);
    const timer = setTimeout(() => setShowOffset(false), OFFSET_BADGE_MS);
    return () => clearTimeout(timer);
  }, [offset]);

  if (!currentSong) {
    return (
      <div className="flex min-h-14 items-center justify-center px-3 py-2">
        <p className="text-muted-foreground text-xs">未播放</p>
      </div>
    );
  }

  const index = currentLrcIndex(lyrics, currentTime, offset);
  const line = (at: number): string => lyrics[at]?.text ?? '';
  const current = index >= 0 ? line(index) : '';

  return (
    <div className="flex items-center px-3 py-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="歌词后移 0.5 秒"
        title={`歌词后移 0.5 秒（当前 ${formatOffset(offset)}）`}
        onClick={() => void adjustLyricsOffset(-OFFSET_STEP_SECONDS)}
      >
        <ChevronLeft />
      </Button>
      <div className="relative min-h-14 flex-1 space-y-1 text-center">
        {showOffset && (
          <span className="absolute top-0 right-2 text-[10px] text-muted-foreground">
            {formatOffset(offset)}
          </span>
        )}
        <p className="truncate text-muted-foreground text-xs">
          {index > 0 ? line(index - 1) : ' '}
        </p>
        <p
          className="truncate font-bold"
          style={{ fontSize: 'var(--lark-lyrics-font-size, 14px)' }}
        >
          {current || (lyrics.length === 0 ? '暂无歌词' : ' ')}
        </p>
        <p className="truncate text-muted-foreground text-xs">
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
