// The two guards and the switch (N3d, §2.5). Criterion 17's arithmetic is
// checked here; the device only has to reproduce the number.
//
// Time is injected, so nothing here waits for anything.

import type { NowPlayingMode, SongData } from '@lark/shared';
import { parseLrc } from '@lark/shared';
import type { AudioMetadata } from 'expo-audio';
import { beforeEach, describe, expect, it } from 'vitest';
import { type NowPlayingBridge, createNowPlayingBridge } from './now-playing';
import type { PlaybackState } from './store';

const LYRICS = '[00:00.00]\n[00:05.00]一\n[00:10.00]二\n[00:15.00]\n[00:20.00]三\n';

function song(over: Partial<SongData> = {}): SongData {
  return {
    id: 'a',
    name: '歌名',
    artist: '歌手',
    source_url: null,
    source_provider: null,
    source_key: null,
    file_origin: 'downloaded',
    lyrics_offset: 0,
    duration: 30,
    pinned: false,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

/** The real parser: a timed blank stays in, as the interlude marker it is. */
const parsed = parseLrc(LYRICS);

interface Harness {
  bridge: NowPlayingBridge;
  /** Every metadata object handed to the system, oldest first. */
  readonly published: AudioMetadata[];
  /** Move the clock and the playhead, then tick the store as the driver would. */
  tick(seconds: number): void;
  set(patch: Partial<PlaybackState>): void;
  /** Make the library keep whatever it has, whatever it is told. */
  refuseWrites(): void;
  /** Change the stored mode without going through the bridge. */
  store(mode: NowPlayingMode): void;
  /** How many times the library has been asked for the mode. */
  readonly reads: number;
  readonly stored: NowPlayingMode;
}

function harness(initial: Partial<PlaybackState> = {}): Harness {
  const published: AudioMetadata[] = [];
  let stored: NowPlayingMode = 'lyrics';
  let writable = true;
  let reads = 0;
  let clock = 0;
  let state: PlaybackState = {
    song: song(),
    queue: null,
    mode: 'sequential',
    lyrics: parsed,
    loading: false,
    playing: true,
    currentTime: 0,
    duration: 30,
    error: null,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const bridge = createNowPlayingBridge({
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,
    publish: (meta) => void published.push(meta),
    readMode: () => {
      reads += 1;
      return stored;
    },
    writeMode: (mode) => {
      if (writable) stored = mode;
    },
    now: () => clock,
  });

  // The store sets `song` at the START of `play`, before the source is even
  // loaded, so the bridge learns which song this is at time zero — not on the
  // first status tick, which is half a second of playback later.
  notify();

  return {
    bridge,
    published,
    tick(seconds) {
      // The status stream and the clock are the same tick: `currentTime` moves
      // exactly as far as wall time does.
      clock += (seconds - state.currentTime) * 1000;
      state = { ...state, currentTime: seconds };
      notify();
    },
    set(patch) {
      state = { ...state, ...patch };
      notify();
    },
    refuseWrites() {
      writable = false;
    },
    store(mode) {
      stored = mode;
    },
    get stored() {
      return stored;
    },
    get reads() {
      return reads;
    },
  };
}

describe('the Bluetooth lyrics bridge', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('publishes a line once, however many ticks it lasts', () => {
    for (const t of [0.5, 1, 1.5, 2, 2.5]) h.tick(t);
    expect(h.published).toEqual([]); // still before the first line: the song name

    for (const t of [5, 5.5, 6, 6.5, 7, 7.5, 8]) h.tick(t);
    expect(h.published).toEqual([{ title: '一', artist: '歌手', albumTitle: '歌名' }]);
  });

  it('counts the segments of a song, not its ticks or its lines', () => {
    for (let t = 0.5; t <= 30; t += 0.5) h.tick(t);
    // 歌名 → 一 → 二 → 歌名(间奏) → 三. The first is what the lock screen
    // already shows when the source loads, so four writes, not five.
    expect(h.published.map((meta) => meta.title)).toEqual(['一', '二', '歌名', '三']);
    expect(h.bridge.stats().published).toBe(4);
  });

  it('drops a write that would land inside the throttle, and sends the next one', () => {
    // Two lines 300ms apart — the shape a throttle exists for.
    const dense = harness({ lyrics: parseLrc('[00:05.00]一\n[00:05.30]插\n') });
    dense.tick(5);
    expect(dense.published).toHaveLength(1);
    dense.tick(5.3);
    expect(dense.published).toHaveLength(1); // refused, not queued
    dense.tick(5.9);
    expect(dense.published.map((meta) => meta.title)).toEqual(['一', '插']);
  });

  it('puts the song name in the album slot only while the title holds a lyric', () => {
    h.tick(5);
    h.tick(15); // the timed blank: back to the song name, and no album
    expect(h.published).toEqual([
      { title: '一', artist: '歌手', albumTitle: '歌名' },
      { title: '歌名', artist: '歌手' },
    ]);
  });

  it('assumes the loading source already shows the song name', () => {
    // What `driver.load` publishes with `setActiveForLockScreen`. Starting a
    // song at a position before its first line must not write it again.
    h.tick(1);
    h.tick(2);
    expect(h.published).toEqual([]);
  });

  it('opens a new window for the next song', () => {
    h.tick(5);
    expect(h.bridge.stats().published).toBe(1);
    h.set({ song: song({ id: 'b', name: '第二首' }), lyrics: [], currentTime: 0 });
    expect(h.bridge.stats()).toEqual({ published: 0, minGapMs: null });
    // No lyrics at all: `nowPlayingTitle` falls back to the song name, which
    // is what the new source is already showing.
    h.tick(3);
    expect(h.published).toHaveLength(1);
  });

  it('reports the smallest gap between two writes, not the gap from the start', () => {
    h.tick(5); // first write, 5s after the song started
    expect(h.bridge.stats().minGapMs).toBeNull();
    h.tick(10);
    expect(h.bridge.stats().minGapMs).toBe(5000);
    h.tick(15);
    expect(h.bridge.stats()).toEqual({ published: 3, minGapMs: 5000 });
  });

  it('re-reads the mode when a song starts, and never on a tick', () => {
    let reads = 0;
    const counted = harness();
    // `readMode` is counted through the store, which is the only thing the
    // bridge is allowed to ask twice a second.
    counted.tick(5);
    counted.tick(10);
    reads = counted.reads;
    counted.store('title');
    // Same song: the tick must not notice the library changed under it.
    counted.tick(20);
    expect(counted.published.at(-1)?.title).toBe('三');
    counted.set({ song: song({ id: 'b', name: '第二首' }), currentTime: 0 });
    expect(counted.reads).toBeGreaterThan(reads);
    counted.tick(5);
    expect(counted.published.at(-1)?.title).toBe('三'); // 'title' mode: no new write
  });

  it('goes back to the song name the moment the switch is turned off', () => {
    h.tick(5);
    expect(h.published.at(-1)?.title).toBe('一');
    h.bridge.setMode('title');
    expect(h.stored).toBe('title');
    expect(h.published.at(-1)).toEqual({ title: '歌名', artist: '歌手' });
    // And stays there: the mode is cached, not re-read per tick.
    for (let t = 5.5; t <= 25; t += 0.5) h.tick(t);
    expect(h.published).toHaveLength(2);
  });

  it('turns on without waiting for a tick, which a paused player never sends', () => {
    const paused = harness({ playing: false, currentTime: 10 });
    paused.bridge.setMode('title');
    paused.published.length = 0;
    paused.bridge.setMode('lyrics');
    expect(paused.published.at(-1)?.title).toBe('二');
  });

  it('resets the count when the mode changes, because the sequence did', () => {
    h.tick(5);
    h.tick(10);
    expect(h.bridge.stats().published).toBe(2);
    h.bridge.setMode('title');
    expect(h.bridge.stats()).toEqual({ published: 1, minGapMs: null });
  });

  it('never writes while nothing is playing', () => {
    const empty = harness({ song: null });
    empty.set({ currentTime: 5 });
    empty.bridge.setMode('title');
    expect(empty.published).toEqual([]);
  });

  it('trusts the library over the tap: a value it refuses reads as the default', () => {
    // `readNowPlayingMode` answers with the default for anything it does not
    // recognise, so a write that did not take must not leave this bridge
    // acting on a mode the library does not hold.
    const refusing = harness();
    refusing.refuseWrites();
    refusing.bridge.setMode('title');
    expect(refusing.bridge.mode()).toBe('lyrics');
  });

  it('follows a rename without opening a new window', () => {
    h.tick(5);
    h.set({ song: song({ name: '改过的名字' }) });
    expect(h.bridge.stats().published).toBe(1);
    h.tick(15); // the interlude now falls back to the NEW name
    expect(h.published.at(-1)).toEqual({ title: '改过的名字', artist: '歌手' });
  });

  it('reads the song offset, so the stereo and the screen show the same line', () => {
    const shifted = harness({ song: song({ lyrics_offset: 2 }) });
    shifted.tick(3.5); // 3.5 + 2 = 5.5 → past the first line
    expect(shifted.published.at(-1)?.title).toBe('一');
  });
});
