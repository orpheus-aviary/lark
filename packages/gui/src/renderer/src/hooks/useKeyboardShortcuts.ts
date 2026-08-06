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

/**
 * A dialog owns the keyboard while it is open (M5-1). Space on a button inside
 * the settings page would otherwise press the button AND toggle playback, and
 * the arrow keys would change track behind it. Queried from the DOM rather
 * than tracked in a store: radix renders into a portal, and every dialog in
 * the app carries this slot.
 */
function dialogOpen(): boolean {
  return document.querySelector('[data-slot="dialog-content"][data-state="open"]') !== null;
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || dialogOpen()) return;
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
