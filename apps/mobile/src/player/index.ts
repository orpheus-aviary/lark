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

import type { LastPlayback } from '@lark/core/portable';
import type { NowPlayingMode, PlayMode, SongData } from '@lark/shared';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import LarkAudio from '../../modules/lark-audio';
import { onLibraryChanged } from '../library-signal';
import { createPaths } from '../ports/paths';
import { createPlayerDriver } from './driver';
import { createNowPlayingBridge } from './now-playing';
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
  /** `local_metadata.now_playing_mode` — the Bluetooth lyrics switch (N3d). */
  readNowPlayingMode: () => NowPlayingMode;
  persistNowPlayingMode: (mode: NowPlayingMode) => void;
  /**
   * What to put back on screen at launch, already checked against the library
   * (N3f). `null` means "remember nothing", which includes every way the
   * remembered position could have gone stale.
   */
  restore: () => { song: SongData; queue: PlayQueue; positionSeconds: number } | null;
  /** `local_metadata.last_playback`. */
  rememberPlayback: (value: LastPlayback) => void;
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
  rememberPlayback: (value) => required().rememberPlayback(value),
  onLibraryChanged,
});

/**
 * The Bluetooth lyrics bridge (N3d).
 *
 * A singleton for the same reason the store is one: it holds ONE subscription
 * to the status stream, and a second one would publish every line twice — at
 * which point the throttle it exists to enforce is being enforced by two
 * bookkeepers who cannot see each other.
 */
export const nowPlaying = createNowPlayingBridge({
  subscribe: player.subscribe,
  getState: player.getState,
  publish: (meta) => player.publishNowPlaying(meta),
  readMode: () => required().readNowPlayingMode(),
  writeMode: (mode) => required().persistNowPlayingMode(mode),
  now: () => Date.now(),
});

/**
 * The headphones coming out (N3e, decision e, criterion 19).
 *
 * Subscribed here, at import, for the same reason the player is a singleton:
 * the broadcast arrives whether or not any screen is mounted, and a listener
 * that lives on a component is a listener that is missing exactly when the
 * Activity has been destroyed and playback is still going.
 *
 * `pause` and not `toggle`: unplugging must never be able to start the music.
 * There is no matching resume when the sink comes back — the user decides
 * that, the same way they do after a phone call.
 */
LarkAudio.addListener('onBecomingNoisy', () => {
  void player.pause();
});

/**
 * One of §2.7's three turning points: the app going away (N3f).
 *
 * `background` only. `inactive` is an iOS state, and on Android the one thing
 * that reliably precedes "this process may not get another word in" is this.
 * It saves the position at THAT moment and nothing later — a screen-off
 * background run keeps playing while JS is throttled, which is why the
 * promise is "where JS last looked".
 */
AppState.addEventListener('change', (next) => {
  if (next === 'background') player.remember();
});

/**
 * Whether this process has already put a remembered position back.
 *
 * `bindPlayer` runs from an effect in `App`, and an Activity that Android
 * destroyed and rebuilt remounts it — `bootOnce` makes the second call cheap
 * but not absent. Restoring twice would take a player that is happily playing
 * and overwrite it with wherever it was when the app launched. Same shape as
 * `bootOnce`, same reason, third place (N2f).
 */
let restored = false;

/** Called once, by the boot path, with the library it just opened. */
export function bindPlayer(next: PlayerBinding): void {
  binding = next;
  player.hydrate(next.readMode());
  if (restored) return;
  restored = true;
  const memory = next.restore();
  if (memory !== null) player.restore(memory.song, memory.queue, memory.positionSeconds);
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
