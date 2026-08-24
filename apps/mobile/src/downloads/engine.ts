// The download engine, assembled for this phone (N4b).
//
// Wiring, and almost nothing else. The queue, the state machine, dedupe,
// claims, batches and the progress throttle are all in
// `@lark/core/portable`'s `DownloadEngine`, which the daemon builds the same
// way (`daemon/src/boot.ts`). What a host supplies is four things: where the
// audio lands, what the LLM config is, how long a transfer may take, and who
// hears about it.
//
// THE LONG-LIVED JOURNAL RUNTIME IS REBUILT HERE, and that is the point of
// doing this at boot rather than lazily. The one the boot sequence used has a
// claim registry of its own, which was right while it was the only thing in
// the process touching a song directory. It is not any more: a drain that
// removes a song's directory and a download replacing that same song's audio
// are exactly the pair `ClaimRegistry` exists to keep apart, so from here on
// the journal and the engine arbitrate through ONE registry — the engine's.
// The boot runtime has finished draining and is not used again.

import {
  type BilibiliClient,
  DEFAULT_TIMEOUTS,
  DownloadEngine,
  type DownloadTimeouts,
  FileEffectRuntime,
  createBilibiliClient,
} from '@lark/core/portable';
import { AppState } from 'react-native';
import LarkTransfer from '../../modules/lark-transfer';
import type { BootResult } from '../boot/sequence';
import { type CacheRuntime, createCacheRuntime } from '../cache/runtime';
import { libraryChanged } from '../library-signal';
import { player } from '../player';
import { ensureAudioSession } from '../player/session';
import { type AudioTransfer, createMobileAudioLanding } from '../ports/audio-landing';
import { createSongFiles } from '../ports/song-files';
import { hasLlmConfig, readLlmConfig } from '../settings/llm';
import {
  type ForegroundController,
  type ForegroundService,
  createForegroundController,
} from './foreground';
import { attachDownloadEngine, downloads, refreshDownloads, setForegroundStatus } from './hub';
import { engineLogger } from './log';

/**
 * The transfer deadline this device gets: fifteen minutes, not the desktop's
 * five (§2.2).
 *
 * Nobody pulls 50MB over a laptop's connection at 200KB/s; a phone on a train
 * does. The number is still a WHOLE-TRANSFER deadline rather than a stall
 * timer — a stall timer is the right shape and would change what the desktop
 * means by `audioStream`, which is not this batch's to change.
 */
const MOBILE_TIMEOUTS: DownloadTimeouts = {
  ...DEFAULT_TIMEOUTS,
  audioStream: 15 * 60_000,
};

/**
 * The service itself, as the controller sees it (`modules/lark-transfer`).
 *
 * A value and not an inline literal so that the acceptance seam below replaces
 * exactly this and nothing else.
 */
const nativeForegroundService: ForegroundService = {
  async start(title, body) {
    // The notification permission, asked for on the first download the way
    // it is asked for on the first play (§2.5, decision g). Reusing the
    // audio session's function rather than calling
    // `requestNotificationPermissionsAsync` directly is what keeps it to
    // ONE path — it is idempotent, and two callers of one promise is the
    // shape it was written for.
    //
    // It also configures the audio session, which looks like overreach and
    // measurably is not: `setAudioModeAsync` stores three flags and pushes
    // them to the players and recorders that already exist (none, here).
    // It does not request audio focus — that happens only when something
    // actually plays (`AudioModule.kt:312/477/501/797`) — so from this
    // path it builds no AudioTrack, takes nothing from whatever else is
    // playing, and shows nothing. Written down because it is the first
    // thing the next reader will doubt.
    await ensureAudioSession();
    await LarkTransfer.start(title, body);
  },
  update: (title, body) => LarkTransfer.update(title, body),
  stop: () => LarkTransfer.stop(),
  isRunning: () => LarkTransfer.isRunning(),
};

export interface DownloadRuntime {
  engine: DownloadEngine;
  /**
   * The bilibili client, shared with the engine rather than made twice.
   *
   * The add page's preflight needs one too (`downloads/preflight.ts`), and a
   * second client would be a second anonymous buvid and a second WBI key cache
   * — two identities for one app, refetching the same keys. The daemon has had
   * this shape since M3 (`ctx.bilibili` is the engine's client); until N4d the
   * phone had nothing outside the engine that needed to ask bilibili anything,
   * so the engine's own default was enough.
   */
  bilibili: BilibiliClient;
  /**
   * Whether the three LLM gates are open, for the screens that have to say so
   * BEFORE a submission rather than after it (§1.1).
   *
   * A function and not a boolean because the settings page changes the answer
   * inside one process (N4e-1). Nobody subscribes to it (decision d): the four
   * tabs are mounted conditionally, so settings and 添加 cannot be on screen at
   * once and switching back remounts the reader. THAT IS THE ASSUMPTION — a
   * split view, or settings as a modal over the add page, breaks it, and the
   * fix then is an external store like `downloads/hub.ts`, not a memo here.
   */
  hasLlm(): boolean;
  /**
   * The right to keep working while the screen is off (N4c).
   *
   * Built here rather than beside the screens because it is the engine's other
   * half: it exists to keep THIS process alive for THESE tasks, and a
   * controller wired to a different engine than the hub reports on would stop
   * the service on the strength of somebody else's empty queue.
   */
  foreground: ForegroundController;
  /**
   * The journal runtime everything downstream must use — `LibraryService`
   * especially, because `deleteSong` drains unconditionally. It shares the
   * engine's claims; the boot one did not.
   */
  fileOps: FileEffectRuntime;
  /**
   * Cache accounting and the one eviction scheduler (N4g).
   *
   * Built here, and here only, for the same reason the foreground controller
   * is: it is wired to THIS engine's claim registry and pending-file set, and a
   * second scheduler over the same library would run concurrent drains over the
   * same files — which is exactly what the scheduler's single-flight exists to
   * prevent.
   */
  cache: CacheRuntime;
}

let runtime: DownloadRuntime | null = null;

/**
 * The runtime this process gets, once, whatever the Activity does.
 *
 * Same shape as `bootOnce` and the player singleton, and the third time this
 * app has needed it (N2f): Android destroys and rebuilds the Activity, `App`
 * remounts, and `bootOnce` hands back the library it already opened. Building
 * a second engine on it would put two queues and two claim registries over one
 * library — the first still running its downloads, the second handed to the
 * library service that arbitrates deletes.
 */
export function downloadRuntimeOnce(boot: BootResult): DownloadRuntime {
  runtime ??= createDownloadRuntime(boot);
  return runtime;
}

export interface DownloadRuntimeDeps {
  /**
   * The audio transfer, for acceptance only (`ports/audio-landing.ts`).
   *
   * It is HERE rather than in a second assembly beside this one on purpose: a
   * scenario that built its own engine would be verifying its own wiring, and
   * the wiring — which claim registry the journal runtime got — is the thing
   * criterion 14 is about. Same reason `ports/fs.ts` puts its one seam on the
   * real factory.
   */
  transfer?: AudioTransfer;
  /**
   * The foreground service, for acceptance only (criterion 17③).
   *
   * Whether Android REFUSES to start one from the background is Android's to
   * answer and no fake can say it — the device scenario that backgrounds the
   * app asks that. What this seam buys is the other half, deterministically:
   * what the controller does with a refusal, on a build where the refusal
   * happens every time. Here for the same reason `transfer` is, and not in a
   * second assembly: the wiring is part of what is being verified.
   */
  service?: ForegroundService;
}

export function createDownloadRuntime(
  boot: BootResult,
  deps: DownloadRuntimeDeps = {},
): DownloadRuntime {
  const bilibili = createBilibiliClient({ timeouts: MOBILE_TIMEOUTS });
  // The engine's callbacks reach the cache, and the cache is built FROM the
  // engine (its claims, its pending-file set) — so one of the two has to be
  // assembled second and read through a hole. The daemon has the same knot and
  // resolves it the same way (`boot.ts`: `ctx?.cacheLeases.grant(…)`). Nothing
  // can have been enqueued before this function returns, so no callback can
  // fire while it is still null.
  let cache: CacheRuntime | null = null;
  const engine = new DownloadEngine({
    store: boot.db,
    files: boot.files,
    bilibili,
    audio: createMobileAudioLanding({
      store: boot.db,
      ...(deps.transfer === undefined ? {} : { transfer: deps.transfer }),
    }),
    // Read afresh, every task (§1.2). One Keystore round trip per download is
    // not a hot path, and the engine snapshots the answer for the task's
    // lifetime anyway — so a config saved mid-download applies to the next one,
    // which is the only behaviour that can be explained.
    getLlmConfig: () => readLlmConfig(boot.db.sqlite),
    timeouts: MOBILE_TIMEOUTS,
    // Without it the engine is NOOP_LOGGER, and "详情见日志" names a log this
    // device does not have — a release build reaches no logcat either, so an
    // INTERNAL_ERROR would be unexplainable by construction (`./log.ts`).
    logger: engineLogger,
    // `fetchImpl` is deliberately absent: `globalThis.fetch` here is expo/fetch,
    // which N0b-3 froze and N1i re-checked against the real bilibili endpoints.
    callbacks: {
      onStatus: refreshDownloads,
      onFailed: refreshDownloads,
      onCancelled: refreshDownloads,
      onBatchesChanged: refreshDownloads,
      onSucceeded: (task) => {
        refreshDownloads();
        // A lyrics task changed no song row and landed no audio: nothing below
        // is about it. Same early return as the daemon's (`boot.ts`).
        if (task.kind === 'lyrics') return;
        // A row was written by somebody with no finger on a button. This is the
        // same signal a delete emits (`library-signal.ts`), so the player
        // reconciles its queue and the song list rebuilds (N4d gave it a screen).
        libraryChanged();
        // The file was fetched so it could be PLAYED, and nothing protects it
        // yet: the play has not started, and this phone has no stream to stand
        // in for one. Sixty seconds of immunity (M5-6).
        if (task.kind === 'ensure-file' && task.result !== null) {
          cache?.leases.grant(task.result.song_id);
        }
        // A new file just landed, so the cache may be over its limit. This runs
        // inside the engine's `#finish`, past the point of no return: it must
        // not throw and must not be awaited — and the drain itself starts a
        // macrotask later, so this task's own file claim is gone before it
        // looks (M5-6).
        cache?.schedule('download-succeeded');
      },
    },
  });
  attachDownloadEngine(engine);

  const foreground = createForegroundController({
    service: deps.service ?? nativeForegroundService,
    subscribe: downloads.subscribe,
    getState: downloads.getState,
    engine,
    publish: setForegroundStatus,
    now: () => Date.now(),
    delay(ms, fn) {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    },
    // Read at the moment it is asked rather than subscribed to: the one caller
    // wants to know where the app is RIGHT NOW, and a cached answer from an
    // event that fired while the JS thread was asleep is worth less than none.
    appActive: () => AppState.currentState === 'active',
  });

  // The quota expiring is the one thing the app does not initiate, so this is
  // the only subscription. The service has already stopped itself by the time
  // it arrives; what is left is the app's half — cancelling everything, so
  // that nothing keeps working through a permission that has been taken away.
  LarkTransfer.addListener('onTimeout', () => {
    void foreground.handleTimeout();
  });

  cache = createCacheRuntime({
    db: boot.db,
    files: boot.files,
    engine,
    bilibili,
    timeouts: MOBILE_TIMEOUTS,
    currentSongId: () => player.getState().song?.id ?? null,
  });
  // Trigger one: launch (§2.2). Free on the default library — an unlimited
  // limit returns before `runEviction` scans a single directory — and the one
  // chance to notice that a limit somebody set last week is now exceeded.
  cache.schedule('boot');

  return {
    engine,
    bilibili,
    hasLlm: () => hasLlmConfig(boot.db.sqlite),
    foreground,
    cache,
    fileOps: new FileEffectRuntime({
      sqlite: boot.db.sqlite,
      files: boot.files,
      songFiles: createSongFiles(),
      claims: engine.claims,
    }),
  };
}
