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

import type { SongData } from '@lark/shared';
import { createOperationQueue } from '@lark/shared';
import type { PlaybackSnapshot, PlayerDriver } from './driver';

export interface PlaybackState {
  /** The song the UI is about, whether or not a native player exists for it. */
  song: SongData | null;
  /** A source is being prepared. */
  loading: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  /** Why playback stopped, when it is worth showing. Cleared by the next play. */
  error: string | null;
}

const IDLE: PlaybackState = {
  song: null,
  loading: false,
  playing: false,
  currentTime: 0,
  duration: 0,
  error: null,
};

export interface PlayerDeps {
  createDriver: () => PlayerDriver;
  /** `file://…/songs/<id>/song.m4a` — the paths port, already id-gated. */
  audioUri: (songId: string) => string;
  /** Configure the audio session and ask for the notification permission. */
  ensureSession: () => Promise<unknown>;
}

export interface PlayerStore {
  subscribe(listener: () => void): () => void;
  getState(): PlaybackState;
  /** Start this song. Supersedes anything in flight. */
  play(song: SongData): Promise<void>;
  /** Pause if playing, resume if paused, start over if the source is gone. */
  toggle(): Promise<void>;
  seek(seconds: number): Promise<void>;
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
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getState: () => state,

    async play(song) {
      const mine = claim();
      await lane.run(async () => {
        if (mine !== intent) return; // superseded while it waited its turn
        await release();
        if (mine !== intent) return;

        set({
          song,
          loading: true,
          playing: false,
          currentTime: 0,
          duration: song.duration,
          error: null,
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
      if (reload !== null) await this.play(reload);
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

    async stop() {
      claim();
      await lane.run(async () => {
        await release();
        state = IDLE;
        for (const listener of listeners) listener();
      });
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
