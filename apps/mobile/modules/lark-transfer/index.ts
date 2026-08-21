// Decision e: the dataSync foreground service a download runs under.
//
// See `android/src/main/java/expo/modules/larktransfer/LarkTransferService.kt`
// for why this module exists. Four functions and one event, and none of them
// know what a download is — when to start, what the notification says and which
// tasks to cancel are all `src/downloads/foreground.ts`'s business. Same
// boundary the other three self-built modules keep.

import { NativeModule, requireNativeModule } from 'expo-modules-core';

// A `type` and not an `interface`: `EventsMap` is a `Record<string, …>`, and
// only a type alias gets the implicit index signature that satisfies it
// (`docs/LESSONS.md`, N3e).
export type LarkTransferEvents = {
  /**
   * Android took the dataSync quota back — six cumulative hours in any
   * twenty-four, from API 35.
   *
   * The service has already stopped itself by the time this arrives; ignoring
   * it is not an option, because an app that keeps working through it is
   * killed. What the app owes here is to cancel EVERYTHING, queued included: a
   * queued task would otherwise start the moment a running one is cancelled,
   * which is the work the system just forbade (subplan §2.4).
   */
  onTimeout(): void;
};

declare class LarkTransferNativeModule extends NativeModule<LarkTransferEvents> {
  /**
   * Start the service and put its notification up.
   *
   * Rejects with `ERR_LARK_FGS_NOT_ALLOWED` when the system refuses — which
   * happens when this is called from the background (Android 12+). That is a
   * degraded state, NOT a failed download: see the state machine.
   */
  start(title: string, body: string): Promise<void>;
  /** Change the text under the same notification id. No-op when not running. */
  update(title: string, body: string): Promise<void>;
  /** Idempotent — stopping something that never started is not an error. */
  stop(): Promise<void>;
  /**
   * The app's own view of it.
   *
   * `dumpsys activity services` is what a criterion asks; this is what the
   * state machine asks, because it cannot shell out.
   *
   * NOT USABLE AS AN ACKNOWLEDGEMENT OF `start()`. `startForegroundService`
   * returns as soon as the request is queued, and the flag is set by the
   * service itself in `onStartCommand` — so this can still be false
   * immediately afterwards. `start()` resolving without throwing is what
   * means "the system accepted it"; this answers "is it up right now".
   */
  isRunning(): Promise<boolean>;
}

export default requireNativeModule<LarkTransferNativeModule>('LarkTransfer');
