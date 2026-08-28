// The main window's end of the floating lyric window (⑤).
//
// Renders nothing. It publishes what that window should draw, and applies
// what that window asks for: it has no daemon of its own, so every control on
// it — and its own position — comes back here as a patch.

import { useEffect } from 'react';
import { toast } from 'sonner';
import type { DesktopLyricsChange } from '../../../shared/desktop-lyrics.js';
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
      getPlatform().onDesktopLyricsChange((change: DesktopLyricsChange) => {
        const config = useConfig.getState().config;
        if (config === null) return;
        const next = { ...config.desktop_lyrics, ...change };
        // ADOPTED FIRST, then written. The publisher fires on every line, and
        // until the store agrees it would keep publishing the old answer —
        // which reopens a window somebody just closed, or snaps a window
        // being dragged back to where it started.
        adopt({ ...config, desktop_lyrics: next });
        void patch({ desktop_lyrics: change }).catch((err: unknown) => {
          // The optimistic adopt was a guess; the daemon's answer is the fact.
          toast.error(`桌面歌词没能保存：${errorMessage(err)}`);
          refresh();
        });
      }),
    [patch, adopt, refresh],
  );

  return null;
}
