// Criterion 20 (N2g). Every case here has a mutation recorded in PROCESS.md:
// delete the guard it names and this file goes red. A test that cannot be made
// to fail is not evidence — it is a green light with nothing behind it.

import { describe, expect, it } from 'vitest';
import { parseLrc } from './lrc.js';
import {
  NOW_PLAYING_TITLE_MAX_CODE_POINTS,
  type NowPlayingMode,
  isNowPlayingMode,
  nowPlayingTitle,
} from './now-playing.js';

const SONG = '晴天';
const LYRICS = parseLrc(
  ['[00:00.00]故事的小黄花', '[00:05.00]', '[00:10.00]从出生那年就飘着'].join('\n'),
);

function title(over: {
  mode?: NowPlayingMode;
  songName?: string;
  lyrics?: ReturnType<typeof parseLrc>;
  timeSeconds?: number;
  offsetSeconds?: number;
}): string {
  return nowPlayingTitle({
    songName: over.songName ?? SONG,
    lyrics: over.lyrics ?? LYRICS,
    timeSeconds: over.timeSeconds ?? 0,
    offsetSeconds: over.offsetSeconds ?? 0,
    mode: over.mode ?? 'lyrics',
  });
}

describe('the mode value', () => {
  it('accepts the two known modes and nothing else', () => {
    expect(isNowPlayingMode('title')).toBe(true);
    expect(isNowPlayingMode('lyrics')).toBe(true);
    for (const junk of ['', 'TITLE', 'lyric', ' lyrics', null, undefined, 0, {}]) {
      expect(isNowPlayingMode(junk)).toBe(false);
    }
  });
});

describe('the current line, when there is one', () => {
  it('publishes the line the player is on', () => {
    expect(title({ timeSeconds: 0 })).toBe('故事的小黄花');
    expect(title({ timeSeconds: 12 })).toBe('从出生那年就飘着');
  });

  it('reads the offset the same way the lyrics pane does', () => {
    // Without the offset, 9.5s is still the interlude line; +1s moves it past
    // the 10.00 tag. Same unit, same sign as `song.lyrics_offset`.
    expect(title({ timeSeconds: 9.5, offsetSeconds: 1 })).toBe('从出生那年就飘着');
  });
});

describe('the four fallbacks, all of which return the song name', () => {
  it('① mode `title`: the song name, even mid-line', () => {
    expect(title({ mode: 'title', timeSeconds: 12 })).toBe(SONG);
  });

  it('② no timed lyrics at all', () => {
    expect(title({ lyrics: [], timeSeconds: 12 })).toBe(SONG);
    // Plain prose parses to the same empty list — the function cannot tell
    // "no file" from "a file with no timestamps", and does not pretend to.
    expect(title({ lyrics: parseLrc('just some prose\nno tags here'), timeSeconds: 12 })).toBe(
      SONG,
    );
  });

  it('③ before the first line', () => {
    expect(title({ timeSeconds: -1 })).toBe(SONG);
    expect(title({ timeSeconds: 0, offsetSeconds: -5 })).toBe(SONG);
  });

  it('④ an interlude: the current line is a timed blank', () => {
    expect(title({ timeSeconds: 7 })).toBe(SONG);
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('the length cap', () => {
  const long = 'あ'.repeat(NOW_PLAYING_TITLE_MAX_CODE_POINTS + 6);

  it('clamps a long lyric line', () => {
    const lyrics = parseLrc(`[00:00.00]${long}`);
    expect([...title({ lyrics, timeSeconds: 1 })]).toHaveLength(NOW_PLAYING_TITLE_MAX_CODE_POINTS);
  });

  it('clamps the song name too — a fallback is not an escape hatch', () => {
    expect([...title({ mode: 'title', songName: long })]).toHaveLength(
      NOW_PLAYING_TITLE_MAX_CODE_POINTS,
    );
  });

  it('leaves anything within the cap byte-for-byte alone', () => {
    const exact = 'あ'.repeat(NOW_PLAYING_TITLE_MAX_CODE_POINTS);
    expect(title({ mode: 'title', songName: exact })).toBe(exact);
  });

  it('counts code points, so an emoji is never cut in half', () => {
    // Each emoji is one code point and TWO UTF-16 units. The one-char prefix
    // is load bearing: it makes the naive `slice(0, 64)` land on an ODD unit
    // boundary, i.e. mid-pair — without it the cut falls between pairs and a
    // UTF-16 truncation looks fine.
    const mixed = `あ${'🎵'.repeat(NOW_PLAYING_TITLE_MAX_CODE_POINTS + 6)}`;
    const clamped = title({ mode: 'title', songName: mixed });

    // The failure this guards against, stated as itself and asserted FIRST:
    // a length assertion would fire before it and hide which of the two broke.
    expect(LONE_SURROGATE.test(clamped)).toBe(false);
    expect([...clamped]).toHaveLength(NOW_PLAYING_TITLE_MAX_CODE_POINTS);
    expect(clamped).toBe(`あ${'🎵'.repeat(NOW_PLAYING_TITLE_MAX_CODE_POINTS - 1)}`);
  });
});
