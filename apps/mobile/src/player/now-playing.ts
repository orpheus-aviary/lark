// The one string a car stereo shows, kept up to date (N3d, §2.5).
//
// AVRCP has no lyrics field, so the whole feature is: put the current lyric
// line where the song name normally goes. `nowPlayingTitle` in `@lark/shared`
// decides WHAT that string is (N2g); this file decides WHEN it gets handed to
// the system, which is a different question with its own failure mode —
// AVRCP and A2DP share one ACL link, so metadata written twice a second is
// metadata competing with the audio.
//
// TWO GUARDS, AND THEY ARE NOT THE SAME ONE:
//
//   1. **De-duplicate on the RETURN VALUE.** The status stream ticks every
//      500ms; a lyric line lasts several seconds, and an interlude returns the
//      song name for as long as it lasts. Publishing on every tick would be
//      ten writes for one visible change.
//   2. **Throttle to `NOW_PLAYING_MIN_INTERVAL_MS`.** De-duplication alone
//      leaves a burst when two lines are half a second apart. A dropped
//      publish is not lost — the next tick recomputes the CURRENT line and
//      sends that, which is the one worth showing anyway.
//
// The counters exist because criterion 17 has to be checkable on the device:
// the host computes how many publishes a song's lyrics should produce, and
// this is the number it gets compared against. They are per song — the window
// closes when the next song opens one.

import type { NowPlayingMode } from '@lark/shared';
import { nowPlayingTitle } from '@lark/shared';
import type { AudioMetadata } from 'expo-audio';
import type { PlaybackState } from './store';

/** §2.5. Also the status interval, so in practice this rarely bites. */
const NOW_PLAYING_MIN_INTERVAL_MS = 500;

export interface NowPlayingDeps {
  subscribe(listener: () => void): () => void;
  getState(): PlaybackState;
  /** Hand metadata to the live source. A no-op when there is none. */
  publish(meta: AudioMetadata): void;
  /** `local_metadata.now_playing_mode` (N2g). */
  readMode(): NowPlayingMode;
  writeMode(mode: NowPlayingMode): void;
  now(): number;
}

export interface NowPlayingStats {
  /** Publishes since the current song (or the current mode) started. */
  published: number;
  /** The smallest gap between two of them; null until there are two. */
  minGapMs: number | null;
}

export interface NowPlayingBridge {
  mode(): NowPlayingMode;
  /** Persist the mode and make the change visible immediately (criterion 16). */
  setMode(mode: NowPlayingMode): void;
  stats(): NowPlayingStats;
  /** Tests only — the real one lives as long as the process. */
  stop(): void;
}

export function createNowPlayingBridge(deps: NowPlayingDeps): NowPlayingBridge {
  // Read at three moments and no others (§2.5): the first time anything asks,
  // when a song starts, and when the switch moves. Never per tick — that would
  // be a database read twice a second for a value only a settings screen can
  // change. Not at construction either: this module is imported before the
  // boot sequence has opened the library the value lives in.
  let mode: NowPlayingMode | null = null;
  const currentMode = (): NowPlayingMode => {
    if (mode === null) mode = deps.readMode();
    return mode;
  };

  let songId: string | null = null;
  /** What the system is showing, as far as we know. */
  let showing: string | null = null;
  let showingAt = 0;
  let published = 0;
  let minGapMs: number | null = null;

  const send = (state: PlaybackState, force: boolean): void => {
    const song = state.song;
    if (song === null) return;
    const title = nowPlayingTitle({
      songName: song.name,
      lyrics: state.lyrics,
      timeSeconds: state.currentTime,
      offsetSeconds: song.lyrics_offset,
      mode: currentMode(),
    });
    if (title === showing) return;

    const at = deps.now();
    const gap = at - showingAt;
    if (!force && gap < NOW_PLAYING_MIN_INTERVAL_MS) return;

    // The song name goes to the album slot whenever the title slot is holding
    // something else, which is the only way it survives with lyrics on. An
    // interlude, or lyrics off, puts it back in the title and leaves the album
    // empty — `MetadataInjectingPlayer.getMediaMetadata` rebuilds all four
    // fields from what it is given, so omitting one clears it.
    deps.publish(
      title === song.name
        ? { title, artist: song.artist }
        : { title, artist: song.artist, albumTitle: song.name },
    );
    // Only between two publishes. The first one's gap is measured from the
    // start of the song, which is not an interval between writes.
    if (published > 0) minGapMs = minGapMs === null ? gap : Math.min(minGapMs, gap);
    published += 1;
    showing = title;
    showingAt = at;
  };

  const onChange = (): void => {
    const state = deps.getState();
    const song = state.song;
    if (song === null) {
      songId = null;
      showing = null;
      return;
    }
    if (song.id !== songId) {
      songId = song.id;
      mode = deps.readMode();
      // Not a guess: `driver.load` calls `setActiveForLockScreen` with the
      // song name, so that IS what the system has for this source. Starting
      // from null instead would publish the song name once per song for
      // nothing.
      showing = song.name;
      showingAt = deps.now();
      published = 0;
      minGapMs = null;
    }
    send(state, false);
  };

  const unsubscribe = deps.subscribe(onChange);

  return {
    mode: currentMode,

    setMode(next) {
      deps.writeMode(next);
      // Re-read rather than trusting the write: the library is the setting,
      // and a value it refuses to store is a value this bridge must not act
      // on either (`readNowPlayingMode` reads an unknown value as the default).
      mode = deps.readMode();
      // A new window: the sequence of outputs just changed, so a count that
      // spanned both modes would answer no question.
      published = 0;
      minGapMs = null;
      showingAt = deps.now();
      // Forced past the throttle. A paused player has no ticks at all, so a
      // throttled flip would be a switch that appears not to work; and one
      // write at the moment of a deliberate tap is not the churn the throttle
      // is there to prevent.
      send(deps.getState(), true);
    },

    stats: () => ({ published, minGapMs }),

    stop: unsubscribe,
  };
}
