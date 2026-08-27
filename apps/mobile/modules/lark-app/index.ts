// The app process, as JS can reach it: end it, or wait inside it.
//
// See `android/src/main/java/expo/modules/larkapp/LarkAppModule.kt` for why a
// native module is the only thing that does this: `BackHandler.exitApp()`
// finishes the Activity and leaves the JS runtime — `bootOnce`, the workspace
// cache, expo-sqlite's handles — exactly where it was.
//
// `delay` joined in 0.1.1 ⑪ and is here for the mirror-image reason: JS timers
// ride the Choreographer and stop with the display, so the only wait that
// still happens under a locked screen is one the platform is holding. Measured
// there: a 300ms `setTimeout` in the player's teardown took 63.5 SECONDS,
// which is what「锁屏播完一首就停住」was.
//
// Neither knows anything about workspaces or about playback. When to call them
// is `ui/workspaces-section.tsx`'s and `player/driver.ts`'s business, the same
// boundary the other four self-built modules keep.

import { NativeModule, requireNativeModule } from 'expo-modules-core';

declare class LarkAppNativeModule extends NativeModule {
  /**
   * Close the app: the task card goes, then the process.
   *
   * 🔴 IT NEVER RESOLVES — the heap holding the promise is gone. Put nothing
   * after the `await`, and make sure whatever had to be written is already on
   * disk when this is called.
   */
  quit(): Promise<void>;
  /** Resolve `ms` from now, on the platform's clock rather than on JS's. */
  delay(ms: number): Promise<void>;
}

const native = requireNativeModule<LarkAppNativeModule>('LarkApp');

/** Close the app. Does not return. */
export async function quitApp(): Promise<void> {
  await native.quit();
}

/**
 * Wait `ms`, even with the screen off.
 *
 * 🔴 USE THIS AND NOT `setTimeout` ON ANY PATH THAT HAS TO RUN WHILE THE PHONE
 * IS LOCKED. `scripts/check-mobile-no-js-timers.sh` holds the line for
 * `src/player/`; everywhere else it is a judgement call, and the question to
 * ask is the one N4f-2 asked: what is this wait defending against, and is that
 * still true behind a dark screen?
 *
 * Not cancellable. A late resolve has to be harmless to the caller.
 */
export function nativeDelay(ms: number): Promise<void> {
  return native.delay(ms);
}
