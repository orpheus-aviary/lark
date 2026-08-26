// Ending this process, so the next launch can open a different library (N7g-2).
//
// See `android/src/main/java/expo/modules/larkapp/LarkAppModule.kt` for why a
// native module is the only thing that does this: `BackHandler.exitApp()`
// finishes the Activity and leaves the JS runtime — `bootOnce`, the workspace
// cache, expo-sqlite's handles — exactly where it was.
//
// One function, and it knows nothing about workspaces. When to call it is
// `ui/workspaces-section.tsx`'s and `ui/sync-section.tsx`'s business, the same
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
}

const native = requireNativeModule<LarkAppNativeModule>('LarkApp');

/** Close the app. Does not return. */
export async function quitApp(): Promise<void> {
  await native.quit();
}
