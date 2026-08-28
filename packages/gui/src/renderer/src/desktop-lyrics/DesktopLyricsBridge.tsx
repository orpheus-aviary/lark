// The main window's end of the floating lyric window (⑤).
//
// Renders nothing. It publishes what that window should draw, and hears the
// one thing it can say back: it was closed.

import { useEffect } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { getPlatform } from '../platform/index.js';
import { useConfig } from '../stores/config.js';
import { useDesktopLyricsPublisher } from './publish.js';

export function DesktopLyricsBridge(): null {
  useDesktopLyricsPublisher();
  const patch = useConfig((s) => s.patch);
  const adopt = useConfig((s) => s.adopt);
  const refresh = useConfig((s) => s.refresh);

  useEffect(
    () =>
      getPlatform().onDesktopLyricsClosed(() => {
        const config = useConfig.getState().config;
        if (config === null || !config.desktop_lyrics.enabled) return;
        // ADOPTED FIRST, then written. The publisher's effect fires on every
        // line, and until the config says otherwise it would keep publishing
        // `enabled: true` — which reopens the window somebody just closed,
        // in the gap before the PATCH comes back.
        adopt({
          ...config,
          desktop_lyrics: { ...config.desktop_lyrics, enabled: false },
        });
        void patch({ desktop_lyrics: { enabled: false } }).catch((err: unknown) => {
          // The optimistic adopt was a guess; the daemon's answer is the fact.
          toast.error(`关不掉桌面歌词：${errorMessage(err)}`);
          refresh();
        });
      }),
    [patch, adopt, refresh],
  );

  return null;
}
