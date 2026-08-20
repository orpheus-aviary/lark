// What a Bluetooth car stereo shows while lark plays (N2g, decision g).
//
// AVRCP has no lyrics field. Every implementation that puts lyrics on a car
// head unit does the same thing: it writes the CURRENT LYRIC LINE into the
// TITLE metadata, and writes the song name there when the feature is off. So
// this is not a Bluetooth function at all — it is one string decision, and it
// belongs in `@lark/shared` because it touches no database and `LrcLine`
// already lives here.
//
// The wiring is N3's: the mobile player calls expo-audio's
// `updateLockScreenMetadata` with whatever this returns. Two things that are
// NOT this function's job travel with that call and are written down here so
// they do not get re-derived: throttle on the RETURN VALUE changing rather
// than on a timer (AVRCP and A2DP share one ACL link), and de-duplicate on our
// side rather than trusting the player's own forwarding layer.
//
// ANDROID ONLY, and off by default: there is no display-capable Bluetooth
// receiver on hand to measure against, so the feature ships dark (decision c).

import { type LrcLine, currentLrcIndex } from './lrc.js';

/** `title` = the song name, always. `lyrics` = the current line. */
export type NowPlayingMode = 'title' | 'lyrics';

export const NOW_PLAYING_MODES: readonly NowPlayingMode[] = ['title', 'lyrics'];

export function isNowPlayingMode(value: unknown): value is NowPlayingMode {
  return value === 'title' || value === 'lyrics';
}

/**
 * Upper bound on what we hand the system, in Unicode code points.
 *
 * The number has NO measurement behind it — no head unit was available to find
 * the real limit (decision h). It is a guard against handing a stereo a
 * pathological string, not a contract; treat it as adjustable.
 */
export const NOW_PLAYING_TITLE_MAX_CODE_POINTS = 64;

/**
 * Truncate by code point, never by UTF-16 unit: `slice` splits a surrogate
 * pair and emits half an emoji, which is the one way a length cap can corrupt
 * rather than shorten.
 */
function clampTitle(text: string): string {
  const points = [...text];
  if (points.length <= NOW_PLAYING_TITLE_MAX_CODE_POINTS) return text;
  return points.slice(0, NOW_PLAYING_TITLE_MAX_CODE_POINTS).join('');
}

export interface NowPlayingTitleInput {
  songName: string;
  lyrics: readonly LrcLine[];
  timeSeconds: number;
  /** Same unit and sign as `song.lyrics_offset` and `currentLrcIndex`. */
  offsetSeconds: number;
  mode: NowPlayingMode;
}

/**
 * The string to publish as Now Playing TITLE.
 *
 * Every fallback returns the SONG NAME, never an empty string: a stereo
 * showing nothing looks broken, while a stereo showing the song name looks
 * like a stereo with the feature off.
 */
export function nowPlayingTitle(input: NowPlayingTitleInput): string {
  const { songName, lyrics, timeSeconds, offsetSeconds, mode } = input;
  if (mode === 'title') return clampTitle(songName);

  // One guard, two fallbacks. "No lyrics at all" and "before the first line"
  // both arrive here as index `-1` — `parseLrc` returns `[]` for a file with
  // no timestamps just as it does for no file, and an empty list can only
  // produce `-1`. Pretending they are two branches would be pretending the
  // function can tell them apart.
  const line: LrcLine | undefined = lyrics[currentLrcIndex(lyrics, timeSeconds, offsetSeconds)];
  // A timed blank is the interlude marker (`lrc.ts`), not a lyric.
  if (line === undefined || line.text === '') return clampTitle(songName);
  return clampTitle(line.text);
}
