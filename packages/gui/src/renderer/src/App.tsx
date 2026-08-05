import { useEffect } from 'react';
import { Toaster } from './components/ui/sonner.js';
import { EventsSubscriber } from './session/EventsSubscriber';
import { useConfig } from './stores/config.js';
import { useSession } from './stores/session.js';
import { applyFontSizes } from './theme/theme.js';

const SSE_LABELS = { connecting: '连接中…', online: '在线', offline: '离线' } as const;

/**
 * T2 shell: session wiring, theme/font plumbing and a visible connection
 * state. T3/T4/T5 replace the placeholder with the Go-parity seven-segment
 * layout (TopBar / InteractionBar / SongList / ProgressBar / Controls /
 * LyricsDisplay / StatusBar).
 */
export function App(): React.JSX.Element {
  const sseStatus = useSession((s) => s.sseStatus);
  const font = useConfig((s) => s.config?.font);
  const refreshConfig = useConfig((s) => s.refresh);

  // Initial config fetch; later refreshes ride the hello epoch (M4-8).
  useEffect(() => {
    refreshConfig();
  }, [refreshConfig]);

  // Font sizes are DOM-level variables (body scope), not React state — the
  // one legitimate "sync with an external system" job (M4-12).
  useEffect(() => {
    if (font) applyFontSizes(font.global_font_size, font.lyrics_font_size);
  }, [font]);

  return (
    <div className="flex h-full flex-col">
      <EventsSubscriber />
      <main className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <h1 className="font-semibold text-2xl">lark</h1>
          <p className="text-muted-foreground text-sm">M4 基座 — 曲库与播放器视图在 T3/T4 落地</p>
        </div>
      </main>
      <footer className="flex h-7 items-center gap-2 border-t px-3 text-muted-foreground text-xs">
        <span
          aria-label={`SSE ${sseStatus}`}
          className={`inline-block size-2 rounded-full ${
            sseStatus === 'online'
              ? 'bg-emerald-500'
              : sseStatus === 'offline'
                ? 'bg-red-500'
                : 'bg-amber-400'
          }`}
        />
        <span>{SSE_LABELS[sseStatus]}</span>
      </footer>
      <Toaster />
    </div>
  );
}
