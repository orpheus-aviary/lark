// Progress + seek (D13). The Go bar was a 1px line that only accepted a
// click; this one drags, and only commits the seek on release so the audio
// element is not asked to re-buffer on every pixel.

import { useRef, useState } from 'react';
import { formatDuration } from '../lib/format.js';
import { usePlayer } from '../stores/player.js';
import { Slider } from './ui/slider.js';

export function ProgressBar(): React.JSX.Element {
  const currentTime = usePlayer((s) => s.currentTime);
  const duration = usePlayer((s) => s.duration);
  const seek = usePlayer((s) => s.seek);
  const hasSong = usePlayer((s) => s.currentSong !== null);

  const [dragTime, setDragTime] = useState<number | null>(null);
  const [hover, setHover] = useState<{ time: number; x: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const shown = dragTime ?? currentTime;

  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <div
        ref={trackRef}
        className="relative flex-1"
        onMouseMove={(event) => {
          const rect = trackRef.current?.getBoundingClientRect();
          if (!rect || duration <= 0) return;
          const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
          setHover({ time: ratio * duration, x: event.clientX - rect.left });
        }}
        onMouseLeave={() => setHover(null)}
      >
        {hover && (
          <span
            className="-translate-x-1/2 -top-5 pointer-events-none absolute rounded bg-popover px-1 text-popover-foreground text-xs shadow-sm"
            style={{ left: hover.x }}
          >
            {formatDuration(hover.time)}
          </span>
        )}
        <Slider
          aria-label="播放进度"
          value={[shown]}
          max={duration > 0 ? duration : 0}
          step={0.1}
          disabled={!hasSong || duration <= 0}
          onValueChange={([value]) => setDragTime(value ?? 0)}
          onValueCommit={([value]) => {
            setDragTime(null);
            void seek(value ?? 0);
          }}
        />
      </div>
      <span className="w-24 text-right text-muted-foreground text-xs tabular-nums">
        {formatDuration(shown)} / {formatDuration(duration)}
      </span>
    </div>
  );
}
