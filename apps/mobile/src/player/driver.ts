// The only thing in the app allowed to touch expo-audio (N3a, §2.2).
//
// ONE DRIVER PER SONG. Changing songs destroys this one and builds another —
// §2.3's frozen sequence — rather than calling `replace()`, because the
// pause-then-release order below is the only teardown the spike measured and a
// reused player would have to be trusted to forget the old source cleanly.
//
// TWO THINGS THIS FACE IS SHAPED AROUND:
//
//   1. **There is no `remove()` on it.** expo/expo#47569 — releasing a playing
//      player leaves a native AudioTrack that JS can no longer reach, and only
//      `am force-stop` collects it — is NOT fixed in any released SDK 57
//      (checked against the CHANGELOG in N0b-1, confirmed on the device in
//      N0b-4b: seven seconds after release the track was still `started`). A
//      rule saying "always pause first" gets walked around by some error
//      branch eventually. A face with no `remove()` cannot be.
//
//   2. **Errors arrive as status, not as an event.** `AudioEvents` really does
//      have only `playbackStatusUpdate` and `audioSampleUpdate`
//      (`AudioModule.types.d.ts:220-225`) — but `AudioStatus` carries
//      `error: string | null` (`Audio.types.d.ts:243`), which Android fills
//      from `onPlayerError` (`AudioPlayer.kt:158`). So a load races three
//      outcomes: loaded, errored, or neither — and only the third one is the
//      watchdog's business. An earlier draft of this plan had the watchdog
//      answering for all three, which would have made a file we KNOW is broken
//      wait fifteen seconds to say so.
//
// A media error stops playback dead and is never retried (M4-6): the spike-era
// retry loop is how an unkillable request storm gets built.
//
// 🔴 NOTHING IN HERE MAY WAIT ON A JS TIMER (0.1.1 ⑪). Both waits below are
// `nativeDelay`, and that is a correctness requirement rather than a taste:
// React Native's timers ride the Choreographer and stop when the display does,
// while this file's whole job — the teardown between one song and the next —
// runs most often with the phone in a pocket. MEASURED on the frozen device,
// 2026-08-26: the 300ms settle took 63 537ms and finished only when the screen
// was unlocked, which is exactly what「锁屏播完一首就停住」was. Everything else
// on that path was already native and arrived on time.
// `scripts/check-mobile-no-js-timers.sh` keeps it that way.

import type { QueueTrigger } from '@lark/shared';
import {
  type AudioMetadata,
  type AudioPlayer,
  type AudioStatus,
  createAudioPlayer,
} from 'expo-audio';
import { nativeDelay } from '../../modules/lark-app';
import { remoteTriggerOf } from './remote';

/** Decision m. Only for "no terminal state ever arrived". */
export const LOAD_WATCHDOG_MS = 15_000;

/** How often the native side pushes status. Also the lyrics tick (N3d). */
const STATUS_INTERVAL_MS = 500;

/** The measured teardown gap (spike `playback.ts:247-250`). */
const PAUSE_SETTLE_MS = 300;

export class PlaybackFailure extends Error {
  /** True when the native player reported it; false when we gave up waiting. */
  readonly reported: boolean;
  constructor(message: string, reported: boolean) {
    super(message);
    this.name = 'PlaybackFailure';
    this.reported = reported;
  }
}

export interface PlaybackSnapshot {
  playing: boolean;
  currentTime: number;
  duration: number;
  didJustFinish: boolean;
  error: string | null;
}

export interface PlayerDriver {
  /** Build the native player and wait for a terminal state. Call once. */
  load(uri: string, meta: AudioMetadata): Promise<void>;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  /** Synchronous (`AudioModule.types.d.ts:180`) — N3d writes lyrics here. */
  updateNowPlaying(meta: AudioMetadata): void;
  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void;
  /**
   * Somebody asked for another track from OUTSIDE the app (0.1.1 ⑬) — a car
   * stereo, a headset button, the lock screen or the notification.
   *
   * A separate subscription rather than a field on the snapshot: a snapshot is
   * what the player IS twice a second, and this is a thing that happened once.
   * Nothing has moved when it arrives — the queue belongs to the host (see
   * `patches/expo-audio@57.0.3.patch`).
   */
  onRemote(listener: (trigger: QueueTrigger) => void): () => void;
  /** pause → settle → clear lock screen → remove. The ONLY teardown. */
  destroy(): Promise<void>;
}

const snapshotOf = (status: AudioStatus): PlaybackSnapshot => ({
  playing: status.playing,
  currentTime: status.currentTime,
  duration: status.duration,
  didJustFinish: status.didJustFinish,
  error: status.error,
});

export function createPlayerDriver(): PlayerDriver {
  let player: AudioPlayer | null = null;
  let destroyed = false;
  const listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  const remoteListeners = new Set<(trigger: QueueTrigger) => void>();

  const emit = (status: AudioStatus): void => {
    const snapshot = snapshotOf(status);
    for (const listener of listeners) listener(snapshot);
  };

  // A named function rather than `this.destroy` — a face that only works while
  // nobody destructures it is a face with a trap in it.
  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    listeners.clear();
    remoteListeners.clear();
    const live = player;
    player = null;
    if (live === null) return;
    // The supported order, measured: pause, let it settle, clear the lock
    // screen, THEN release (spike `playback.ts:247-250,507-510`).
    live.pause();
    await nativeDelay(PAUSE_SETTLE_MS);
    live.clearLockScreenControls();
    live.remove();
  };

  return {
    async load(uri, meta) {
      if (player !== null) throw new Error('this driver already loaded a source');
      const created = createAudioPlayer(
        { uri, name: meta.title },
        {
          updateInterval: STATUS_INTERVAL_MS,
        },
      );
      player = created;

      try {
        await new Promise<void>((resolve, reject) => {
          // Subscribe BEFORE checking the current status: a source that is
          // already loaded (or already broken) would otherwise resolve nothing.
          const subscription = created.addListener('playbackStatusUpdate', (status) => {
            emit(status);
            settle(status);
          });
          // A native wait, so a load that hangs behind a locked screen still
          // gives up — a frozen watchdog is a watchdog that answers only once
          // somebody looks at the phone. It cannot be cancelled and does not
          // need to be: `finish` is idempotent, so a late one is a no-op that
          // costs a resolved promise.
          void nativeDelay(LOAD_WATCHDOG_MS).then(
            () => {
              finish(() =>
                reject(
                  new PlaybackFailure(`播放器等了 ${LOAD_WATCHDOG_MS / 1000} 秒也没有回应`, false),
                ),
              );
            },
            // The rejection arm is not paranoia. Without it a native module
            // that did not expose `delay` — an autolink that skipped, the
            // failure mode `check-mobile-native-modules.sh` exists for —
            // would produce an unhandled rejection and a load with NO
            // watchdog: a missing defence, which is the class of bug this
            // repo keeps meeting (`docs/LESSONS.md`, 「缺失不是错误」). Failing
            // the load says it out loud, on the first song, in words.
            (err: unknown) => {
              finish(() =>
                reject(new PlaybackFailure(`播放器的等待没能建立：${String(err)}`, false)),
              );
            },
          );

          let done = false;
          function finish(act: () => void): void {
            if (done) return;
            done = true;
            subscription.remove();
            act();
          }
          function settle(status: AudioStatus): void {
            // Errors first: a source can report one without ever loading, and
            // "it failed" outranks "it is ready" when both are somehow true.
            const reported = status.error;
            if (reported !== null) {
              finish(() => reject(new PlaybackFailure(reported, true)));
              return;
            }
            if (status.isLoaded) finish(resolve);
          }
          settle(created.currentStatus);
        });
      } catch (err) {
        // The caller gets one job on failure — none. This driver is already
        // past saving, so it takes itself down the supported way.
        await destroy();
        throw err;
      }

      if (destroyed) return; // superseded while loading; nothing to activate
      // Background playback needs this, not just `shouldPlayInBackground`
      // (session.ts). Setting it after the load keeps a failed source out of
      // the lock screen entirely.
      //
      // All four buttons. ±10s is still the only SEEKING the lock screen
      // offers — a scrub bar belongs to the system-UI media widget, which the
      // frozen device does not draw — and since 0.1.1 ⑬ the patch adds track
      // navigation, which is what a car stereo and a headset button reach for.
      // ASKING IS WHAT PUTS IT IN THE CHAIN: without these two flags the
      // session player reports no next and no previous, exactly as upstream
      // (see `patches/expo-audio@57.0.3.patch`).
      created.setActiveForLockScreen(true, meta, {
        showSeekBackward: true,
        showSeekForward: true,
        showPrevious: true,
        showNext: true,
      });
      // Attached here rather than at construction: the lock screen is what
      // sends these, and it only exists from this line on.
      created.addListener('remoteCommand', (event) => {
        const trigger = remoteTriggerOf(event);
        if (trigger === null) return;
        for (const listener of remoteListeners) listener(trigger);
      });
      // From here the status stream belongs to subscribers rather than to the
      // load, so re-attach it for the lifetime of the player.
      created.addListener('playbackStatusUpdate', emit);
    },

    play() {
      player?.play();
    },
    pause() {
      player?.pause();
    },
    seek(seconds) {
      void player?.seekTo(Math.max(0, seconds));
    },
    updateNowPlaying(meta) {
      player?.updateLockScreenMetadata(meta);
    },

    onRemote(listener) {
      remoteListeners.add(listener);
      return () => {
        remoteListeners.delete(listener);
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    destroy,
  };
}
