// Playback state, and the rule that decides who wins when two taps race
// (N3a; decisions b and p).
//
// NOT A REACT THING. Every dependency is injected and the only expo-audio
// import is a type, which the compiler erases — so the whole race model is
// testable on a laptop with a fake driver, which matters, because races are
// exactly the part that a device test finds once in twenty runs.
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

import type { LastPlayback } from '@lark/core/portable';
import type { LrcLine, PlayMode, QueueDecision, QueueTrigger, SongData } from '@lark/shared';
import { createOperationQueue, decideNext, parseLrc } from '@lark/shared';
import type { AudioMetadata } from 'expo-audio';
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
  /** `local_metadata.last_playback` (N3f, decision i). */
  rememberPlayback: (value: LastPlayback) => void;
  /** Fires whenever the library changed under us (§2.8). */
  onLibraryChanged: (listener: () => void) => () => void;
}

export interface PlayerStore {
  subscribe(listener: () => void): () => void;
  getState(): PlaybackState;
  /** Adopt the persisted mode once the library is open. Does not write back. */
  hydrate(mode: PlayMode): void;
  /**
   * Adopt a remembered position without creating anything (N3f, criterion 22).
   *
   * The whole point is what it does NOT do: no player, no audio session, no
   * focus request, no media notification. The launch path already carries the
   * identity gate and the migration, and a feature this convenient does not
   * get to add a decode to it. The first tap is what loads the source, and it
   * resumes from here because `currentTime` IS the remembered position.
   */
  restore(song: SongData, queue: PlayQueue, positionSeconds: number): void;
  /**
   * Write down where we are, if there is anywhere to write down.
   *
   * Called at the three turning points — pausing, changing songs, going to the
   * background — plus a coarse beat riding on the status stream. There is no
   * timer of its own anywhere in this: waking the CPU to record a position is
   * not something this feature has earned.
   */
  remember(): void;
  /** Start this song, playing out of this queue. Supersedes anything in flight. */
  play(song: SongData, queue: PlayQueue, startAtSeconds?: number): Promise<void>;
  /** Pause if playing, resume if paused, start over if the source is gone. */
  toggle(): Promise<void>;
  /**
   * Stop where we are, and only ever that (N3e, criterion 19).
   *
   * Separate from `toggle` because the caller that needs it — the headphones
   * coming out — must not be able to START playback. A `toggle` on a paused
   * player resumes it, which for that caller would mean unplugging your
   * headphones turns the music ON.
   */
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  /** The decision is returned so the caller can speak for a refusal (decision n). */
  next(): Promise<QueueDecision | null>;
  prev(): Promise<QueueDecision | null>;
  setMode(mode: PlayMode): Promise<void>;
  /**
   * Replace the lock screen metadata of whatever is loaded (N3d).
   *
   * Synchronous and OUTSIDE the lane, unlike everything else here. It is not
   * an operation — it changes no playback state and takes no decision — and
   * queueing it behind a fifteen-second load would mean the stereo showing a
   * lyric from the previous song for as long as that load takes. Reading
   * `driver` is safe from anywhere because `release()` nulls it before it
   * destroys anything, so this either reaches the live source or nothing.
   */
  publishNowPlaying(meta: AudioMetadata): void;
  /**
   * Give up the song, the queue and the source.
   *
   * One caller: the song being played was deleted from the library. It is NOT
   * what leaving the app does — nothing unmounts, and the process going away
   * is what ends playback there (measured: swiping lark out of recents leaves
   * zero active players).
   */
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

  /** §2.7's coarse beat: which whole minute the last write belonged to. */
  const REMEMBER_EVERY_SECONDS = 60;
  let rememberedMinute: number | null = null;

  const remember = (): void => {
    const song = state.song;
    const queue = state.queue;
    if (song === null || queue === null) return;
    rememberedMinute = Math.floor(state.currentTime / REMEMBER_EVERY_SECONDS);
    deps.rememberPlayback({
      songId: song.id,
      positionSeconds: state.currentTime,
      queue: queue.source,
    });
  };

  /**
   * Lyrics for a song, fetched without anyone waiting.
   *
   * Fire and forget: they are decoration for playback, and a song whose lyrics
   * file is unreadable still plays. The song guard is what keeps a slow read
   * from painting the previous song's words.
   */
  const loadLyrics = (song: SongData): void => {
    void deps
      .readLyrics(song.id)
      .then((text) => {
        if (state.song?.id !== song.id) return;
        set({ lyrics: text === null ? [] : parseLrc(text) });
      })
      .catch(() => {
        if (state.song?.id === song.id) set({ lyrics: [] });
      });
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
    // The coarse beat, riding on a tick that was going to happen anyway. With
    // the screen off these arrive as rarely as the system lets them, which is
    // exactly why §2.7 promises "where JS last looked" and not a number.
    if (Math.floor(state.currentTime / REMEMBER_EVERY_SECONDS) !== rememberedMinute) remember();
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
      remember();
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
      // on the strength of somebody deleting something. `stop` and not a
      // hand-rolled teardown: this used to be a near-copy of it, differing
      // only in leaving `queue` behind — a queue belonging to a song that no
      // longer exists.
      void store.stop();
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

    restore(song, queue, positionSeconds) {
      set({
        song,
        queue,
        lyrics: [],
        loading: false,
        playing: false,
        currentTime: positionSeconds,
        duration: song.duration,
        error: null,
      });
      rememberedMinute = Math.floor(positionSeconds / REMEMBER_EVERY_SECONDS);
      // Worth the file read: the mini bar shows the line for the position it
      // is displaying, and an empty lyric row over a progress bar sitting at
      // 2:03 reads as broken rather than as paused.
      loadLyrics(song);
    },

    remember,

    async play(song, queue, startAtSeconds = 0) {
      const mine = claim();
      await lane.run(async () => {
        if (mine !== intent) return; // superseded while it waited its turn
        // The song being left behind, written down before it is let go. Its
        // position is where the user stopped hearing it, which is the only
        // moment that number exists.
        remember();
        await release();
        if (mine !== intent) return;

        set({
          song,
          queue,
          lyrics: [],
          loading: true,
          playing: false,
          currentTime: startAtSeconds,
          duration: song.duration,
          error: null,
        });
        rememberedMinute = Math.floor(startAtSeconds / REMEMBER_EVERY_SECONDS);
        loadLyrics(song);
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
        // Seek BEFORE play, so a restored position never plays a second of the
        // beginning first. Both go to the same native player and ExoPlayer
        // orders them itself.
        if (startAtSeconds > 0) built.seek(startAtSeconds);
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
      // `currentTime` IS the remembered position when nothing has loaded yet
      // (`restore`), and the position a failed load left behind otherwise.
      // Either way, resuming means resuming from there.
      if (reload !== null && state.queue !== null) {
        await this.play(reload, state.queue, state.currentTime);
      }
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

    pause: pausePlayback,

    next: () => advance('next'),
    prev: () => advance('prev'),

    async setMode(mode) {
      set({ mode });
      deps.persistMode(mode);
    },

    publishNowPlaying(meta) {
      driver?.updateNowPlaying(meta);
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
