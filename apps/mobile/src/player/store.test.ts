// The race model (N3a). Five interleavings the plan review named, plus the
// error path, against a driver whose load resolves when the test says so.
//
// Every case here is a device bug that shows up once in twenty runs and reads
// like "sometimes the wrong song plays".

import type { PlayMode, SongData } from '@lark/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlaybackSnapshot, PlayerDriver } from './driver';
import { type PlayQueue, resolveQueue } from './queue';
import { type PlayerStore, createPlayerStore } from './store';

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
    duration: 200,
    pinned: false,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

interface FakeDriver extends PlayerDriver {
  readonly log: string[];
  readonly uri: string | null;
  finishLoad(): void;
  failLoad(message: string): void;
  emit(snapshot: Partial<PlaybackSnapshot>): void;
}

const built: FakeDriver[] = [];

function createFakeDriver(): FakeDriver {
  const log: string[] = [];
  let settle: { ok: () => void; fail: (err: Error) => void } | null = null;
  let listener: ((snapshot: PlaybackSnapshot) => void) | null = null;
  let uri: string | null = null;

  const driver: FakeDriver = {
    get log() {
      return log;
    },
    get uri() {
      return uri;
    },
    load(source) {
      uri = source;
      log.push('load');
      return new Promise<void>((resolve, reject) => {
        settle = { ok: resolve, fail: reject };
      });
    },
    play: () => void log.push('play'),
    pause: () => void log.push('pause'),
    seek: (seconds) => void log.push(`seek:${seconds}`),
    updateNowPlaying: () => void log.push('meta'),
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    destroy: async () => void log.push('destroy'),
    finishLoad: () => settle?.ok(),
    failLoad: (message) => settle?.fail(new Error(message)),
    emit: (patch) =>
      listener?.({
        playing: true,
        currentTime: 0,
        duration: 200,
        didJustFinish: false,
        error: null,
        ...patch,
      }),
  };
  built.push(driver);
  return driver;
}

let store: PlayerStore;
let sessions: number;
/** What the library holds right now — tests mutate it to delete or rename. */
let library: SongData[];
let lyrics: Record<string, string | null>;
let persisted: PlayMode[];
let libraryListeners: Array<() => void>;

/** Every case plays out of the whole library unless it says otherwise. */
const ALL: PlayQueue = { source: { kind: 'all' }, songIds: ['a', 'b', 'c'] };

const libraryChanged = (): void => {
  for (const listener of libraryListeners) listener();
};

beforeEach(() => {
  built.length = 0;
  sessions = 0;
  library = [song('a'), song('b'), song('c')];
  lyrics = {};
  persisted = [];
  libraryListeners = [];
  store = createPlayerStore({
    createDriver: createFakeDriver,
    audioUri: (id) => `file:///songs/${id}/song.m4a`,
    ensureSession: async () => {
      sessions += 1;
    },
    resolveQueue: (queue) => resolveQueue(queue, library),
    readLyrics: async (id) => lyrics[id] ?? null,
    persistMode: (mode) => persisted.push(mode),
    onLibraryChanged: (listener) => {
      libraryListeners.push(listener);
      return () => {
        libraryListeners = libraryListeners.filter((l) => l !== listener);
      };
    },
  });
});

/** Let the microtask chain the lane is built out of run to quiescence. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

describe('one song, the ordinary path', () => {
  it('shows the song while it loads, then plays it', async () => {
    const done = store.play(song('a'), ALL);
    await settle();

    expect(store.getState().song?.id).toBe('a');
    expect(store.getState().loading).toBe(true);
    expect(store.getState().playing).toBe(false);
    // The library's duration is on screen before the source reports one.
    expect(store.getState().duration).toBe(200);
    expect(built[0]?.uri).toBe('file:///songs/a/song.m4a');

    built[0]?.finishLoad();
    await done;

    expect(store.getState().loading).toBe(false);
    expect(store.getState().playing).toBe(true);
    expect(built[0]?.log).toEqual(['load', 'play']);
    expect(sessions).toBe(1);
  });

  it('takes position updates from the driver but not a zero duration', async () => {
    const done = store.play(song('a'), ALL);
    await settle();
    built[0]?.finishLoad();
    await done;

    built[0]?.emit({ currentTime: 12.5, duration: 0 });
    expect(store.getState().currentTime).toBe(12.5);
    expect(store.getState().duration).toBe(200);

    built[0]?.emit({ currentTime: 13, duration: 199.6 });
    expect(store.getState().duration).toBe(199.6);
  });
});

describe('two taps, and the load in between', () => {
  it('the second tap wins, and the first tears down only its own driver', async () => {
    const first = store.play(song('a'), ALL);
    await settle();
    const second = store.play(song('b'), ALL);
    await settle();

    // B claimed the intent, so A is abandoned WITHOUT waiting for its load —
    // which is the whole point: a broken A must not make B wait 15 seconds.
    expect(store.getState().song?.id).toBe('b');
    expect(built[0]?.log).toContain('destroy');
    expect(built[0]?.log).not.toContain('play');

    built[1]?.finishLoad();
    await second;
    // A's load resolving LATE must not touch anything: it has no driver left
    // and never had the intent.
    built[0]?.finishLoad();
    await first;
    await settle();

    expect(store.getState().song?.id).toBe('b');
    expect(store.getState().playing).toBe(true);
    expect(built[1]?.log).toEqual(['load', 'play']);
    expect(built[1]?.log).not.toContain('destroy');
  });

  it('never destroys the driver a later operation built', async () => {
    const first = store.play(song('a'), ALL);
    await settle();
    const second = store.play(song('b'), ALL);
    await settle();
    built[1]?.finishLoad();
    await second;

    // The late loser reports in after the winner is live.
    built[0]?.failLoad('too late');
    await first;
    await settle();

    expect(built[1]?.log).not.toContain('destroy');
    expect(store.getState().playing).toBe(true);
    expect(store.getState().error).toBeNull();
  });

  it('a tap that arrives while an earlier one is still queued is the one that plays', async () => {
    void store.play(song('a'), ALL);
    void store.play(song('b'), ALL);
    const third = store.play(song('c'), ALL);
    await settle();

    expect(store.getState().song?.id).toBe('c');
    built[built.length - 1]?.finishLoad();
    await third;
    expect(store.getState().playing).toBe(true);
    expect(store.getState().song?.id).toBe('c');
  });
});

describe('a source that will not play', () => {
  it('stops dead with the reason, and does not retry', async () => {
    const done = store.play(song('a'), ALL);
    await settle();
    built[0]?.failLoad('这个文件坏了');
    await done;

    expect(store.getState().loading).toBe(false);
    expect(store.getState().playing).toBe(false);
    expect(store.getState().error).toBe('这个文件坏了');
    // The song stays on screen: the UI has something to explain.
    expect(store.getState().song?.id).toBe('a');
    // One driver, one load. A retry would show up as a second of either.
    expect(built).toHaveLength(1);
    expect(built[0]?.log.filter((line) => line === 'load')).toHaveLength(1);
  });

  it('a mid-playback error releases the player and says why', async () => {
    const done = store.play(song('a'), ALL);
    await settle();
    built[0]?.finishLoad();
    await done;

    built[0]?.emit({ error: '媒体流中断', playing: false });
    await settle();

    expect(store.getState().playing).toBe(false);
    expect(store.getState().error).toBe('媒体流中断');
    expect(built[0]?.log).toContain('destroy');
  });

  it('the next play clears the previous reason', async () => {
    const failed = store.play(song('a'), ALL);
    await settle();
    built[0]?.failLoad('坏了');
    await failed;

    const done = store.play(song('b'), ALL);
    await settle();
    expect(store.getState().error).toBeNull();
    built[1]?.finishLoad();
    await done;
  });
});

describe('transport', () => {
  const start = async (): Promise<void> => {
    const done = store.play(song('a'), ALL);
    await settle();
    built[0]?.finishLoad();
    await done;
  };

  it('toggles between pause and resume', async () => {
    await start();
    await store.toggle();
    expect(store.getState().playing).toBe(false);
    await store.toggle();
    expect(store.getState().playing).toBe(true);
    expect(built[0]?.log).toEqual(['load', 'play', 'pause', 'play']);
  });

  it('toggling a song with no live player loads it again', async () => {
    const failed = store.play(song('a'), ALL);
    await settle();
    built[0]?.failLoad('坏了');
    await failed;

    const again = store.toggle();
    await settle();
    built[1]?.finishLoad();
    await again;

    expect(built).toHaveLength(2);
    expect(store.getState().playing).toBe(true);
  });

  it('a tap during a load is queued, not dropped', async () => {
    // Without the lane this tap reads `loading` and returns, and the pause the
    // user asked for never happens — the song plays on. This is the case that
    // makes the lane load bearing beside the intent counter: removing it does
    // NOT break the two-taps cases (the counter covers those), it breaks this
    // one.
    const play = store.play(song('a'), ALL);
    await settle();
    const tapped = store.toggle();
    await settle();
    built[0]?.finishLoad();
    await Promise.all([play, tapped]);

    expect(store.getState().playing).toBe(false);
    expect(built[0]?.log).toEqual(['load', 'play', 'pause']);
    // And exactly one load: a second tap must not start a second source.
    expect(built).toHaveLength(1);
  });

  it('seeking during a load does not cancel the load', async () => {
    // `seek` deliberately claims no intent. If it did, dragging the progress
    // bar of a song that is still loading would abandon it.
    const play = store.play(song('a'), ALL);
    await settle();
    // NOT awaited here: the lane is busy with the load, so awaiting it inside
    // the test would be the test deadlocking itself — which is also the
    // evidence that a seek waits its turn rather than barging in.
    const seeking = store.seek(30);
    built[0]?.finishLoad();
    await Promise.all([play, seeking]);

    expect(store.getState().playing).toBe(true);
    expect(store.getState().currentTime).toBe(30);
    // The load survived and the seek landed after it — in that order.
    expect(built[0]?.log).toEqual(['load', 'play', 'seek:30']);
    expect(built).toHaveLength(1);
  });

  it('clamps a seek to the source, and refuses one with nothing loaded', async () => {
    await store.seek(30);
    expect(built).toHaveLength(0);

    await start();
    await store.seek(-5);
    await store.seek(9_999);
    expect(built[0]?.log).toContain('seek:0');
    expect(built[0]?.log).toContain('seek:200');
  });

  it('stop releases everything and goes back to nothing', async () => {
    await start();
    await store.stop();

    expect(built[0]?.log).toContain('destroy');
    expect(store.getState()).toEqual({
      song: null,
      queue: null,
      lyrics: [],
      mode: 'sequential',
      loading: false,
      playing: false,
      currentTime: 0,
      duration: 0,
      error: null,
    });
  });
});

describe('the queue, and what the library does to it', () => {
  const start = async (id: string): Promise<void> => {
    const done = store.play(song(id), ALL);
    await settle();
    built[built.length - 1]?.finishLoad();
    await done;
  };

  it('advances when a song finishes, and only once per song', async () => {
    await start('a');
    // `didJustFinish` rides a status that arrives twice a second. Two of them
    // must not ask for two songs.
    built[0]?.emit({ didJustFinish: true, playing: false });
    built[0]?.emit({ didJustFinish: true, playing: false });
    await settle();
    built[1]?.finishLoad();
    await settle();

    expect(store.getState().song?.id).toBe('b');
    expect(built).toHaveLength(2);
  });

  it('stops at the end of the list in sequential, without giving up the song', async () => {
    await start('c');
    built[0]?.emit({ didJustFinish: true, playing: false });
    await settle();

    expect(store.getState().playing).toBe(false);
    expect(store.getState().song?.id).toBe('c');
    expect(built).toHaveLength(1);
  });

  it('next and prev return the decision so the caller can speak for a refusal', async () => {
    await start('a');
    // Not awaited before the load finishes: `next` resolves only once the song
    // it decided on is playing, which is also what makes it a decision the
    // caller can act on rather than a guess.
    const forward = store.next();
    await settle();
    built[1]?.finishLoad();
    expect(await forward).toEqual({ kind: 'play', songId: 'b' });

    // A song that is no longer in the queue: the button owes an answer.
    library = [song('z')];
    const refused = await store.prev();
    expect(refused).toEqual({ kind: 'reject', reason: 'not-in-queue' });
  });

  it('reads the queue through the library, so a rename shows and a delete removes', async () => {
    await start('a');
    library = [song('a', { name: '改过的名字' }), song('b'), song('c')];
    libraryChanged();
    expect(store.getState().song?.name).toBe('改过的名字');

    // Deleting a song that is NOT the current one leaves playback alone.
    library = [song('a', { name: '改过的名字' }), song('c')];
    libraryChanged();
    expect(store.getState().song?.id).toBe('a');
    expect(store.getState().playing).toBe(true);
  });

  it('deleting the song being played stops it rather than sliding to a neighbour', async () => {
    await start('b');
    library = [song('a'), song('c')];
    libraryChanged();
    await settle();

    expect(store.getState().song).toBeNull();
    expect(store.getState().playing).toBe(false);
    expect(built[0]?.log).toContain('destroy');
    // Nothing else started: a deletion is not an instruction about what to play.
    expect(built).toHaveLength(1);
  });

  it('the queue is a snapshot: a song added to the library does not join it', async () => {
    await start('a');
    library = [...library, song('d')];
    libraryChanged();

    const decision = store.next();
    await settle();
    built[1]?.finishLoad();
    expect(await decision).toEqual({ kind: 'play', songId: 'b' });
  });
});

describe('the play mode', () => {
  it('is adopted from the library without writing back', () => {
    store.hydrate('shuffle');
    expect(store.getState().mode).toBe('shuffle');
    expect(persisted).toEqual([]);
  });

  it('is persisted when the user changes it', async () => {
    await store.setMode('repeat-one');
    expect(store.getState().mode).toBe('repeat-one');
    expect(persisted).toEqual(['repeat-one']);
  });

  it('decides what a finished song leads to', async () => {
    await store.setMode('repeat-one');
    const done = store.play(song('a'), ALL);
    await settle();
    built[0]?.finishLoad();
    await done;

    built[0]?.emit({ didJustFinish: true, playing: false });
    await settle();
    built[1]?.finishLoad();
    await settle();

    // repeat-one reloads the same song rather than moving on.
    expect(store.getState().song?.id).toBe('a');
    expect(built).toHaveLength(2);
  });

  it('survives stop — it is a preference, not playback state', async () => {
    await store.setMode('shuffle');
    const done = store.play(song('a'), ALL);
    await settle();
    built[0]?.finishLoad();
    await done;
    await store.stop();
    expect(store.getState().mode).toBe('shuffle');
  });
});

describe('lyrics', () => {
  it('are parsed for the song that is playing', async () => {
    lyrics.a = '[00:00.50]第一行\n[00:10.00]第二行';
    const done = store.play(song('a'), ALL);
    await settle();
    built[0]?.finishLoad();
    await done;
    await settle();

    expect(store.getState().lyrics).toEqual([
      { time: 0.5, text: '第一行' },
      { time: 10, text: '第二行' },
    ]);
  });

  it('a song without them is empty, not broken', async () => {
    const done = store.play(song('b'), ALL);
    await settle();
    built[0]?.finishLoad();
    await done;
    await settle();
    expect(store.getState().lyrics).toEqual([]);
  });
});

describe('pause', () => {
  it('never resumes, however often it is asked (criterion 19)', async () => {
    const done = store.play(song('a'), ALL);
    await settle();
    built[0]?.finishLoad();
    await done;
    expect(store.getState().playing).toBe(true);

    // The headphones come out — and then come out again, which is what a
    // flapping Bluetooth link looks like.
    await store.pause();
    await store.pause();

    expect(store.getState().playing).toBe(false);
    expect(store.getState().song?.id).toBe('a');
    // One `pause` on the driver per call, and no `play` after the first.
    expect(built[0]?.log.filter((entry) => entry === 'play')).toHaveLength(1);
    expect(built[0]?.log.at(-1)).toBe('pause');
  });

  it('is harmless with nothing loaded', async () => {
    await store.pause();
    expect(store.getState().playing).toBe(false);
    expect(built).toHaveLength(0);
  });
});
