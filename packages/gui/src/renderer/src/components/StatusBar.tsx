// Bottom strip (D24): Go's "playing · mode · total" plus a connection dot,
// since a lark GUI can now be online or offline against its daemon. T4 fills
// in the playing half.

import { useLibrary } from '../stores/library.js';
import { useSession } from '../stores/session.js';

const SSE_LABELS = { connecting: '连接中…', online: '在线', offline: '离线' } as const;

const SSE_DOT_CLASSES = {
  connecting: 'bg-amber-400',
  online: 'bg-emerald-500',
  offline: 'bg-red-500',
} as const;

export function StatusBar(): React.JSX.Element {
  const sseStatus = useSession((s) => s.sseStatus);
  const total = useLibrary((s) => s.songs.length);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-2 border-t px-3 text-muted-foreground text-xs">
      <span
        aria-label={`SSE ${sseStatus}`}
        className={`inline-block size-2 rounded-full ${SSE_DOT_CLASSES[sseStatus]}`}
      />
      <span>{SSE_LABELS[sseStatus]}</span>
      <div className="flex-1" />
      <span>共 {total} 首</span>
    </footer>
  );
}
