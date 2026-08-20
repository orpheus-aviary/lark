// The app's one player (N3a).
//
// A MODULE SINGLETON, deliberately, for the same reason `bootOnce` is one: an
// Activity that Android destroyed and rebuilt remounts every component, and a
// player built per mount would be a second native audio session over the same
// speaker — two AudioTracks, two lock screen sessions, and only one of them
// reachable from the JS that remounted. The library made this mistake once
// already (N2f: `prepareSync … NullPointerException` after a BACK), and the
// fix there was the same shape.
//
// The factory stays exported from `./store` with every dependency injected, so
// the race model is tested on a laptop against a fake driver.

import type { PlayMode, SongData } from '@lark/shared';
import { useSyncExternalStore } from 'react';
import { onLibraryChanged } from '../library-signal';
import { createPaths } from '../ports/paths';
import { createPlayerDriver } from './driver';
import type { PlayQueue } from './queue';
import { ensureAudioSession } from './session';
import { type PlaybackState, createPlayerStore } from './store';

const paths = createPaths();

/**
 * The half of the player that only exists after the library is open.
 *
 * The store is built at import time — it has to be, so an Activity rebuild
 * cannot produce a second one — but three of its dependencies need a database
 * that the boot sequence has not opened yet. They arrive through here instead
 * of being invented as constructor arguments nobody could supply.
 */
export interface PlayerBinding {
  resolveQueue: (queue: PlayQueue) => readonly SongData[];
  readLyrics: (songId: string) => Promise<string | null>;
  readMode: () => PlayMode;
  persistMode: (mode: PlayMode) => void;
}

let binding: PlayerBinding | null = null;

const required = (): PlayerBinding => {
  if (binding === null) throw new Error('the player was used before the library was open');
  return binding;
};

export const player = createPlayerStore({
  createDriver: createPlayerDriver,
  audioUri: (songId) => paths.songAudio(songId),
  ensureSession: ensureAudioSession,
  resolveQueue: (queue) => required().resolveQueue(queue),
  readLyrics: (songId) => required().readLyrics(songId),
  persistMode: (mode) => required().persistMode(mode),
  onLibraryChanged,
});

/** Called once, by the boot path, with the library it just opened. */
export function bindPlayer(next: PlayerBinding): void {
  binding = next;
  player.hydrate(next.readMode());
}

/**
 * Subscribe to one slice of playback state.
 *
 * The selector MUST return a primitive or a stable reference: this is
 * `useSyncExternalStore` without a memo layer, so a selector that builds a new
 * object every call would tell React the store changed on every render. That
 * constraint is the whole reason there is no zustand here — what the four
 * consumers (the row, the minibar, the full screen, the queue sheet) need is a
 * subscription with a selector, and this is a subscription with a selector.
 */
export function usePlayback<T>(select: (state: PlaybackState) => T): T {
  return useSyncExternalStore(player.subscribe, () => select(player.getState()));
}
