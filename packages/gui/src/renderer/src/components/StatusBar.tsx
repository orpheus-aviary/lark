// Bottom strip (D24): Go's "playing · mode · total" plus a connection dot,
// since a lark GUI can now be online or offline against its daemon.

import { PLAY_MODE_LABELS } from '@lark/shared';
import { useLibrary } from '../stores/library.js';
import { usePlayer } from '../stores/player.js';
import { useSession } from '../stores/session.js';
import { SyncBadge } from './SyncBadge.js';

const SSE_LABELS = { connecting: '连接中…', online: '在线', offline: '离线' } as const;

const SSE_DOT_CLASSES = {
  connecting: 'bg-amber-400',
  online: 'bg-emerald-500',
  offline: 'bg-red-500',
} as const;

export function StatusBar(): React.JSX.Element {
  const sseStatus = useSession((s) => s.sseStatus);
  const total = useLibrary((s) => s.songs.length);
  const currentSong = usePlayer((s) => s.currentSong);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const mediaError = usePlayer((s) => s.mediaError);
  const playMode = usePlayer((s) => s.playMode);

  const playing = currentSong
    ? `${mediaError ? '播放中断' : isPlaying ? '正在播放' : '已暂停'}：${currentSong.name} - ${
        currentSong.artist || '未知歌手'
      }`
    : '未播放';

  return (
    <footer className="flex h-7 shrink-0 items-center gap-2 border-t px-3 text-muted-foreground text-xs">
      <span
        aria-label={`SSE ${sseStatus}`}
        className={`inline-block size-2 rounded-full ${SSE_DOT_CLASSES[sseStatus]}`}
      />
      <span>{SSE_LABELS[sseStatus]}</span>
      <span className="max-w-1/2 truncate">{playing}</span>
      <span>·</span>
      <span>{PLAY_MODE_LABELS[playMode]}</span>
      <div className="flex-1" />
      <SyncBadge />
      <span>·</span>
      <span>共 {total} 首</span>
    </footer>
  );
}
