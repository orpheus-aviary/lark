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
  DEFAULT_TIMEOUTS,
  DownloadEngine,
  type DownloadTimeouts,
  FileEffectRuntime,
} from '@lark/core/portable';
import type { LlmConfig } from '@lark/shared';
import LarkTransfer from '../../modules/lark-transfer';
import type { BootResult } from '../boot/sequence';
import { libraryChanged } from '../library-signal';
import { ensureAudioSession } from '../player/session';
import { type AudioTransfer, createMobileAudioLanding } from '../ports/audio-landing';
import { createSongFiles } from '../ports/song-files';
import {
  type ForegroundController,
  type ForegroundService,
  createForegroundController,
} from './foreground';
import { attachDownloadEngine, downloads, refreshDownloads, setForegroundStatus } from './hub';

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
 * No model is configured, and this device has nowhere to read one from yet.
 *
 * The desktop reads `lark_config.toml` and falls back to aviary's shared
 * config; a phone has neither file (§1.10). The settings page and its
 * SecureStore key are N4e — until then this answers `false` to
 * `isLlmConfigured`, which is what makes the three LLM gates refuse up front
 * with "configure a model" rather than fail asynchronously halfway down a
 * download. An honest "no", in other words, and not a placeholder that will
 * quietly stay wrong once there is something to read.
 */
const NO_LLM_CONFIG: LlmConfig = { url: '', model: '', api_key: '', api_format: '' };

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
  const engine = new DownloadEngine({
    store: boot.db,
    files: boot.files,
    audio: createMobileAudioLanding({
      store: boot.db,
      ...(deps.transfer === undefined ? {} : { transfer: deps.transfer }),
    }),
    getLlmConfig: () => NO_LLM_CONFIG,
    timeouts: MOBILE_TIMEOUTS,
    // `fetchImpl` is deliberately absent: `globalThis.fetch` here is expo/fetch,
    // which N0b-3 froze and N1i re-checked against the real bilibili endpoints.
    callbacks: {
      onStatus: refreshDownloads,
      onFailed: refreshDownloads,
      onCancelled: refreshDownloads,
      onBatchesChanged: refreshDownloads,
      onSucceeded: (task) => {
        refreshDownloads();
        // A row was written by somebody with no finger on a button. This is the
        // same signal a delete emits (`library-signal.ts`), so the player
        // reconciles its queue and — once N4d gives it a screen — the song list
        // rebuilds. A lyrics task changed no song row, and says so.
        if (task.kind !== 'lyrics') libraryChanged();
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
  });

  // The quota expiring is the one thing the app does not initiate, so this is
  // the only subscription. The service has already stopped itself by the time
  // it arrives; what is left is the app's half — cancelling everything, so
  // that nothing keeps working through a permission that has been taken away.
  LarkTransfer.addListener('onTimeout', () => {
    void foreground.handleTimeout();
  });

  return {
    engine,
    foreground,
    fileOps: new FileEffectRuntime({
      sqlite: boot.db.sqlite,
      files: boot.files,
      songFiles: createSongFiles(),
      claims: engine.claims,
    }),
  };
}
