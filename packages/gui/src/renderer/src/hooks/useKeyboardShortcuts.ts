// Global playback shortcuts (D14): space toggles, ←/→ seek ±5s, ↑/↓ change
// track.
//
// Two deliberate fixes to the Go behaviour: Tab is NOT swallowed (it blocked
// keyboard navigation everywhere, including inside text fields), and the
// "am I typing?" check runs BEFORE the key switch instead of after the Tab
// branch — typing a space in the search box must not pause the music.

import { useEffect } from 'react';
import { SEEK_STEP_SECONDS, usePlayer } from '../stores/player.js';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true
  );
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      const player = usePlayer.getState();

      switch (event.key) {
        case ' ':
          event.preventDefault();
          void player.togglePlay();
          return;
        case 'ArrowLeft':
          event.preventDefault();
          void player.seekBy(-SEEK_STEP_SECONDS);
          return;
        case 'ArrowRight':
          event.preventDefault();
          void player.seekBy(SEEK_STEP_SECONDS);
          return;
        case 'ArrowUp':
          event.preventDefault();
          void player.prev();
          return;
        case 'ArrowDown':
          event.preventDefault();
          void player.next();
          return;
        default:
          return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
