// Transport controls. T5 adds the local-import button that sits in this row
// in the Go version (D20).

import type { PlayMode } from '@lark/shared';
import {
  ArrowRight,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { PLAY_MODE_LABELS, usePlayer } from '../stores/player.js';
import { Button } from './ui/button.js';

const MODE_ICONS: Record<PlayMode, typeof Repeat> = {
  sequential: ArrowRight,
  'repeat-all': Repeat,
  'repeat-one': Repeat1,
  shuffle: Shuffle,
};

export function Controls(): React.JSX.Element {
  const isPlaying = usePlayer((s) => s.isPlaying);
  const playMode = usePlayer((s) => s.playMode);
  const togglePlay = usePlayer((s) => s.togglePlay);
  const cycleMode = usePlayer((s) => s.cycleMode);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);

  const ModeIcon = MODE_ICONS[playMode];

  return (
    <div className="flex items-center justify-center gap-4 py-2">
      <Button variant="ghost" size="icon-sm" aria-label="上一曲" onClick={() => void prev()}>
        <SkipBack />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`播放模式：${PLAY_MODE_LABELS[playMode]}`}
        title={PLAY_MODE_LABELS[playMode]}
        className={playMode === 'sequential' ? '' : 'text-primary'}
        onClick={() => void cycleMode()}
      >
        <ModeIcon />
      </Button>
      <Button
        size="icon-lg"
        className="rounded-full"
        aria-label={isPlaying ? '暂停' : '播放'}
        onClick={() => void togglePlay()}
      >
        {isPlaying ? <Pause /> : <Play />}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="下一曲" onClick={() => void next()}>
        <SkipForward />
      </Button>
    </div>
  );
}
