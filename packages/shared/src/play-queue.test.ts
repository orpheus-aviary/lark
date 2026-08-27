// Criterion 6 (N3b gate). Every cell of the plan's §2.4 matrix, plus the two
// rules that run across all four modes.
//
// `random` is injected, so `shuffle` is a decision and not a coin toss. A test
// that ran the real one would be a test that passes most of the time, which is
// the kind that gets re-run until it does.

import { describe, expect, it } from 'vitest';
import { type QueueTrigger, decideNext, nextPlayMode } from './play-queue.js';
import type { PlayMode, SongData } from './types.js';

function song(id: string, over: Partial<SongData> = {}): SongData {
  return {
    id,
    name: id,
    artist: '',
    source_url: null,
    source_provider: null,
    source_key: null,
    file_origin: 'downloaded',
    lyrics_offset: 0,
    duration: 100,
    pinned: false,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const QUEUE = [song('a'), song('b'), song('c')];

/** Deterministic pick: always the first candidate the pool offers. */
const first = () => 0;
/** Deterministic pick: always the last. `0.999` survives any pool size. */
const last = () => 0.999;

const decide = (
  trigger: QueueTrigger,
  mode: PlayMode,
  currentId: string | null,
  over: {
    songs?: readonly SongData[];
    random?: () => number;
    /** Rule 3's setting. `false` is what every criterion below N4g asserted. */
    fetchWhenEnded?: boolean;
  } = {},
) =>
  decideNext({
    songs: over.songs ?? QUEUE,
    currentId,
    mode,
    trigger,
    fetchWhenEnded: over.fetchWhenEnded ?? false,
    random: over.random ?? first,
  });

describe('a song that ended', () => {
  it('sequential: the end of the list is the end of playback', () => {
    expect(decide('ended', 'sequential', 'a')).toEqual({ kind: 'play', songId: 'b' });
    expect(decide('ended', 'sequential', 'c')).toEqual({ kind: 'stop', reason: 'end-of-list' });
  });

  it('repeat-all: the end of the list is the start of it', () => {
    expect(decide('ended', 'repeat-all', 'c')).toEqual({ kind: 'play', songId: 'a' });
  });

  it('repeat-one: the same song again', () => {
    expect(decide('ended', 'repeat-one', 'b')).toEqual({ kind: 'restart' });
    // Before every other question, including whether it is in the queue.
    expect(decide('ended', 'repeat-one', 'gone')).toEqual({ kind: 'restart' });
    expect(decide('ended', 'repeat-one', 'a', { songs: [] })).toEqual({ kind: 'restart' });
  });

  it('shuffle: another song, never this one, and it stops when there is none', () => {
    expect(decide('ended', 'shuffle', 'a', { random: first })).toEqual({
      kind: 'play',
      songId: 'b',
    });
    expect(decide('ended', 'shuffle', 'a', { random: last })).toEqual({
      kind: 'play',
      songId: 'c',
    });
    // The pool excludes the current song, so a one-song queue has nowhere left.
    expect(decide('ended', 'shuffle', 'a', { songs: [song('a')] })).toEqual({
      kind: 'stop',
      reason: 'no-playable',
    });
  });
});

describe('the next button', () => {
  it('wraps in every mode — a press is an intent, running out is not', () => {
    for (const mode of ['sequential', 'repeat-all', 'repeat-one'] as const) {
      expect(decide('next', mode, 'c')).toEqual({ kind: 'play', songId: 'a' });
    }
  });

  it('shuffle: another song, and it says so when there is none', () => {
    expect(decide('next', 'shuffle', 'b', { random: first })).toEqual({
      kind: 'play',
      songId: 'a',
    });
    expect(decide('next', 'shuffle', 'a', { songs: [song('a')] })).toEqual({
      kind: 'reject',
      reason: 'no-other-playable',
    });
  });
});

describe('the previous button', () => {
  it('is the one before, in every mode — including shuffle', () => {
    for (const mode of ['sequential', 'repeat-all', 'repeat-one', 'shuffle'] as const) {
      expect(decide('prev', mode, 'b')).toEqual({ kind: 'play', songId: 'a' });
      expect(decide('prev', mode, 'a')).toEqual({ kind: 'play', songId: 'c' });
    }
  });
});

describe('the current song is not in the queue (D11)', () => {
  const cases: readonly (readonly [QueueTrigger, PlayMode])[] = [
    ['ended', 'sequential'],
    ['ended', 'repeat-all'],
    ['ended', 'shuffle'],
    ['next', 'sequential'],
    ['next', 'repeat-all'],
    ['next', 'repeat-one'],
    ['next', 'shuffle'],
    ['prev', 'sequential'],
    ['prev', 'shuffle'],
  ];

  for (const [trigger, mode] of cases) {
    it(`${trigger} · ${mode}: goes nowhere rather than somewhere arbitrary`, () => {
      const decision = decide(trigger, mode, 'not-here');
      // A song that ended just stops; a button owes an answer (decision n).
      expect(decision).toEqual(
        trigger === 'ended'
          ? { kind: 'stop', reason: 'not-in-queue' }
          : { kind: 'reject', reason: 'not-in-queue' },
      );
    });
  }

  it('an empty queue is the same case', () => {
    expect(decide('next', 'sequential', 'a', { songs: [] })).toEqual({
      kind: 'reject',
      reason: 'not-in-queue',
    });
  });

  it('nothing is playing at all', () => {
    expect(decide('next', 'sequential', null)).toEqual({
      kind: 'reject',
      reason: 'not-in-queue',
    });
  });
});

describe('the neighbour has no file (rule 3, rewritten in N4g-3)', () => {
  const gapped = [song('a'), song('b', { has_file: false }), song('c')];

  it('a song that ended skips it — nobody`s finger is on this, so nobody`s data', () => {
    expect(
      decideNext({
        songs: gapped,
        currentId: 'a',
        mode: 'sequential',
        trigger: 'ended',
        fetchWhenEnded: false,
      }),
    ).toEqual({ kind: 'play', songId: 'c' });
  });

  it('a button takes it and lets the host fetch it', () => {
    // The whole point of the rewrite: tapping the row would have fetched it,
    // so pressing 下一首 onto the same row must not refuse.
    expect(
      decideNext({
        songs: gapped,
        currentId: 'a',
        mode: 'repeat-all',
        trigger: 'next',
        fetchWhenEnded: false,
      }),
    ).toEqual({ kind: 'play', songId: 'b' });
    expect(
      decideNext({
        songs: gapped,
        currentId: 'c',
        mode: 'sequential',
        trigger: 'prev',
        fetchWhenEnded: false,
      }),
    ).toEqual({ kind: 'play', songId: 'b' });
  });

  it('a song that ended stops only when nothing ahead has a file', () => {
    const none = [song('a'), song('b', { has_file: false }), song('c', { has_file: false })];
    expect(
      decideNext({
        songs: none,
        currentId: 'a',
        mode: 'sequential',
        trigger: 'ended',
        fetchWhenEnded: false,
      }),
    ).toEqual({ kind: 'stop', reason: 'no-playable' });
    // repeat-all walks all the way round, and the last candidate it considers
    // is the song that just ended — a list loop with one playable song in it.
    expect(
      decideNext({
        songs: none,
        currentId: 'a',
        mode: 'repeat-all',
        trigger: 'ended',
        fetchWhenEnded: false,
      }),
    ).toEqual({ kind: 'play', songId: 'a' });
  });

  it('skipping still respects rule 1: sequential does not wrap to find one', () => {
    const tail = [song('a'), song('b'), song('c', { has_file: false })];
    expect(
      decideNext({
        songs: tail,
        currentId: 'b',
        mode: 'sequential',
        trigger: 'ended',
        fetchWhenEnded: false,
      }),
    ).toEqual({ kind: 'stop', reason: 'no-playable' });
    expect(
      decideNext({
        songs: tail,
        currentId: 'b',
        mode: 'repeat-all',
        trigger: 'ended',
        fetchWhenEnded: false,
      }),
    ).toEqual({ kind: 'play', songId: 'a' });
  });

  it('takes it instead of skipping, when the setting says a list may spend data', () => {
    // 🔴 0.1.1 ⑥. The SAME queue and the SAME song running out, decided two
    // ways by one boolean — which is the whole reason the flag is a required
    // input rather than an option with a default. Skipping plays a list in the
    // order it happened to be downloaded; taking it plays the list.
    expect(
      decideNext({
        songs: gapped,
        currentId: 'a',
        mode: 'sequential',
        trigger: 'ended',
        fetchWhenEnded: true,
      }),
    ).toEqual({ kind: 'play', songId: 'b' });
  });

  it('with the setting on, a list of songs with no files still plays', () => {
    // Off, this stops dead: nothing ahead has a file. On, the first neighbour
    // wins and the host fetches it.
    const none = [song('a'), song('b', { has_file: false }), song('c', { has_file: false })];
    expect(
      decideNext({
        songs: none,
        currentId: 'a',
        mode: 'sequential',
        trigger: 'ended',
        fetchWhenEnded: true,
      }),
    ).toEqual({ kind: 'play', songId: 'b' });
  });

  it('the setting reaches shuffle too — otherwise one mode would spend data and another would not', () => {
    const none = [song('a'), song('b', { has_file: false }), song('c', { has_file: false })];
    expect(
      decideNext({
        songs: none,
        currentId: 'a',
        mode: 'shuffle',
        trigger: 'ended',
        fetchWhenEnded: true,
        random: first,
      }),
    ).toEqual({ kind: 'play', songId: 'b' });
    expect(
      decideNext({
        songs: none,
        currentId: 'a',
        mode: 'shuffle',
        trigger: 'ended',
        fetchWhenEnded: false,
        random: first,
      }),
    ).toEqual({ kind: 'stop', reason: 'no-playable' });
  });

  it('leaves rule 1 alone: sequential still ends at the end of the list', () => {
    // The setting is about "may it spend data", not about where a list stops.
    expect(
      decideNext({
        songs: gapped,
        currentId: 'c',
        mode: 'sequential',
        trigger: 'ended',
        fetchWhenEnded: true,
      }),
    ).toEqual({ kind: 'stop', reason: 'end-of-list' });
  });

  it('shuffle follows the same split: a press may land on one, an ending may not', () => {
    expect(
      decideNext({
        songs: gapped,
        currentId: 'a',
        mode: 'shuffle',
        trigger: 'ended',
        fetchWhenEnded: false,
        random: first,
      }),
    ).toEqual({ kind: 'play', songId: 'c' });
    // `first` picks pool[0], which for a press includes the file-less `b`.
    expect(
      decideNext({
        songs: gapped,
        currentId: 'a',
        mode: 'shuffle',
        trigger: 'next',
        fetchWhenEnded: false,
        random: first,
      }),
    ).toEqual({ kind: 'play', songId: 'b' });
  });

  it('`has_file` absent means playable — only an explicit false is a gap', () => {
    const unknown = [song('a'), song('b')];
    expect(unknown[1]?.has_file).toBeUndefined();
    expect(
      decideNext({
        songs: unknown,
        currentId: 'a',
        mode: 'sequential',
        trigger: 'ended',
        fetchWhenEnded: false,
      }),
    ).toEqual({ kind: 'play', songId: 'b' });
  });
});

describe('the mode button', () => {
  it('walks the UI cycle, which is not the wire order', () => {
    expect(nextPlayMode('sequential')).toBe('repeat-all');
    expect(nextPlayMode('repeat-all')).toBe('repeat-one');
    expect(nextPlayMode('repeat-one')).toBe('shuffle');
    expect(nextPlayMode('shuffle')).toBe('sequential');
  });
});
