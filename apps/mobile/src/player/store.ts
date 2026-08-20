// Playback state, and the rule that decides who wins when two taps race
// (N3a; decisions b and p).
//
// NOT A REACT THING. Every dependency is injected and nothing here imports
// expo-audio, so the whole race model is testable on a laptop with a fake
// driver — which matters, because races are exactly the part that a device
// test finds once in twenty runs. `ui/player-context.tsx` is the React glue.
//
// TWO MECHANISMS, AND THEY ARE NOT THE SAME ONE:
//
//   1. **The lane** (`createOperationQueue`, shared with the desktop) makes
//      operations SERIAL. Without it a `pause` finishes while the `play` it
//      followed is still awaiting a load, and the older operation writes the
//      final state — the M4-10 bug, in a second host.
//
//   2. **The intent counter** makes the LAST TAP WIN. Serial alone is not
//      enough here: a load can take up to fifteen seconds (a broken file), and
//      a user who taps another song should not wait for that. So each `play`
//      claims an intent number the moment it is asked for — before it queues —
//      and every await races an "abandoned" signal. An abandoned operation
//      tears down ITS OWN driver and writes nothing.
//
// That second half is the one the plan review named directly: "旧加载超时后销
// 毁新 player". It cannot happen here, because an operation only ever destroys
// the driver it built.

import type { LrcLine, PlayMode, QueueDecision, QueueTrigger, SongData } from '@lark/shared';
import { createOperationQueue, decideNext, parseLrc } from '@lark/shared';
import type { PlaybackSnapshot, PlayerDriver } from './driver';
import type { PlayQueue } from './queue';

export interface PlaybackState {
  /** The song the UI is about, whether or not a native player exists for it. */
  song: SongData | null;
  /** What it is playing out of (§2.6). Frozen when playback started. */
  queue: PlayQueue | null;
  mode: PlayMode;
  /** The current song's lyrics, already parsed. Empty when it has none. */
  lyrics: readonly LrcLine[];
  /** A source is being prepared. */
  loading: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  /** Why playback stopped, when it is worth showing. Cleared by the next play. */
  error: string | null;
}

const NOTHING = {
  song: null,
  queue: null,
  lyrics: [],
  loading: false,
  playing: false,
  currentTime: 0,
  duration: 0,
  error: null,
} as const;

const IDLE: PlaybackState = { ...NOTHING, mode: 'sequential' };

export interface PlayerDeps {
  createDriver: () => PlayerDriver;
  /** `file://…/songs/<id>/song.m4a` — the paths port, already id-gated. */
  audioUri: (songId: string) => string;
  /** Configure the audio session and ask for the notification permission. */
  ensureSession: () => Promise<unknown>;
  /** The queue's songs as the library has them now (§2.6). */
  resolveQueue: (queue: PlayQueue) => readonly SongData[];
  /** LRC text, or null. Empty and unreadable both mean "no lyrics". */
  readLyrics: (songId: string) => Promise<string | null>;
  /** `local_metadata.play_mode` (decision g). */
  persistMode: (mode: PlayMode) => void;
  /** Fires whenever the library changed under us (§2.8). */
  onLibraryChanged: (listener: () => void) => () => void;
}

export interface PlayerStore {
  subscribe(listener: () => void): () => void;
  getState(): PlaybackState;
  /** Adopt the persisted mode once the library is open. Does not write back. */
  hydrate(mode: PlayMode): void;
  /** Start this song, playing out of this queue. Supersedes anything in flight. */
  play(song: SongData, queue: PlayQueue): Promise<void>;
  /** Pause if playing, resume if paused, start over if the source is gone. */
  toggle(): Promise<void>;
  seek(seconds: number): Promise<void>;
  /** The decision is returned so the caller can speak for a refusal (decision n). */
  next(): Promise<QueueDecision | null>;
  prev(): Promise<QueueDecision | null>;
  setMode(mode: PlayMode): Promise<void>;
  /** Stop and release. Also what unmounting the app does. */
  stop(): Promise<void>;
}

export function createPlayerStore(deps: PlayerDeps): PlayerStore {
  const lane = createOperationQueue();
  const listeners = new Set<() => void>();

  let state: PlaybackState = IDLE;
  let driver: PlayerDriver | null = null;
  let unsubscribeDriver: (() => void) | null = null;

  let intent = 0;
  let wake: Array<() => void> = [];

  /** Claim the newest intent and release everyone waiting on an older one. */
  const claim = (): number => {
    intent += 1;
    const waiters = wake;
    wake = [];
    for (const resolve of waiters) resolve();
    return intent;
  };

  const abandoned = (mine: number): Promise<'abandoned'> =>
    new Promise((resolve) => {
      const done = (): void => resolve('abandoned');
      if (mine !== intent) done();
      else wake.push(done);
    });

  const set = (patch: Partial<PlaybackState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  /** Release the live driver, if any. Never the one an operation just built. */
  const release = async (): Promise<void> => {
    const live = driver;
    driver = null;
    unsubscribeDriver?.();
    unsubscribeDriver = null;
    await live?.destroy();
  };

  /**
   * The song we have already advanced away from.
   *
   * `didJustFinish` is a flag on a status that arrives twice a second, not an
   * edge — without this the end of a song would ask for the next one over and
   * over until the new source replaced the old status.
   */
  let finished: string | null = null;

  const onSnapshot = (snapshot: PlaybackSnapshot): void => {
    if (snapshot.error !== null) {
      // M4-6: a media error stops playback dead. No retry, ever.
      void lane.run(async () => {
        await release();
        set({ loading: false, playing: false, error: snapshot.error });
      });
      return;
    }
    set({
      playing: snapshot.playing,
      currentTime: snapshot.currentTime,
      // A source that has not reported one yet keeps the library's number
      // rather than blinking through zero.
      duration: snapshot.duration > 0 ? snapshot.duration : state.duration,
    });
    const song = state.song;
    if (snapshot.didJustFinish && song !== null && finished !== song.id) {
      finished = song.id;
      void advance('ended');
    }
  };

  /** Stop where we are without giving up the song — what `stop` means in §2.4. */
  const pausePlayback = async (): Promise<void> => {
    await lane.run(() => {
      driver?.pause();
      set({ playing: false });
    });
  };

  const advance = async (trigger: QueueTrigger): Promise<QueueDecision | null> => {
    const queue = state.queue;
    if (queue === null) return null;
    const songs = deps.resolveQueue(queue);
    const decision = decideNext({
      songs,
      currentId: state.song?.id ?? null,
      mode: state.mode,
      trigger,
    });

    switch (decision.kind) {
      case 'play': {
        const song = songs.find((candidate) => candidate.id === decision.songId);
        if (song !== undefined) await store.play(song, queue);
        break;
      }
      case 'restart': {
        const song = state.song;
        if (song !== null) await store.play(song, queue);
        break;
      }
      case 'stop':
        await pausePlayback();
        break;
      case 'reject':
        // Nothing happens here on purpose. Whether a refusal is spoken is the
        // caller's call, not the queue's (decision n) — so it is returned.
        break;
    }
    return decision;
  };

  /**
   * The library changed under us (§2.8): the queue is a list of ids, so this
   * is where those ids meet what the library still has.
   */
  deps.onLibraryChanged(() => {
    const queue = state.queue;
    const song = state.song;
    if (queue === null || song === null) return;
    const songs = deps.resolveQueue(queue);
    const fresh = songs.find((candidate) => candidate.id === song.id);
    if (fresh === undefined) {
      // The song being played was deleted. Stopping is the honest answer;
      // sliding to a neighbour would be this app deciding what to play next
      // on the strength of somebody deleting something.
      void lane.run(async () => {
        await release();
        set({
          song: null,
          lyrics: [],
          loading: false,
          playing: false,
          currentTime: 0,
          error: null,
        });
      });
      return;
    }
    // A rename or a pin: the row on screen should say what the library says.
    if (fresh !== song) set({ song: fresh });
  });

  const store: PlayerStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getState: () => state,

    hydrate(mode) {
      set({ mode });
    },

    async play(song, queue) {
      const mine = claim();
      await lane.run(async () => {
        if (mine !== intent) return; // superseded while it waited its turn
        await release();
        if (mine !== intent) return;

        set({
          song,
          queue,
          lyrics: [],
          loading: true,
          playing: false,
          currentTime: 0,
          duration: song.duration,
          error: null,
        });
        // Fire and forget: lyrics are decoration for playback, and a song
        // whose lyrics file is unreadable still plays. The song guard is what
        // keeps a slow read from painting the previous song's words.
        void deps
          .readLyrics(song.id)
          .then((text) => {
            if (state.song?.id !== song.id) return;
            set({ lyrics: text === null ? [] : parseLrc(text) });
          })
          .catch(() => {
            if (state.song?.id === song.id) set({ lyrics: [] });
          });
        await deps.ensureSession();
        if (mine !== intent) return;

        const built = deps.createDriver();
        const meta = { title: song.name, artist: song.artist };
        try {
          const outcome = await Promise.race([
            built.load(deps.audioUri(song.id), meta).then(() => 'loaded' as const),
            abandoned(mine),
          ]);
          if (outcome === 'abandoned' || mine !== intent) {
            // Ours to clean up, and only ours — see the header.
            await built.destroy();
            return;
          }
        } catch (err) {
          if (mine !== intent) return; // the driver already released itself
          set({ loading: false, playing: false, error: message(err) });
          return;
        }

        driver = built;
        unsubscribeDriver = built.subscribe(onSnapshot);
        built.play();
        set({ loading: false, playing: true });
      });
    },

    // NEITHER `toggle` NOR `seek` CLAIMS AN INTENT, and that is the whole
    // reason the lane exists beside the counter. An intent says "this is the
    // song that should be playing"; only `play` and `stop` get to say it.
    // Making `seek` claim one would mean dragging the progress bar while a
    // source is still loading CANCELS the load — a race invented by the
    // mechanism that was supposed to prevent races.
    //
    // What they need instead is to not run in the MIDDLE of a `play`, which is
    // exactly what a serial lane is: an operation that started is never
    // interrupted, so by the time these read `driver` it is either fully built
    // or fully gone.
    async toggle() {
      // Set inside the lane, acted on outside it: `play` claims the lane, so
      // calling it from within a lane task would wait for itself forever.
      let reload: SongData | null = null;
      await lane.run(() => {
        const song = state.song;
        if (song === null) return;
        // NO `state.loading` GUARD HERE, and that is a deletion rather than an
        // omission. There was one, and a mutation proved it dead: the lane
        // means this body never runs WHILE a load is in flight, so `loading`
        // is always false by the time it is read. A branch nothing can turn
        // red is not a defence (N2g learned this on the lyrics fallbacks).
        if (driver === null) {
          // No native player: the source failed, or a restored position is
          // waiting for its first tap (N3f). Load it now.
          reload = song;
          return;
        }
        if (state.playing) {
          driver.pause();
          set({ playing: false });
        } else {
          driver.play();
          set({ playing: true });
        }
      });
      if (reload !== null && state.queue !== null) await this.play(reload, state.queue);
    },

    async seek(seconds) {
      await lane.run(() => {
        if (driver === null) return;
        const clamped = Math.max(
          0,
          state.duration > 0 ? Math.min(seconds, state.duration) : seconds,
        );
        driver.seek(clamped);
        set({ currentTime: clamped });
      });
    },

    next: () => advance('next'),
    prev: () => advance('prev'),

    async setMode(mode) {
      set({ mode });
      deps.persistMode(mode);
    },

    async stop() {
      claim();
      await lane.run(async () => {
        await release();
        state = { ...NOTHING, mode: state.mode };
        for (const listener of listeners) listener();
      });
    },
  };

  return store;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
