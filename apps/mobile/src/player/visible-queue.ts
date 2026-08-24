// The list that is on screen right now, for a play that starts later (N4g-1).
//
// ONE READER, ONE WRITER, AND A REASON. Every play the phone has done until
// now took its queue in the same turn as the tap (`queueFrom(source, songs)`),
// so the list was simply there. An ensure-file play is the first that starts
// up to a minute after the tap — and §2.9 says its queue is the one in front
// of you WHEN IT STARTS, not the one you tapped in. A closure over the tapped
// screen's array cannot answer that: tabs are unmounted when you leave them
// (`shell.tsx`), so what it holds is a list that stopped existing.
//
// So a screen showing a list publishes how to build its queue, and replaces
// that as its list changes (a sort, a search, a write). What is stored is a
// THUNK rather than a queue: building one is a map over every row, and doing
// it on every keystroke to answer a question nobody may ask is work for
// nothing.
//
// Not a store, and deliberately not `useSyncExternalStore`: nothing RENDERS
// from this. One caller reads it, once, at the moment a delayed play starts.

import { useEffect } from 'react';
import type { PlayQueue } from './queue';

let build: (() => PlayQueue) | null = null;

/**
 * Say what this screen's queue would be. Returns the retraction.
 *
 * The retraction only clears what it published: React mounts the next screen
 * before unmounting the previous one, so an unconditional clear on unmount
 * would erase a live publication with a dead screen's teardown.
 *
 * Not exported: the hook below is how a screen says this, and a second way in
 * would be a second lifetime to get right.
 */
function publishVisibleQueue(next: () => PlayQueue): () => void {
  build = next;
  return () => {
    if (build === next) build = null;
  };
}

/** The list on screen, or `null` when what is on screen is not a list. */
export function visibleQueue(): PlayQueue | null {
  return build === null ? null : build();
}

/**
 * `build` must be stable — a `useCallback` over whatever the list derives from.
 * A new function every render would republish every render, which is harmless
 * and pointless.
 */
export function useVisibleQueue(build: () => PlayQueue): void {
  useEffect(() => publishVisibleQueue(build), [build]);
}
