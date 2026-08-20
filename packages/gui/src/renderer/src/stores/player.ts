// Playback state and every operation that changes it.
//
// The renderer owns the player; the daemon only mirrors what it is told and
// relays commands to it (R11). So this store is where the M4-10 disciplines
// live: one serial queue for local and remote operations alike, a
// single-flight reporter, and an INTENT that a media error may never rewrite
// (M4-8 needs it to know whether to resume after a daemon restart).
//
// Every operation body lives in `ops`, which runs INSIDE an already-claimed
// queue slot. The public actions are the same bodies wrapped in a queue slot
// of their own — remote commands (player/remote.ts) claim their slot first,
// with a deadline, and then call `ops` directly.

import type {
  LrcLine,
  PlayMode,
  PlayerStatusData,
  SongData,
  UpdateSongRequest,
} from '@lark/shared';
import {
  API_PATHS,
  ApiError,
  DISCARDED,
  type OperationContext,
  apiPath,
  createOperationQueue,
  parseLrc,
  request,
  requestText,
  sortSongs,
} from '@lark/shared';
import { toast } from 'sonner';
import { create } from 'zustand';
import { errorMessage } from '../lib/errors.js';
import { createLane } from '../lib/lanes.js';
import { readPref, writePref } from '../lib/prefs.js';
import { type MediaElement, mediaUrl } from '../player/media.js';
import {
  invalidatePending,
  pendingGeneration,
  requestPendingPlay,
  setPendingPlayHandler,
} from '../player/pending.js';
import { runRecovery } from '../player/recovery.js';
import { createReporter } from '../player/reporter.js';
import { useLibrary } from './library.js';
import { useSession } from './session.js';
import { useViewPrefs } from './view-prefs.js';

/**
 * The Go cycle order, deliberately its own constant: shared's `PLAY_MODES`
 * lists `repeat-one` second because that is the wire order, and iterating it
 * as a UI cycle would quietly reorder the button (M4-10).
 */
export const UI_PLAY_MODE_CYCLE = [
  'sequential',
  'repeat-all',
  'repeat-one',
  'shuffle',
] as const satisfies readonly PlayMode[];

export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  sequential: '顺序播放',
  'repeat-all': '列表循环',
  'repeat-one': '单曲循环',
  shuffle: '随机播放',
};

export const SEEK_STEP_SECONDS = 5;
const MODE_PREF_KEY = 'player.mode';
const PREF_VERSION = 1;

/** What an operation reports back — the body of a `POST /player/ack` (§4.3). */
export interface CommandResult {
  ok: boolean;
  message?: string;
}

const SUPERSEDED: CommandResult = { ok: false, message: 'superseded' };

/** Shared by local UI actions and remote commands — last intent wins (M4-10). */
export const playerQueue = createOperationQueue();

const lyricsLane = createLane();

/** The live media element, handed over by PlayerHost on every remount. */
let element: MediaElement | null = null;

const reporter = createReporter({
  send: (snapshot, signal) => request('POST', API_PATHS.playerReport, snapshot, { signal }),
  // log-hygiene: console-ok — renderer diagnostics, never a secret.
  warn: (message) => console.warn('[player]', message),
});

function parseMode(value: unknown): PlayMode | null {
  return UI_PLAY_MODE_CYCLE.find((mode) => mode === value) ?? null;
}

/** The list in the order the user SEES it — next/prev follow the view (D11). */
function orderedSongs(): readonly SongData[] {
  return sortSongs(useLibrary.getState().songs, useViewPrefs.getState().sort);
}

export interface PlayOptions {
  /**
   * An explicit "play this one" (a double click, the row's play button, a
   * remote `play`). Only these download a missing file (M5-9): auto-advance
   * and next/prev keep the M4 behaviour, or one fileless stretch of a playlist
   * would trigger a cascade of downloads.
   */
  ensureFile?: boolean;
}

/** Operation bodies. Each one assumes it already holds the queue slot. */
export interface PlayerOps {
  play: (song: SongData, ctx: OperationContext, options?: PlayOptions) => Promise<CommandResult>;
  pause: () => Promise<CommandResult>;
  resume: (ctx: OperationContext) => Promise<CommandResult>;
  seek: (position: number) => Promise<CommandResult>;
  next: (ctx: OperationContext) => Promise<CommandResult>;
  prev: (ctx: OperationContext) => Promise<CommandResult>;
  setMode: (mode: PlayMode) => Promise<CommandResult>;
}

interface PlayerState {
  currentSong: SongData | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playMode: PlayMode;
  lyrics: readonly LrcLine[];
  /** Playback stopped by a media error; cleared by the next successful play. */
  mediaError: boolean;
  /** True while the generation recovery state machine owns the element. */
  recovering: boolean;
  /**
   * The last INTENT — what the user or a command asked for. A media error sets
   * `isPlaying` false without touching this, which is what lets recovery know
   * the session was playing when the daemon went away (M4-8).
   */
  intentPlaying: boolean;
  /** Queue-slot-free operation bodies, for callers that hold a slot already. */
  ops: PlayerOps;

  attachAudio: (audio: MediaElement) => void;
  detachAudio: (lastPosition: number) => void;

  play: (song: SongData) => Promise<CommandResult>;
  /** Play a song a pending intent just finished downloading (M5-9). */
  playPending: (song: SongData, expectedGeneration: number) => Promise<CommandResult>;
  pause: () => Promise<CommandResult>;
  resume: () => Promise<CommandResult>;
  togglePlay: () => Promise<CommandResult>;
  seek: (position: number) => Promise<CommandResult>;
  seekBy: (delta: number) => Promise<CommandResult>;
  next: () => Promise<CommandResult>;
  prev: () => Promise<CommandResult>;
  setMode: (mode: PlayMode) => Promise<CommandResult>;
  cycleMode: () => Promise<CommandResult>;

  handleEnded: () => void;
  handleMediaError: () => void;
  setTime: (currentTime: number) => void;
  setDuration: (duration: number) => void;
  setPlaying: (isPlaying: boolean) => void;

  refreshLyrics: () => void;
  adjustLyricsOffset: (delta: number) => Promise<void>;
  /** §4.4: the song may have been edited or deleted by anyone. */
  reconcileCurrentSong: () => Promise<void>;
  recoverForGeneration: (generation: number) => Promise<void>;
  reportNow: () => void;
}

export const usePlayer = create<PlayerState>((set, get) => {
  /** Claim a queue slot for a local operation (never deadline-limited). */
  const runLocal = async (
    task: (ctx: OperationContext) => Promise<CommandResult>,
  ): Promise<CommandResult> => {
    const result = await playerQueue.run(task);
    return result === DISCARDED ? SUPERSEDED : result;
  };

  const indexOfCurrent = (): number => {
    const song = get().currentSong;
    if (!song) return -1;
    return orderedSongs().findIndex((s) => s.id === song.id);
  };

  const stopAndClear = (): void => {
    element?.pause();
    // State is cleared BEFORE the src, which is what makes the media error
    // that follows a no-op: an error with no current song is teardown noise.
    set({
      currentSong: null,
      lyrics: [],
      isPlaying: false,
      intentPlaying: false,
      currentTime: 0,
      duration: 0,
      mediaError: false,
    });
    if (element) {
      element.removeAttribute('src');
      element.load();
    }
    get().reportNow();
  };

  const ops: PlayerOps = {
    play: async (song, ctx, options = {}) => {
      if (song.has_file === false) {
        if (options.ensureFile !== true) return { ok: false, message: '这一首没有文件' };
        // D16 flipped (M5-9): a missing file starts a download and plays when
        // it lands, instead of refusing the click.
        return await requestPendingPlay(song);
      }
      const audio = element;
      if (!audio) return { ok: false, message: '播放器未就绪' };

      set({
        currentSong: song,
        currentTime: 0,
        duration: song.duration > 0 ? song.duration : 0,
        lyrics: [],
        mediaError: false,
        intentPlaying: true,
      });
      audio.src = mediaUrl(song.id);
      get().refreshLyrics();

      try {
        await audio.play();
      } catch (err) {
        if (!ctx.isCurrent()) return SUPERSEDED;
        set({ isPlaying: false, intentPlaying: false });
        get().reportNow();
        return { ok: false, message: errorMessage(err) };
      }
      if (!ctx.isCurrent()) return SUPERSEDED;
      get().reportNow();
      return { ok: true };
    },

    pause: async () => {
      // Also inside the slot, not only at dispatch: a pause queued behind the
      // play that created the intent has to win over it.
      invalidatePending();
      element?.pause();
      set({ intentPlaying: false });
      get().reportNow();
      return { ok: true };
    },

    resume: async (ctx) => {
      const audio = element;
      // §4.3: resume with nothing loaded is a no-op, and a no-op is a
      // successful idempotent command.
      if (!audio || get().currentSong === null) return { ok: true };
      set({ intentPlaying: true });
      try {
        await audio.play();
      } catch (err) {
        if (!ctx.isCurrent()) return SUPERSEDED;
        set({ isPlaying: false, intentPlaying: false });
        return { ok: false, message: errorMessage(err) };
      }
      if (!ctx.isCurrent()) return SUPERSEDED;
      get().reportNow();
      return { ok: true };
    },

    seek: async (position) => {
      const audio = element;
      if (!audio) return { ok: false, message: '播放器未就绪' };
      const { duration } = get();
      // §4.3: a position past the end is clamped, not refused.
      const clamped = Math.min(Math.max(position, 0), duration > 0 ? duration : position);
      audio.currentTime = clamped;
      set({ currentTime: clamped });
      get().reportNow();
      return { ok: true };
    },

    next: async (ctx) => {
      const songs = orderedSongs();
      const index = indexOfCurrent();
      // D11: after switching lists, the song still playing may not be in the
      // new one — next/prev go quiet rather than jumping somewhere random.
      if (index < 0 || songs.length === 0) return { ok: false, message: '当前歌曲不在这个列表里' };
      if (get().playMode === 'shuffle') {
        const pick = randomOther(songs, index);
        if (!pick) return { ok: false, message: '没有其它可播放的歌曲' };
        return await ops.play(pick, ctx);
      }
      return await playAt(songs, (index + 1) % songs.length, ctx);
    },

    prev: async (ctx) => {
      const songs = orderedSongs();
      const index = indexOfCurrent();
      if (index < 0 || songs.length === 0) return { ok: false, message: '当前歌曲不在这个列表里' };
      return await playAt(songs, (index - 1 + songs.length) % songs.length, ctx);
    },

    setMode: async (mode) => {
      writePref(MODE_PREF_KEY, PREF_VERSION, mode);
      set({ playMode: mode });
      get().reportNow();
      return { ok: true };
    },
  };

  /** Go parity: a neighbour with no file stops the sequence, it is not skipped. */
  const playAt = async (
    songs: readonly SongData[],
    index: number,
    ctx: OperationContext,
  ): Promise<CommandResult> => {
    const song = songs[index];
    if (!song || song.has_file === false) return { ok: false, message: '这一首没有文件' };
    return await ops.play(song, ctx);
  };

  const randomOther = (songs: readonly SongData[], index: number): SongData | undefined => {
    const pool = songs.filter((song, i) => i !== index && song.has_file !== false);
    return pool[Math.floor(Math.random() * pool.length)];
  };

  const stopPlayback = (): void => {
    set({ isPlaying: false, intentPlaying: false });
    get().reportNow();
  };

  const restartCurrent = async (): Promise<CommandResult> => {
    const audio = element;
    if (!audio) return { ok: false, message: '播放器未就绪' };
    audio.currentTime = 0;
    try {
      await audio.play();
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
    return { ok: true };
  };

  /** What a finished song leads to, per play mode (Go parity). */
  const advanceAfterEnded = async (ctx: OperationContext): Promise<CommandResult> => {
    const { playMode } = get();
    if (playMode === 'repeat-one') return await restartCurrent();

    const songs = orderedSongs();
    const index = indexOfCurrent();
    if (index < 0 || songs.length === 0) {
      stopPlayback();
      return { ok: true };
    }
    if (playMode === 'sequential') {
      // The end of the list is the end of playback — no wrap.
      if (index >= songs.length - 1) {
        stopPlayback();
        return { ok: true };
      }
      return await playAt(songs, index + 1, ctx);
    }
    if (playMode === 'shuffle') {
      const pick = randomOther(songs, index);
      if (!pick) {
        stopPlayback();
        return { ok: true };
      }
      return await ops.play(pick, ctx);
    }
    return await playAt(songs, (index + 1) % songs.length, ctx);
  };

  return {
    currentSong: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    playMode: readPref(MODE_PREF_KEY, PREF_VERSION, parseMode, 'sequential'),
    lyrics: [],
    mediaError: false,
    recovering: false,
    intentPlaying: false,
    ops,

    attachAudio: (audio) => {
      element = audio;
    },

    detachAudio: (lastPosition) => {
      // The remount is about to destroy the element: its position is the only
      // thing recovery cannot recompute (M4-8).
      if (Number.isFinite(lastPosition) && lastPosition > 0) set({ currentTime: lastPosition });
      element = null;
    },

    // Every UI entry point funnels here, so this is where an explicit play
    // both supersedes the previous intent and asks for a missing file.
    play: (song) => {
      invalidatePending({ supersede: true });
      return runLocal((ctx) => ops.play(song, ctx, { ensureFile: true }));
    },
    playPending: (song, expectedGeneration) =>
      runLocal((ctx) => {
        // Checked INSIDE the slot: the user may have chosen another song while
        // the song fetch was in flight, and that click is already queued.
        if (pendingGeneration() !== expectedGeneration) return Promise.resolve(SUPERSEDED);
        return ops.play(song, ctx);
      }),
    pause: () => {
      invalidatePending();
      return runLocal(() => ops.pause());
    },
    resume: () => runLocal((ctx) => ops.resume(ctx)),
    togglePlay: () => (get().isPlaying ? get().pause() : get().resume()),
    seek: (position) => runLocal(() => ops.seek(position)),
    seekBy: (delta) => get().seek(get().currentTime + delta),
    next: () => {
      invalidatePending();
      return runLocal((ctx) => ops.next(ctx));
    },
    prev: () => {
      invalidatePending();
      return runLocal((ctx) => ops.prev(ctx));
    },
    setMode: (mode) => runLocal(() => ops.setMode(mode)),

    cycleMode: () => {
      const index = UI_PLAY_MODE_CYCLE.indexOf(get().playMode);
      return get().setMode(UI_PLAY_MODE_CYCLE[(index + 1) % UI_PLAY_MODE_CYCLE.length] as PlayMode);
    },

    handleEnded: () => {
      // Recovery remounts the element and reloads the source; an `ended` that
      // falls out of that is not the song finishing (M4-8 suppression).
      if (get().recovering) return;
      void runLocal((ctx) => advanceAfterEnded(ctx));
    },

    handleMediaError: () => {
      if (get().recovering) return; // recovery's own race settles this
      if (get().currentSong === null) return; // teardown noise, not a failure
      // M4-6: a media error stops the player dead. Retrying through a 401
      // storm is how the spike produced an unkillable request loop.
      set({ mediaError: true, isPlaying: false });
      toast.error('播放已停止：媒体流中断');
      get().reportNow();
    },

    setTime: (currentTime) => set({ currentTime }),
    setDuration: (duration) => set({ duration: Number.isFinite(duration) ? duration : 0 }),
    setPlaying: (isPlaying) => set({ isPlaying }),

    refreshLyrics: () => {
      const song = get().currentSong;
      if (!song) {
        set({ lyrics: [] });
        return;
      }
      // One lane plus a song guard is the frozen `lyrics:<songId>` lane in
      // practice: only one song plays at a time.
      void lyricsLane
        .run((signal) => requestText(apiPath.lyrics(song.id), { signal }))
        .then((text) => {
          if (text === null) return; // superseded
          if (get().currentSong?.id !== song.id) return;
          set({ lyrics: parseLrc(text) });
        })
        .catch(() => {
          // 404 LYRICS_NOT_FOUND is the normal "no lyrics yet" answer.
          if (get().currentSong?.id === song.id) set({ lyrics: [] });
        });
    },

    adjustLyricsOffset: async (delta) => {
      const song = get().currentSong;
      if (!song) return;
      // One decimal: the buttons move in 0.5s steps and float noise has no
      // business reaching the database.
      const lyrics_offset = Number((song.lyrics_offset + delta).toFixed(1));
      try {
        const envelope = await request<SongData>('PUT', apiPath.song(song.id), {
          lyrics_offset,
        } satisfies UpdateSongRequest);
        if (envelope.data && get().currentSong?.id === song.id) set({ currentSong: envelope.data });
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    reconcileCurrentSong: async () => {
      const song = get().currentSong;
      if (song === null) return;
      try {
        const envelope = await request<SongData>('GET', apiPath.song(song.id));
        if (envelope.data && get().currentSong?.id === song.id) {
          // §4.4: metadata may have changed under us; playback continues, and
          // the daemon's mirror gets the new name/artist.
          set({ currentSong: envelope.data });
          get().reportNow();
        }
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) return;
        if (get().currentSong?.id !== song.id) return;
        // §4.4: the song is gone. The open file stream may still be feeding
        // bytes, but reporting a ghost song is not allowed.
        stopAndClear();
        toast.info(`「${song.name}」已被删除，播放已停止`);
      }
    },

    recoverForGeneration: async (generation) => {
      const { currentSong, currentTime, intentPlaying } = get();
      const audio = element;
      if (!currentSong || !audio) return;
      const isCurrent = (): boolean => useSession.getState().daemonGeneration === generation;

      set({ recovering: true });
      const outcome = await runRecovery({
        audio,
        src: mediaUrl(currentSong.id),
        position: currentTime,
        resume: intentPlaying,
        isCurrent,
      });
      // A newer generation owns the element now; its own run settles the state.
      if (!outcome.ok && outcome.reason === 'superseded') return;
      if (!isCurrent()) return;

      if (outcome.ok) {
        set({ recovering: false, mediaError: false });
      } else {
        // The failure terminal: stop pretending, and let both the UI and the
        // daemon mirror the truth (M4-8).
        set({ recovering: false, mediaError: true, isPlaying: false });
        toast.error(`恢复播放失败：${outcome.message}`);
      }
      get().reportNow();
    },

    reportNow: () => {
      if (get().recovering) return; // suppressed until the machine settles
      const state = get();
      const song = state.currentSong;
      const snapshot: PlayerStatusData = {
        current_song: song ? { id: song.id, name: song.name, artist: song.artist } : null,
        is_playing: state.isPlaying,
        current_time: state.currentTime,
        duration: state.duration,
        play_mode: state.playMode,
        playlist_id: useLibrary.getState().playlistId,
      };
      reporter.push(snapshot);
    },
  };
});

// The pending-intent module stays store-free; this is the one wire back.
setPendingPlayHandler((song, expectedGeneration) => {
  void usePlayer.getState().playPending(song, expectedGeneration);
});
