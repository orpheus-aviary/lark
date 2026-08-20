// Transport controls, plus the local-import button that shares this row in
// the Go version (D20).

import { PLAY_MODE_LABELS, type PlayMode } from '@lark/shared';
import {
  ArrowRight,
  FolderOpen,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { getPlatform } from '../platform/index.js';
import { useDownloads } from '../stores/download.js';
import { usePlayer } from '../stores/player.js';
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
  const importFiles = useDownloads((s) => s.importFiles);
  const [importing, setImporting] = useState(false);

  const ModeIcon = MODE_ICONS[playMode];

  /**
   * D20: the Go version imported silently — one file per 200 could fail and
   * nothing said so. `ImportResultData` has a per-file failure channel, so it
   * gets reported.
   *
   * Since 0.3.0 a SUCCESS can owe the user a sentence too: the library holds
   * one format, so importing a FLAC re-encodes it and importing a two-track
   * file keeps one track. Those are warnings, not errors — the song is in the
   * library either way, and they say what its copy does not carry (§3.4).
   */
  async function importLocalFiles(): Promise<void> {
    setImporting(true);
    try {
      const paths = await getPlatform().pickAudio();
      if (paths.length === 0) return;
      const result = await importFiles(paths);
      if (result.imported.length > 0) toast.success(`已导入 ${result.imported.length} 首`);
      for (const entry of result.imported) {
        for (const warning of entry.warnings) {
          toast.warning(`${entry.name}：${warning}`);
        }
      }
      for (const failure of result.failed) {
        toast.error(`导入失败：${failure.path} — ${failure.reason}`);
      }
      if (result.imported.length === 0 && result.failed.length === 0) {
        toast.info('没有可导入的文件');
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setImporting(false);
    }
  }

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
        className={playMode === 'sequential' ? '' : 'text-state-active'}
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
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="导入本地音频"
        title="导入本地音频"
        disabled={importing}
        onClick={() => void importLocalFiles()}
      >
        <FolderOpen />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="下一曲" onClick={() => void next()}>
        <SkipForward />
      </Button>
    </div>
  );
}
